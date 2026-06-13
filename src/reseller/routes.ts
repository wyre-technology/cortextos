/**
 * Fastify plugin for the MSP Admin Console (`/admin/reseller/*`).
 *
 * Implements reseller CRUD endpoints per PRD §7.1 (task reseller-tenancy#10).
 * All endpoints JSON in/out, gated by:
 *   1. `RESELLER_CONSOLE_ENABLED` feature flag (plugin-level onRequest hook)
 *   2. `requireResellerRole(minRole)` membership/role check
 *
 * Service-layer errors from `ResellerMemberService` are translated to HTTP:
 *   - INVALID_ROLE           → 400
 *   - INSUFFICIENT_PERMISSION → 403
 *   - LAST_OWNER_PROTECTION  → 409
 *   - ACTOR_NOT_FOUND        → 404
 *   - MEMBER_NOT_FOUND       → 404
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config.js";
import type { ResellerService } from "./reseller-service.js";
import { OrgHierarchyError, type OrgService } from "../org/org-service.js";
import { runAsSystem } from "../db/context.js";
import { sendInvitationEmail } from "../email/transactional.js";
import { validateEmail } from "../signup/routes.js";
import { sendLoopsEvent } from "../email/loops.js";
import {
  ResellerMemberError,
  RESELLER_ROLES,
  type ResellerMemberErrorCode,
  type ResellerMemberService,
  type ResellerRole,
} from "../org/reseller-member-service.js";
import {
  makeRequireResellerAccess,
  makeRequireResellerRole,
  makeRequireResellerOrCustomerAccess,
} from "./middleware.js";
import type { DashboardService } from "../dashboard/dashboard-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { AdminAuditService } from "../audit/admin-audit-service.js";

export interface ResellerRoutesDeps {
  resellerService: ResellerService;
  resellerMemberService: ResellerMemberService;
  orgService: OrgService;
  dashboardService: DashboardService;
  auditService: AuditService;
  /**
   * Required for the reseller-customer-create audit event (ruby RC3
   * launch-foundational gap closure 2026-06-05). The customer-org
   * provisioning was the first event in the multi-party reseller
   * lifecycle and was previously unaudited.
   */
  adminAuditService: AdminAuditService;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Match by shape rather than `instanceof` — module resets in tests cause
 * `ResellerMemberError` identity to differ between the route module and the
 * test module, so `instanceof` would incorrectly miss real errors.
 */
function isResellerMemberError(
  err: unknown,
): err is { name: string; code: ResellerMemberErrorCode; message: string } {
  if (err instanceof ResellerMemberError) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "ResellerMemberError" && typeof e.code === "string";
}

function sendResellerMemberError(
  reply: FastifyReply,
  err: { code: ResellerMemberErrorCode; message: string },
): FastifyReply {
  switch (err.code) {
    case "INVALID_ROLE":
      return reply.code(400).send({ error: err.message, code: err.code });
    case "INSUFFICIENT_PERMISSION":
      return reply.code(403).send({ error: err.message, code: err.code });
    case "LAST_OWNER_PROTECTION":
      return reply.code(409).send({ error: err.message, code: err.code });
    case "ACTOR_NOT_FOUND":
    case "MEMBER_NOT_FOUND":
      return reply.code(404).send({ error: err.message, code: err.code });
    default: {
      // Exhaustiveness guard — unknown codes fall through as 500.
      return reply.code(500).send({ error: "Internal error" });
    }
  }
}

// ---------------------------------------------------------------------------
// Body validation helpers (inline, no zod — project convention)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResellerRole(value: unknown): value is ResellerRole {
  return (
    typeof value === "string" &&
    (RESELLER_ROLES as readonly string[]).includes(value)
  );
}

interface UpdateResellerBody {
  name: string;
}

function parseUpdateResellerBody(
  body: unknown,
): UpdateResellerBody | { error: string } {
  if (!isRecord(body)) return { error: "Request body must be a JSON object" };
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "name is required and must be a non-empty string" };
  }
  if (name.length > 200) {
    return { error: "name must be 200 characters or fewer" };
  }
  return { name: name.trim() };
}

interface CreateMemberBody {
  userId: string;
  role: ResellerRole;
}

function parseCreateMemberBody(
  body: unknown,
): CreateMemberBody | { error: string } {
  if (!isRecord(body)) return { error: "Request body must be a JSON object" };
  const userId = body.userId;
  const role = body.role;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    return { error: "userId is required and must be a non-empty string" };
  }
  if (!isResellerRole(role)) {
    return { error: `role must be one of: ${RESELLER_ROLES.join(", ")}` };
  }
  return { userId, role };
}

interface CreateCustomerBody {
  name: string;
  /**
   * Email of the customer-org's eventual owner. The wizard collects this
   * at step 2; on customer-create we mint an owner-invite addressed to
   * this email. On accept, the atomic-swap transitions ownership from the
   * interim reseller_admin to the invite acceptor. Required for Layer 1.
   */
  adminEmail: string;
}

function parseCreateCustomerBody(
  body: unknown,
): CreateCustomerBody | { error: string } {
  if (!isRecord(body)) return { error: "Request body must be a JSON object" };
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "name is required and must be a non-empty string" };
  }
  if (name.length > 200) {
    return { error: "name must be 200 characters or fewer" };
  }
  // Flat-pricing: no tiers. The wizard no longer collects a plan; the
  // customer org is created on the single plan like every org (reseller
  // wholesale billing is a separate model and does not key off org.plan).

  // Layer 1: admin_email is required — the wizard step-2 helper copy
  // ("An invite is sent on create; the owner sets their own password via
  // the link") asserts the invite fires. Without it the assertion is
  // unbacked-by-build — caught pre-PR by scribe coordination + boss flag
  // (msg 1779430440810).
  const adminEmailRaw = body.admin_email;
  if (typeof adminEmailRaw !== "string" || adminEmailRaw.trim().length === 0) {
    return { error: "admin_email is required and must be a non-empty string" };
  }
  // Light shape check; normalization (lowercase+trim) happens inside
  // createInvitation via src/email/normalize.ts. Rejecting an obviously
  // malformed address surfaces the input error at the wizard layer rather
  // than minting an invite that nobody can use.
  if (!adminEmailRaw.includes("@") || adminEmailRaw.length > 320) {
    return { error: "admin_email must look like an email address" };
  }

  return { name: name.trim(), adminEmail: adminEmailRaw.trim() };
}

/**
 * Match by shape rather than `instanceof` — same module-identity gotcha as
 * isResellerMemberError above: tests reset modules, so `instanceof` would
 * miss real errors thrown from a different module instance.
 */
function isOrgHierarchyError(
  err: unknown,
): err is { name: string; code: string; message: string } {
  if (err instanceof OrgHierarchyError) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "OrgHierarchyError" && typeof e.code === "string";
}

function sendOrgHierarchyError(
  reply: FastifyReply,
  err: { code: string; message: string },
): FastifyReply {
  switch (err.code) {
    case "PARENT_NOT_FOUND":
      return reply.code(404).send({ error: err.message, code: err.code });
    case "PARENT_NOT_RESELLER":
    case "CUSTOMER_REQUIRES_PARENT":
    case "STANDALONE_CANNOT_HAVE_PARENT":
    case "RESELLER_CANNOT_HAVE_PARENT":
    case "INVALID_ORG_TYPE":
      return reply.code(400).send({ error: err.message, code: err.code });
    default:
      return reply.code(500).send({ error: "Internal error" });
  }
}

interface UpdateMemberBody {
  role: ResellerRole;
}

function parseUpdateMemberBody(
  body: unknown,
): UpdateMemberBody | { error: string } {
  if (!isRecord(body)) return { error: "Request body must be a JSON object" };
  const role = body.role;
  if (!isResellerRole(role)) {
    return { error: `role must be one of: ${RESELLER_ROLES.join(", ")}` };
  }
  return { role };
}

interface Pagination {
  page: number;
  pageSize: number;
}

function parsePagination(query: unknown): Pagination | { error: string } {
  const q = isRecord(query) ? query : {};
  const pageRaw = q.page;
  const pageSizeRaw = q.pageSize;
  let page = 1;
  let pageSize = 20;
  if (pageRaw !== undefined) {
    const n =
      typeof pageRaw === "number" ? pageRaw : parseInt(String(pageRaw), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { error: "page must be a positive integer" };
    }
    page = n;
  }
  if (pageSizeRaw !== undefined) {
    const n =
      typeof pageSizeRaw === "number"
        ? pageSizeRaw
        : parseInt(String(pageSizeRaw), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
      return { error: "pageSize must be an integer between 1 and 100" };
    }
    pageSize = n;
  }
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function resellerRoutes(deps: ResellerRoutesDeps) {
  const {
    resellerService,
    resellerMemberService,
    orgService,
    dashboardService,
    auditService,
    adminAuditService,
  } = deps;
  const requireResellerAccess = makeRequireResellerAccess(resellerService);
  const requireResellerRole = makeRequireResellerRole(resellerService);
  const requireResellerOrCustomerAccess = makeRequireResellerOrCustomerAccess(
    resellerService,
    orgService,
  )();

  return async function plugin(app: FastifyInstance): Promise<void> {
    // Feature-flag gate — keeps the entire /admin/reseller/* surface dark.
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/admin/reseller")) return;
      if (!config.features.resellerConsole) {
        reply.code(404).send({ error: "Not found" });
      }
    });

    // -----------------------------------------------------------------------
    // GET /admin/reseller/ — landing (kept from scaffold; HTML)
    // -----------------------------------------------------------------------
    app.get("/admin/reseller/", async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply);
      if (!ctx) return;
      return reply.type("text/html; charset=utf-8").send(
        `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>MSP Admin Console</title></head>
  <body>
    <h1>Hello reseller</h1>
    <p>Signed in as ${escapeForHtml(ctx.user.email)}.</p>
    <p>${ctx.memberships.length} reseller membership(s).</p>
  </body>
</html>`,
      );
    });

    // -----------------------------------------------------------------------
    // GET /admin/reseller/:resellerId — reseller profile
    // -----------------------------------------------------------------------
    app.get<{ Params: { resellerId: string } }>(
      "/admin/reseller/:resellerId",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_support_agent")(
          request,
          reply,
        );
        if (!ctx) return;

        const { resellerId } = ctx;
        const org = await orgService.getOrg(resellerId);
        if (!org || org.type !== "reseller") {
          return reply.code(404).send({ error: "Reseller not found" });
        }

        // Sequential, NOT Promise.all: each call issues a DB query on the
        // request's single reserved-tx connection — a Promise.all of two
        // such service-method calls stalls that connection (same hang class
        // as the /v1/mcp tools/call bug). Sequential awaits remove the
        // concurrency.
        const customers = await orgService.getCustomersOfReseller(resellerId);
        const members = await resellerMemberService.list(resellerId);

        return reply.send({
          id: org.id,
          name: org.name,
          type: org.type,
          customerCount: customers.length,
          memberCount: members.length,
          createdAt: org.createdAt,
        });
      },
    );

    // -----------------------------------------------------------------------
    // PATCH /admin/reseller/:resellerId — update reseller name (admin+)
    // -----------------------------------------------------------------------
    app.patch<{ Params: { resellerId: string }; Body: unknown }>(
      "/admin/reseller/:resellerId",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_admin")(request, reply);
        if (!ctx) return;

        const parsed = parseUpdateResellerBody(request.body);
        if ("error" in parsed)
          return reply.code(400).send({ error: parsed.error });

        const existing = await orgService.getOrg(ctx.resellerId);
        if (!existing || existing.type !== "reseller") {
          return reply.code(404).send({ error: "Reseller not found" });
        }

        const updated = await orgService.updateOrg(ctx.resellerId, parsed.name);
        if (!updated)
          return reply.code(404).send({ error: "Reseller not found" });

        return reply.send({
          id: updated.id,
          name: updated.name,
          type: updated.type,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        });
      },
    );

    // -----------------------------------------------------------------------
    // GET /admin/reseller/:resellerId/members — paginated member list
    // -----------------------------------------------------------------------
    app.get<{ Params: { resellerId: string }; Querystring: unknown }>(
      "/admin/reseller/:resellerId/members",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_support_agent")(
          request,
          reply,
        );
        if (!ctx) return;

        const pagination = parsePagination(request.query);
        if ("error" in pagination) {
          return reply.code(400).send({ error: pagination.error });
        }

        const all = await resellerMemberService.list(ctx.resellerId);
        const total = all.length;
        const start = (pagination.page - 1) * pagination.pageSize;
        const items = all.slice(start, start + pagination.pageSize);

        return reply.send({
          items,
          page: pagination.page,
          pageSize: pagination.pageSize,
          total,
        });
      },
    );

    // -----------------------------------------------------------------------
    // POST /admin/reseller/:resellerId/members — invite/create member
    // -----------------------------------------------------------------------
    app.post<{ Params: { resellerId: string }; Body: unknown }>(
      "/admin/reseller/:resellerId/members",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_admin")(request, reply);
        if (!ctx) return;

        const parsed = parseCreateMemberBody(request.body);
        if ("error" in parsed)
          return reply.code(400).send({ error: parsed.error });

        // Extra guard: only reseller_owner may create another reseller_owner.
        if (
          parsed.role === "reseller_owner" &&
          ctx.membership.role !== "reseller_owner"
        ) {
          return reply.code(403).send({
            error: "Only reseller_owner may create another reseller_owner",
            code: "INSUFFICIENT_PERMISSION",
          });
        }

        try {
          const member = await resellerMemberService.create(
            ctx.resellerId,
            parsed.userId,
            parsed.role,
            ctx.user.sub,
          );
          return reply.code(201).send(member);
        } catch (err) {
          if (isResellerMemberError(err))
            return sendResellerMemberError(reply, err);
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // PATCH /admin/reseller/:resellerId/members/:memberId — update role
    // -----------------------------------------------------------------------
    app.patch<{
      Params: { resellerId: string; memberId: string };
      Body: unknown;
    }>(
      "/admin/reseller/:resellerId/members/:memberId",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_admin")(request, reply);
        if (!ctx) return;

        const parsed = parseUpdateMemberBody(request.body);
        if ("error" in parsed)
          return reply.code(400).send({ error: parsed.error });

        const { memberId } = request.params;

        try {
          const updated = await resellerMemberService.updateRole(
            memberId,
            parsed.role,
            ctx.membership.id,
          );
          return reply.send(updated);
        } catch (err) {
          if (isResellerMemberError(err))
            return sendResellerMemberError(reply, err);
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // DELETE /admin/reseller/:resellerId/members/:memberId — remove member
    // -----------------------------------------------------------------------
    app.delete<{ Params: { resellerId: string; memberId: string } }>(
      "/admin/reseller/:resellerId/members/:memberId",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_admin")(request, reply);
        if (!ctx) return;

        const { memberId } = request.params;

        try {
          const removed = await resellerMemberService.delete(
            memberId,
            ctx.membership.id,
          );
          if (!removed)
            return reply.code(404).send({ error: "Member not found" });
          return reply.code(204).send();
        } catch (err) {
          if (isResellerMemberError(err))
            return sendResellerMemberError(reply, err);
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // POST /admin/reseller/:resellerId/customers — provision a new customer
    //
    // Track A customer-provisioning endpoint. A reseller_admin creates a new
    // org with type='customer' parented at :resellerId. The caller becomes
    // the customer org's owner (interim — the wizard collects an admin email
    // but invite delivery is a documented follow-up; the reseller_admin can
    // re-assign ownership once the invite flow lands alongside migration 015).
    //
    // Branding is inherited by default: no brand_profiles row is created, and
    // src/brand/resolver.ts walks up parent_org_id when one is absent. A
    // future iteration adds a thin brand_profiles row when the wizard sets
    // an accent override.
    //
    // Authorization stacks the wizard's same membership gate (reseller_admin
    // of :resellerId) with the service-layer hierarchy invariants in
    // OrgService.createOrg (parent must exist + be type='reseller').
    // -----------------------------------------------------------------------
    app.post<{ Params: { resellerId: string }; Body: unknown }>(
      "/admin/reseller/:resellerId/customers",
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_admin")(request, reply);
        if (!ctx) return;

        const parsed = parseCreateCustomerBody(request.body);
        if ("error" in parsed)
          return reply.code(400).send({ error: parsed.error });

        try {
          // Step 1: create the customer org. ctx.user.sub (reseller_admin)
          // is inserted as the interim owner via OrgService.createOrg.
          const customer = await orgService.createOrg(
            parsed.name,
            ctx.user.sub,
            "conduit",
            { type: "customer", parentOrgId: ctx.resellerId },
          );

          // Step 2: mint the owner-invite addressed to admin_email.
          // AUTHORIZATION GUARD (warden ratify Q2 msg 1779450054436):
          // ctx.user.sub IS the current owner of the customer org by
          // construction — OrgService.createOrg just inserted them as
          // owner. The structural property holds at this call site; no
          // separate getMembership check needed.
          //
          // Invitation carries intendedRole='owner' + recipientEmail.
          // On accept, invitation-service.ts performs the atomic-swap
          // (insert acceptor as owner + delete interim reseller_admin
          // from org_members). See acceptInvitation security comment.
          const { invitation, plainToken } = await orgService.createInvitation(
            customer.id,
            ctx.user.sub,
            {
              intendedRole: "owner",
              recipientEmail: parsed.adminEmail,
              maxUses: 1,
              expiresInHours: 168, // 7 days
            },
          );

          // Step 3: send the invitation email. NOTE: opts.brand is NOT
          // wired here yet — PR #219 (pearl brand-inheritance-pr-3c) is
          // still open. Per boss disposition (a) msg 1779441149007: build
          // now against current signature, add `brand: await
          // brandResolver.resolveBrand(customer.id)` as 1-line follow-up
          // when #219 merges. Expected brief CI-red post-#219-rebase per
          // his "same-branch-merge cadence" framing.
          const inviteUrl = `${config.baseUrl}/invite/${plainToken}`;
          sendInvitationEmail(request.log, {
            to: parsed.adminEmail,
            orgName: customer.name,
            inviteUrl,
            invitedByEmail: ctx.user.email ?? undefined,
          });

          // RC3 SOC2 audit-trail closure: customer-org-create is the first
          // event in the multi-party reseller lifecycle. Audited at the
          // CHILD customer-org scope so the audit_log query for that org
          // surfaces the provisioning event with the reseller-admin as
          // actorId + the parent reseller in metadata.
          void adminAuditService
            .log({
              orgId: customer.id,
              actorId: ctx.user.sub,
              targetId: ctx.resellerId,
              eventType: "customer_org_created",
              metadata: {
                parentResellerOrgId: ctx.resellerId,
                adminEmail: parsed.adminEmail,
                invitationId: invitation.id,
              },
            })
            .catch((err) => request.log.error(err, "admin audit log failed"));

          // RC1 reseller-customer-created Loops event (ruby 2026-06-05).
          // Per actor-self-confirmation-omitted-by-construction principle
          // (boss-banked 2026-06-05): notify OTHER reseller admins/owners
          // (those with standing-to-know that org-state changed without
          // their direct action), NOT the actor themselves (they have
          // agent-knowledge of their own action; UI-feedback closes the
          // self-confirmation loop). If actor is the only admin on the
          // reseller-org -> no fire by-construction.
          try {
            // 2026-06-13 launch-day fix (boss): wrap in runAsSystem. The
            // request-pool transaction has just inserted Aaron as the
            // interim-owner row of the NEW customer org (via createOrg at
            // step 1 above), but the tx hasn't committed yet (onResponse
            // settles AFTER this handler returns). Querying
            // getMembersWithProfiles on the RESELLER org from that
            // pre-commit-state request-path connection hits the same RLS
            // hang class PR #373 surfaced for the post-accept path —
            // verified live 2026-06-13 02:43Z: req-us POST /admin/reseller/
            // .../customers logged incoming with no completion. Wrapping
            // in runAsSystem so the lookup runs on the BYPASSRLS system
            // pool unblocks the Loops-event recipient resolution. The
            // resolved recipient list is then iterated for sendLoopsEvent
            // calls (fire-and-forget) AFTER the runAsSystem block — the
            // notifications fire on the same fire-and-forget shape as the
            // audit log call above, so they don't block the response.
            const resellerMembers = await runAsSystem(() =>
              orgService.getMembersWithProfiles(ctx.resellerId),
            );
            const recipients = resellerMembers.filter(
              (m) =>
                m.userId !== ctx.user.sub &&
                (m.role === "owner" || m.role === "admin") &&
                m.email,
            );
            for (const recipient of recipients) {
              sendLoopsEvent(
                recipient.email as string,
                "reseller-customer-created",
                {
                  msp_org_id: ctx.resellerId,
                  customer_org_id: customer.id,
                  customer_org_name: customer.name,
                  created_by_user_id: ctx.user.sub,
                  created_at: new Date().toISOString(),
                },
              ).catch((err) =>
                request.log.warn(
                  { err, mspOrgId: ctx.resellerId, customerOrgId: customer.id },
                  "failed to send Loops reseller-customer-created event",
                ),
              );
            }
          } catch (err) {
            request.log.warn(
              { err, mspOrgId: ctx.resellerId },
              "reseller-customer-created notify lookup failed (non-fatal)",
            );
          }

          return reply
            .code(201)
            .send({ ...customer, invitation_id: invitation.id });
        } catch (err) {
          if (isOrgHierarchyError(err)) {
            return sendOrgHierarchyError(reply, err);
          }
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // Reseller-scoped customer dashboard (Track C S2)
    //
    // The same usage payload as /api/dashboard/* but for a target customer
    // org rather than the caller's own org. Authorized by
    // requireResellerOrCustomerAccess: the caller is a reseller_member of
    // :resellerId AND :customerId's parent_org_id == :resellerId, OR the
    // caller is a direct member of :customerId. The reseller→customer
    // boundary is also enforced underneath by RLS on the request-path
    // connection (request_log_select carries the reseller-membership clause),
    // so this is defense in depth, not an app-only check.
    //
    // Unlike /api/dashboard/*, this does NOT re-apply a plan / dunning gate:
    // every /admin/reseller/* route is gated by reseller membership + the
    // RESELLER_CONSOLE_ENABLED flag, not by the target org's plan tier — a
    // reseller must see every customer they own, on any tier or billing state.
    // -----------------------------------------------------------------------
    const dashboardBase =
      "/admin/reseller/:resellerId/customers/:customerId/dashboard";

    app.get<{
      Params: { resellerId: string; customerId: string };
      Querystring: { start?: string; end?: string };
    }>(`${dashboardBase}/usage`, async (request, reply) => {
      const ctx = await requireResellerOrCustomerAccess(request, reply);
      if (!ctx) return;

      const summary = await dashboardService.getUsageSummary(ctx.customerId, {
        start: request.query.start,
        end: request.query.end,
      });
      return reply.send(summary);
    });

    app.get<{
      Params: { resellerId: string; customerId: string };
      Querystring: { start?: string; end?: string };
    }>(`${dashboardBase}/savings`, async (request, reply) => {
      const ctx = await requireResellerOrCustomerAccess(request, reply);
      if (!ctx) return;

      const savings = await dashboardService.getTokenSavings(ctx.customerId, {
        start: request.query.start,
        end: request.query.end,
      });
      return reply.send(savings);
    });

    app.get<{
      Params: { resellerId: string; customerId: string };
      Querystring: { start?: string; end?: string };
    }>(`${dashboardBase}/vendors`, async (request, reply) => {
      const ctx = await requireResellerOrCustomerAccess(request, reply);
      if (!ctx) return;

      const vendors = await dashboardService.getVendorBreakdown(
        ctx.customerId,
        {
          start: request.query.start,
          end: request.query.end,
        },
      );
      return reply.send({ vendors });
    });

    // -----------------------------------------------------------------------
    // Reseller-scoped customer audit feed (Track A — Audit Log tab)
    //
    // The customer org's MCP tool-invocation history (request_log), for the
    // per-org Audit Log tab. Same authz as the dashboard endpoints above:
    // requireResellerOrCustomerAccess verifies :customerId's parent is the
    // caller's reseller, and request_log_select RLS carries the
    // reseller-membership clause underneath — enforced twice.
    //
    // Returns the AuditRow shape the reseller-customer-tabs template renders:
    // { when (ISO), actor, action, target }. v1 surfaces tool invocations;
    // admin-event entries (admin_audit_log) are a documented follow-up.
    // -----------------------------------------------------------------------
    app.get<{
      Params: { resellerId: string; customerId: string };
    }>(
      "/admin/reseller/:resellerId/customers/:customerId/audit",
      async (request, reply) => {
        const ctx = await requireResellerOrCustomerAccess(request, reply);
        if (!ctx) return;

        const { entries } = await auditService.query({
          orgId: ctx.customerId,
          limit: 25,
        });
        const rows = entries.map((e) => ({
          when: e.createdAt,
          actor: e.userName ?? e.userEmail ?? e.userId,
          action: "mcp.tool.invoke",
          target: e.toolName ? `${e.vendorSlug} · ${e.toolName}` : e.vendorSlug,
        }));
        return reply.send({ entries: rows });
      },
    );

    // -----------------------------------------------------------------------
    // POST /admin/reseller/:resellerId/customers/:customerId/invitations
    //
    // Reseller-scoped customer-user invite. Workaround/substrate-correction
    // for the `POST /api/orgs/:orgId/invitations` hang on customer-org POSTs
    // discovered 2026-06-12 during the launch-day end-to-end verification.
    //
    // Root cause of the hang is suspected to be an RLS-policy interaction on
    // customer-org writes when invoked from the request-path connection
    // bound to a reseller_admin user-id (the user is NOT a member of the
    // customer org in org_members; the "owner" surface is derived from
    // organizations.ownerId — see reseller/routes.ts:488 customer-create
    // which inserts the reseller_admin as interim owner WITHOUT adding to
    // org_members). The /api/orgs/:orgId/invitations route gates on
    // requireOrgRole → getMembership → returns null → 403, but in practice
    // the request hangs server-side before any completion log — symptom
    // consistent with a never-returning RLS-checked query, not a fast 403.
    //
    // Architectural framing: the billing-gate at customer-org level is the
    // WRONG substrate. The reseller is the paying entity; the customer org
    // doesn't need to be on a paid plan for the reseller to invite users
    // into it. This endpoint enforces:
    //   - caller is reseller_admin of :resellerId
    //   - :customerId is a customer org whose parent_org_id == :resellerId
    // and then mints the invitation directly via orgService.createInvitation
    // (same call the customer-create flow makes — proven to work).
    //
    // Diagnostic-debt: the underlying RLS-policy hang on
    // POST /api/orgs/:customerId/invitations should be tracked as a
    // separate cortextos issue + fixed post-launch. Removing this workaround
    // once that route is healthy is a one-line modal-JS revert.
    // -----------------------------------------------------------------------
    app.post<{
      Params: { resellerId: string; customerId: string };
      Body: { email?: string };
    }>(
      "/admin/reseller/:resellerId/customers/:customerId/invitations",
      { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const ctx = await requireResellerRole("reseller_admin")(request, reply);
        if (!ctx) return;

        const { customerId } = request.params;

        // Defense-in-depth: verify the target customer org is actually
        // parented by the reseller the caller is authorized on. Same shape
        // as requireResellerOrCustomerAccess uses below for the dashboard
        // endpoints, but inlined here so reviewers can read the guard at
        // the route call-site.
        const customer = await orgService.getOrg(customerId);
        if (
          !customer ||
          customer.type !== "customer" ||
          customer.parentOrgId !== ctx.resellerId
        ) {
          return reply
            .code(404)
            .send({ error: "Customer not found under this reseller" });
        }

        // Optional invitee email. Validate same as the org-level endpoint:
        // empty/whitespace skips straight to the copy-link flow; a present-
        // but-malformed value is fast 400.
        let inviteEmail: string | undefined;
        if (request.body?.email?.trim()) {
          const v = validateEmail(request.body.email);
          if (!v.ok) return reply.code(400).send({ error: v.reason });
          inviteEmail = v.email;
        }

        const { invitation, plainToken } = await orgService.createInvitation(
          customerId,
          ctx.user.sub,
          inviteEmail ? { recipientEmail: inviteEmail } : undefined,
        );
        const inviteUrl = `${config.baseUrl}/invite/${plainToken}`;

        void adminAuditService
          .log({
            orgId: customerId,
            actorId: ctx.user.sub,
            targetId: ctx.resellerId,
            eventType: "member_invited",
            metadata: {
              invitationId: invitation.id,
              parentResellerOrgId: ctx.resellerId,
              via: "reseller-customer-invite-workaround",
            },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        if (inviteEmail) {
          try {
            sendInvitationEmail(request.log, {
              to: inviteEmail,
              orgName: customer.name,
              inviteUrl,
              invitedByEmail: ctx.user.email ?? undefined,
            });
          } catch (err) {
            request.log.warn({ err }, "invitation email prep failed");
          }
        }

        return reply
          .code(201)
          .send({ ...invitation, token: plainToken, inviteUrl });
      },
    );
  };
}

// Minimal local escaper — keeps the scaffold landing page self-contained.
function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
