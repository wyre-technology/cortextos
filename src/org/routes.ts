import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { brand } from "../brand/index.js";
import { requireAuth0 } from "../auth/auth0.js";
import type { OrgService, OrgRole } from "./org-service.js";
import { ROLE_LEVEL, isAcceptInvitationError } from "./org-service.js";
import {
  requireOrgRole,
  requireOrgRoleForWrite,
  actingAsAuditTriplet,
} from "./org-route-helpers.js";
import type { CredentialService } from "../credentials/credential-service.js";
import type { BillingGate } from "../billing/gate.js";
import { isPaidPlan } from "../billing/gate.js";
import type { AdminAuditService } from "../audit/admin-audit-service.js";
import type { OrgApiKeyService } from "./org-api-key-service.js";
import { getVendor } from "../credentials/vendor-config.js";
import {
  assembleOrgVendorHealth,
  type VendorMonitor,
} from "../monitoring/vendor-monitor.js";
import { config } from "../config.js";
import { sendLoopsEvent } from "../email/loops.js";
import {
  sendInvitationEmail,
  sendMemberRemovedEmail,
  sendRoleChangedEmail,
  sendInvitationAcceptedEmail,
  sendJoinedOrgWelcomeEmail,
  sendServerAccessGrantedEmail,
  sendServerAccessRevokedEmail,
} from "../email/transactional.js";
import { validateEmail } from "../signup/routes.js";
import { getSql, runAsSystem } from "../db/context.js";

interface OrgRouteDeps {
  orgService: OrgService;
  credentialService: CredentialService;
  billingGate: BillingGate;
  adminAuditService: AdminAuditService;
  vendorMonitor: VendorMonitor;
  /**
   * Track C reseller-settings sweep-3 substrate (June 29 launch directive
   * 2026-06-13). Headless JSON API for org API keys CRUD. Optional for
   * backward-compat with existing test fixtures + dev/test boots before
   * mig 048 lands. The HTML render layer ships as a separate PR-B after
   * the Aaron-Figma cycle per the UI-Figma-first directive
   * (msg-1781453810337).
   */
  orgApiKeyService?: OrgApiKeyService;
}

// requireOrgRole + requireOrgRoleForWrite live in org-route-helpers.ts so the
// actingAs-binding consumption (WYREAI-171 Phase-3 close, boss
// msg-1781725198971 + warden HARD-REQ 2) lands in ONE site for both this
// route file and src/org/domain-routes.ts. See the helper docstring for
// the read-vs-write substrate-discrimination + per-write revalidation
// rationale.

/** Resolve a user's email by id, or null if unknown. The users table has no
 *  RLS, so the row survives org_members removal — safe to call post-mutation. */
async function resolveUserEmail(userId: string): Promise<string | null> {
  const rows = await getSql()<{ email: string | null }[]>`
    SELECT email FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0]?.email ?? null;
}

export function orgRoutes(deps: OrgRouteDeps) {
  const {
    orgService,
    credentialService,
    billingGate,
    adminAuditService,
    vendorMonitor,
    orgApiKeyService,
  } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    // -----------------------------------------------------------------------
    // Organization CRUD
    // -----------------------------------------------------------------------

    // POST /api/orgs — create a new organization
    app.post<{ Body: { name: string; invite_code?: string } }>(
      "/api/orgs",
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { name, invite_code: inviteCode } = request.body;
        if (!name?.trim()) {
          return reply
            .code(400)
            .send({ error: "Organization name is required" });
        }

        // Check if user already owns an org
        const existingOrgs = await orgService.getUserOrgs(user.sub);
        const ownedOrg = existingOrgs.find((o) => o.ownerId === user.sub);
        if (ownedOrg) {
          return reply
            .code(409)
            .send({ error: "You already own an organization", org: ownedOrg });
        }

        // Layer 1: every standalone org is created on the conduit plan
        // with a 14-day trial (DOR §9.1). The alpha-invite-code branch
        // that used to grant `pro` and the `free` default both go to the
        // same place now — conduit-with-trial. Passing undefined lets
        // OrgService.createOrg attach getDefaultPlan().slug (= 'conduit').
        // inviteCode is still accepted on the wire for backward compat
        // but no longer changes the resulting plan.
        void inviteCode;

        const org = await orgService.createOrg(
          name.trim(),
          user.sub,
          undefined,
          { ownerEmail: user.email ?? undefined },
          request.log,
        );

        // Fire one Loops event so org-level drips can trigger without
        // starting a new contact (avoids overlap with the user-signup drip).
        if (user.email) {
          sendLoopsEvent(user.email, "org_created", {
            orgId: org.id,
            orgName: org.name,
            plan: org.plan,
          }).catch((err) =>
            app.log.warn({ err }, "failed to send Loops org_created event"),
          );
        }

        return reply.code(201).send(org);
      },
    );

    // GET /api/orgs — list user's orgs
    app.get("/api/orgs", async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const orgs = await orgService.getUserOrgs(user.sub);
      return reply.send(orgs);
    });

    // GET /api/orgs/:orgId — get org details
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "member",
        );
        if (!user) return;

        const org = await orgService.getOrg(orgId);
        if (!org) {
          return reply.code(404).send({ error: "Organization not found" });
        }

        return reply.send(org);
      },
    );

    // PATCH /api/orgs/:orgId — update org name
    app.patch<{ Params: { orgId: string }; Body: { name: string } }>(
      "/api/orgs/:orgId",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "owner",
        );
        if (!user) return;

        const { name } = request.body;
        if (!name?.trim()) {
          return reply
            .code(400)
            .send({ error: "Organization name is required" });
        }

        const org = await orgService.updateOrg(orgId, name.trim());
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "org_updated",
            metadata: { name: name.trim() },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.send(org);
      },
    );

    // POST /api/orgs/:orgId/redeem-code — redeem an invite code to upgrade to pro
    app.post<{ Params: { orgId: string }; Body: { code: string } }>(
      "/api/orgs/:orgId/redeem-code",
      { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "owner",
        );
        if (!user) return;

        const { code } = request.body;
        if (!code?.trim()) {
          return reply.code(400).send({ error: "Invite code is required" });
        }

        if (!config.alphaInviteCodes.has(code.trim())) {
          return reply.code(422).send({ error: "Invalid invite code" });
        }

        const org = await orgService.getOrg(orgId);
        if (isPaidPlan(org?.plan)) {
          return reply
            .code(409)
            .send({ error: "Organization is already on the plan" });
        }

        // Flat-pricing: one plan. (Post-flat every org resolves to the
        // single 'conduit' plan via getPlan, so isPaidPlan is effectively
        // always true and this endpoint 409s — retained for parity.)
        await orgService.updateOrgPlan(orgId, "conduit");
        return reply.send({ success: true, plan: "conduit" });
      },
    );

    // DELETE /api/orgs/:orgId — delete org
    app.delete<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "owner",
        );
        if (!user) return;

        void adminAuditService
          .log({ orgId, actorId: user.sub, eventType: "org_deleted" })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        await orgService.deleteOrg(orgId);
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Invitations
    // -----------------------------------------------------------------------

    // POST /api/orgs/:orgId/invitations — create invite link
    //
    // The optional `email` body field is additive and backward-compatible:
    // when present the invite is also emailed to that address; the response
    // still carries the copy-link, so an omitted `email` is the unchanged
    // copy-link flow.
    app.post<{ Params: { orgId: string }; Body: { email?: string } }>(
      "/api/orgs/:orgId/invitations",
      { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        // Require pro plan for team features
        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) {
          return reply
            .code(402)
            .send({ error: "Upgrade to Pro to invite team members" });
        }

        // Validate the optional invitee address BEFORE the mutation, so a
        // typo'd address is fast 400 feedback rather than a created
        // invitation whose email silently fails. An empty/whitespace-only
        // value means the field was not provided — skip straight to the
        // unchanged copy-link flow rather than 400-ing it.
        let inviteEmail: string | undefined;
        if (request.body?.email?.trim()) {
          const v = validateEmail(request.body.email);
          if (!v.ok) return reply.code(400).send({ error: v.reason });
          inviteEmail = v.email;
        }

        // Layer 1 (β) member-invite email-match extension (task_1779450095130):
        // when the create-flow has an explicit recipient address, persist it
        // on the invitation row so acceptInvitation enforces the same
        // email-match guard as the owner-invite path. Share-link invites
        // (no `email` field on the body) keep the (α) shape — null
        // recipient_email, any-authenticated-user accepts. Discipline does
        // not fork between owner-invite and member-invite paths.
        const { invitation, plainToken } = await orgService.createInvitation(
          orgId,
          user.sub,
          inviteEmail ? { recipientEmail: inviteEmail } : undefined,
        );
        const inviteUrl = `${config.baseUrl}/invite/${plainToken}`;

        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "member_invited",
            metadata: { invitationId: invitation.id },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        // Email prep + send are non-blocking: a failure here must not 500 a
        // request whose invitation was already created.
        if (inviteEmail) {
          try {
            const org = await orgService.getOrg(orgId);
            sendInvitationEmail(request.log, {
              to: inviteEmail,
              orgName: org?.name ?? "your organization",
              inviteUrl,
              invitedByEmail: user.email,
            });
          } catch (err) {
            request.log.warn({ err }, "invitation email prep failed");
          }
        }

        // The plainToken is included in the response body — this is the only
        // moment it ever exists in cleartext outside the inviter's clipboard.
        // Subsequent reads (listInvitations, getInvitationByToken) never carry
        // the plaintext.
        return reply
          .code(201)
          .send({ ...invitation, token: plainToken, inviteUrl });
      },
    );

    // GET /api/orgs/:orgId/invitations — list pending invites
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/invitations",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const invitations = await orgService.listInvitations(orgId);
        return reply.send(invitations);
      },
    );

    // DELETE /api/orgs/:orgId/invitations/:id — revoke invite
    app.delete<{ Params: { orgId: string; id: string } }>(
      "/api/orgs/:orgId/invitations/:id",
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const revoked = await orgService.revokeInvitation(id, orgId);
        if (!revoked) {
          // No row matched (id, orgId) — the invitation does not exist or
          // belongs to another org. Honest 404, not a silent 204: a 204
          // would hand a cross-tenant caller a false success signal.
          return reply.code(404).send({ error: "Invitation not found" });
        }
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: id,
            eventType: "invitation_revoked",
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Members
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/members — list members
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/members",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "member",
        );
        if (!user) return;

        const members = await orgService.getMembers(orgId);
        return reply.send(members);
      },
    );

    // DELETE /api/orgs/:orgId/members/:userId — remove member
    app.delete<{ Params: { orgId: string; userId: string } }>(
      "/api/orgs/:orgId/members/:userId",
      async (request, reply) => {
        const { orgId, userId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        // Admins cannot remove other admins — only owners can
        const actorMembership = await orgService.getMembership(orgId, user.sub);
        const targetMembership = await orgService.getMembership(orgId, userId);
        if (
          actorMembership?.role === "admin" &&
          targetMembership?.role === "admin"
        ) {
          return reply
            .code(403)
            .send({ error: "Admins cannot remove other admins" });
        }

        const removed = await orgService.removeMember(orgId, userId);
        if (!removed) {
          return reply.code(400).send({ error: "Cannot remove the org owner" });
        }
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: userId,
            eventType: "member_removed",
            metadata: { memberRole: targetMembership?.role },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        // Email prep + send are non-blocking: a failure here must not 500 a
        // request whose member removal already committed. The users row
        // survives org_members removal, so the address is still resolvable.
        try {
          const to = await resolveUserEmail(userId);
          if (to) {
            const org = await orgService.getOrg(orgId);
            sendMemberRemovedEmail(request.log, {
              to,
              orgName: org?.name ?? "an organization",
            });
          }
        } catch (err) {
          request.log.warn({ err }, "member-removed email prep failed");
        }
        return reply.code(204).send();
      },
    );

    // PATCH /api/orgs/:orgId/members/:userId/role — change member role (owner only)
    app.patch<{
      Params: { orgId: string; userId: string };
      Body: { role: string };
    }>("/api/orgs/:orgId/members/:userId/role", async (request, reply) => {
      const { orgId, userId } = request.params;
      const user = await requireOrgRoleForWrite(
        request,
        reply,
        orgService,
        orgId,
        "owner",
      );
      if (!user) return;

      const { role } = request.body;
      if (role !== "admin" && role !== "member") {
        return reply
          .code(400)
          .send({ error: 'Role must be "admin" or "member"' });
      }

      if (userId === user.sub) {
        return reply.code(400).send({ error: "Cannot change your own role" });
      }

      const targetMembership = await orgService.getMembership(orgId, userId);
      const oldRole = targetMembership?.role ?? "unknown";

      const updated = await orgService.updateMemberRole(orgId, userId, role);
      if (!updated) {
        return reply
          .code(400)
          .send({ error: "Cannot change role of the org owner" });
      }

      void adminAuditService
        .log({
          orgId,
          actorId: user.sub,
          targetId: userId,
          eventType: "role_changed",
          metadata: { oldRole, newRole: role },
        })
        .catch((err) => request.log.error(err, "admin audit log failed"));

      // Email prep + send are non-blocking: a failure here must not 500 a
      // request whose role change already committed.
      try {
        const to = await resolveUserEmail(userId);
        if (to) {
          const org = await orgService.getOrg(orgId);
          sendRoleChangedEmail(request.log, {
            to,
            orgName: org?.name ?? "an organization",
            newRole: role,
          });
        }
      } catch (err) {
        request.log.warn({ err }, "role-changed email prep failed");
      }
      return reply.send(updated);
    });

    // -----------------------------------------------------------------------
    // Vendor health
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/vendor-health — per-vendor container health for
    // the vendors this org has connected. Reads the VendorMonitor's 60s
    // server-side poll cache; it never live-checks a container on page load.
    // Current-state only — no uptime history (see
    // .taskmaster/docs/spec-observability-vendor-health.md §5.4).
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/vendor-health",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "member",
        );
        if (!user) return;

        // assembleOrgVendorHealth is the single source of truth for the
        // org-scoped raw-cache → tenant-4-state mapping — shared with the
        // /org/connections SSR page so the two renderings cannot drift.
        const slugs = await credentialService.listOrgVendors(orgId);
        const vendors = assembleOrgVendorHealth(
          slugs,
          vendorMonitor.getStatus(),
        );

        return reply.send({ vendors });
      },
    );

    // -----------------------------------------------------------------------
    // Server access control
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/server-access — list all grants (admin+)
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/server-access",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const grants = await orgService.listServerAccess(orgId);
        return reply.send(grants);
      },
    );

    // GET /api/orgs/:orgId/members/:userId/server-access — list user's vendor access (admin+ or self)
    app.get<{ Params: { orgId: string; userId: string } }>(
      "/api/orgs/:orgId/members/:userId/server-access",
      async (request, reply) => {
        const { orgId, userId } = request.params;
        const user = requireAuth0(request, reply);
        if (!user) return;

        // Allow self-access or admin+
        if (user.sub !== userId) {
          const membership = await orgService.getMembership(orgId, user.sub);
          if (
            !membership ||
            ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin
          ) {
            return reply.code(403).send({
              error: "You do not have permission to perform this action",
            });
          }
        } else {
          // Still must be a member
          const membership = await orgService.getMembership(orgId, user.sub);
          if (!membership) {
            return reply.code(403).send({
              error: "You do not have permission to perform this action",
            });
          }
        }

        const grants = await orgService.listServerAccess(orgId, userId);
        return reply.send(grants);
      },
    );

    // PUT /api/orgs/:orgId/members/:userId/server-access/:vendor — grant access (admin+)
    app.put<{ Params: { orgId: string; userId: string; vendor: string } }>(
      "/api/orgs/:orgId/members/:userId/server-access/:vendor",
      async (request, reply) => {
        const { orgId, userId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        // Verify the target user is actually a member of this org. Without
        // this check an admin can write server-access rows for arbitrary
        // user ids and emit misleading server_access_* audit entries — the
        // credential-injector refuses a non-member grant at runtime, but the
        // audit record is the lie (gateway PR #78 M10).
        const targetMembership = await orgService.getMembership(orgId, userId);
        if (!targetMembership) {
          return reply.code(404).send({
            error: "Target user is not a member of this organization",
          });
        }

        const grant = await orgService.grantServerAccess(
          orgId,
          userId,
          vendorSlug,
          user.sub,
        );
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: userId,
            eventType: "server_access_granted",
            metadata: { vendor: vendorSlug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        // SK1 (ruby SK1 launch-blocker 2026-06-05): notify the granted
        // member. Best-effort lookups for org name + member emails +
        // names; transactional helper handles missing-name defaults.
        // Failure to look up does NOT block the grant response.
        try {
          const [org, members] = await Promise.all([
            orgService.getOrg(orgId).catch(() => null),
            orgService.getMembersWithProfiles(orgId).catch(() => []),
          ]);
          const targetMember = members.find((m) => m.userId === userId);
          if (targetMember?.email) {
            const granter = members.find((m) => m.userId === user.sub);
            sendServerAccessGrantedEmail(request.log, {
              to: targetMember.email,
              orgName: org?.name ?? "your organization",
              vendorName: getVendor(vendorSlug)?.name ?? vendorSlug,
              grantedByName: granter?.name ?? granter?.displayName ?? undefined,
              memberName:
                targetMember.name ?? targetMember.displayName ?? undefined,
            });
          }
        } catch (err) {
          request.log.warn(
            { err, orgId, userId },
            "SK1 grant-notify failed (non-fatal)",
          );
        }

        return reply.send(grant);
      },
    );

    // DELETE /api/orgs/:orgId/members/:userId/server-access/:vendor — revoke access (admin+)
    app.delete<{ Params: { orgId: string; userId: string; vendor: string } }>(
      "/api/orgs/:orgId/members/:userId/server-access/:vendor",
      async (request, reply) => {
        const { orgId, userId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        // Target-membership check — same rationale as the grant handler
        // (gateway PR #78 M10): no audit entry for a non-member user id.
        const targetMembership = await orgService.getMembership(orgId, userId);
        if (!targetMembership) {
          return reply.code(404).send({
            error: "Target user is not a member of this organization",
          });
        }

        await orgService.revokeServerAccess(orgId, userId, vendorSlug);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: userId,
            eventType: "server_access_revoked",
            metadata: { vendor: vendorSlug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        // SK2 (ruby SK1 launch-blocker 2026-06-05): notify the revoked
        // member at the consent/capability-affecting moment — this is
        // the higher-stakes sibling of SK1 (per ruby v4 refined clause
        // 'consent/capability-affecting events require explicit
        // counterparty-notification regardless of channel-mix'). The
        // worst-discovery moment was the member's AI agent failing on
        // next request with no signal of why.
        try {
          const [org, members] = await Promise.all([
            orgService.getOrg(orgId).catch(() => null),
            orgService.getMembersWithProfiles(orgId).catch(() => []),
          ]);
          const targetMember = members.find((m) => m.userId === userId);
          if (targetMember?.email) {
            const revoker = members.find((m) => m.userId === user.sub);
            sendServerAccessRevokedEmail(request.log, {
              to: targetMember.email,
              orgName: org?.name ?? "your organization",
              vendorName: getVendor(vendorSlug)?.name ?? vendorSlug,
              revokedByName: revoker?.name ?? revoker?.displayName ?? undefined,
              memberName:
                targetMember.name ?? targetMember.displayName ?? undefined,
            });
          }
        } catch (err) {
          request.log.warn(
            { err, orgId, userId },
            "SK2 revoke-notify failed (non-fatal)",
          );
        }

        return reply.code(204).send();
      },
    );

    // PUT /api/orgs/:orgId/members/:userId/server-access — bulk-set access (admin+)
    app.put<{
      Params: { orgId: string; userId: string };
      Body: { vendors: string[] };
    }>(
      "/api/orgs/:orgId/members/:userId/server-access",
      async (request, reply) => {
        const { orgId, userId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const { vendors } = request.body;
        if (!Array.isArray(vendors)) {
          return reply
            .code(400)
            .send({ error: "vendors must be an array of vendor slugs" });
        }

        // Target-membership check — same rationale as the grant handler
        // (gateway PR #78 M10).
        const targetMembership = await orgService.getMembership(orgId, userId);
        if (!targetMembership) {
          return reply.code(404).send({
            error: "Target user is not a member of this organization",
          });
        }

        await orgService.bulkSetServerAccess(orgId, userId, vendors, user.sub);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: userId,
            eventType: "server_access_bulk_set",
            metadata: { vendors },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.send({ success: true });
      },
    );

    // PATCH /api/orgs/:orgId/settings — update org settings (owner only)
    app.patch<{
      Params: { orgId: string };
      Body: { defaultServerAccess?: string };
    }>("/api/orgs/:orgId/settings", async (request, reply) => {
      const { orgId } = request.params;
      const user = await requireOrgRoleForWrite(
        request,
        reply,
        orgService,
        orgId,
        "owner",
      );
      if (!user) return;

      const { defaultServerAccess } = request.body;
      if (
        defaultServerAccess &&
        defaultServerAccess !== "none" &&
        defaultServerAccess !== "all"
      ) {
        return reply
          .code(400)
          .send({ error: 'defaultServerAccess must be "none" or "all"' });
      }

      const org = await orgService.updateOrgSettings(orgId, {
        defaultServerAccess: defaultServerAccess as "none" | "all" | undefined,
      });
      void adminAuditService
        .log({
          orgId,
          actorId: user.sub,
          eventType: "org_updated",
          metadata: { defaultServerAccess },
        })
        .catch((err) => request.log.error(err, "admin audit log failed"));
      return reply.send(org);
    });

    // -----------------------------------------------------------------------
    // Teams
    // -----------------------------------------------------------------------

    // POST /api/orgs/:orgId/teams — create team
    app.post<{ Params: { orgId: string }; Body: { name: string } }>(
      "/api/orgs/:orgId/teams",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) {
          return reply.code(402).send({ error: "Upgrade to Pro to use teams" });
        }

        const { name } = request.body;
        if (!name?.trim()) {
          return reply.code(400).send({ error: "Team name is required" });
        }

        try {
          const team = await orgService.createTeam(
            orgId,
            name.trim(),
            user.sub,
          );
          void adminAuditService
            .log({
              orgId,
              actorId: user.sub,
              eventType: "team_created",
              metadata: { teamId: team.id, name: team.name },
            })
            .catch((err) => request.log.error(err, "admin audit log failed"));
          return reply.code(201).send(team);
        } catch (err: unknown) {
          if (
            err &&
            typeof err === "object" &&
            "code" in err &&
            (err as { code: string }).code === "23505"
          ) {
            return reply
              .code(409)
              .send({ error: "A team with that name already exists" });
          }
          throw err;
        }
      },
    );

    // GET /api/orgs/:orgId/teams — list teams
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/teams",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const teams = await orgService.listTeamsWithDetails(orgId);
        return reply.send(teams);
      },
    );

    // PATCH /api/orgs/:orgId/teams/:teamId — rename team
    app.patch<{
      Params: { orgId: string; teamId: string };
      Body: { name: string };
    }>("/api/orgs/:orgId/teams/:teamId", async (request, reply) => {
      const { orgId, teamId } = request.params;
      const user = await requireOrgRoleForWrite(
        request,
        reply,
        orgService,
        orgId,
        "admin",
      );
      if (!user) return;

      const team = await orgService.getTeam(teamId);
      if (!team || team.orgId !== orgId) {
        return reply.code(404).send({ error: "Team not found" });
      }

      const { name } = request.body;
      if (!name?.trim()) {
        return reply.code(400).send({ error: "Team name is required" });
      }

      const updated = await orgService.renameTeam(teamId, name.trim());
      void adminAuditService
        .log({
          orgId,
          actorId: user.sub,
          eventType: "team_renamed",
          metadata: { teamId, oldName: team.name, newName: name.trim() },
        })
        .catch((err) => request.log.error(err, "admin audit log failed"));
      return reply.send(updated);
    });

    // DELETE /api/orgs/:orgId/teams/:teamId — delete team (owner only)
    app.delete<{ Params: { orgId: string; teamId: string } }>(
      "/api/orgs/:orgId/teams/:teamId",
      async (request, reply) => {
        const { orgId, teamId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "owner",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        await orgService.deleteTeam(teamId);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "team_deleted",
            metadata: { teamId, name: team.name },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // PUT /api/orgs/:orgId/teams/:teamId/members/:userId — add member
    app.put<{ Params: { orgId: string; teamId: string; userId: string } }>(
      "/api/orgs/:orgId/teams/:teamId/members/:userId",
      async (request, reply) => {
        const { orgId, teamId, userId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        // Verify user is an org member
        const membership = await orgService.getMembership(orgId, userId);
        if (!membership) {
          return reply
            .code(400)
            .send({ error: "User is not a member of this organization" });
        }

        const member = await orgService.addTeamMember(
          teamId,
          orgId,
          userId,
          user.sub,
        );
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: userId,
            eventType: "team_member_added",
            metadata: { teamId, teamName: team.name },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.send(member);
      },
    );

    // DELETE /api/orgs/:orgId/teams/:teamId/members/:userId — remove member
    app.delete<{ Params: { orgId: string; teamId: string; userId: string } }>(
      "/api/orgs/:orgId/teams/:teamId/members/:userId",
      async (request, reply) => {
        const { orgId, teamId, userId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        await orgService.removeTeamMember(teamId, userId);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: userId,
            eventType: "team_member_removed",
            metadata: { teamId, teamName: team.name },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // PUT /api/orgs/:orgId/teams/:teamId/server-access/:vendor — grant vendor
    app.put<{ Params: { orgId: string; teamId: string; vendor: string } }>(
      "/api/orgs/:orgId/teams/:teamId/server-access/:vendor",
      async (request, reply) => {
        const { orgId, teamId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        const grant = await orgService.grantTeamServerAccess(
          orgId,
          teamId,
          vendorSlug,
          user.sub,
        );
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "team_server_access_granted",
            metadata: { teamId, teamName: team.name, vendor: vendorSlug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.send(grant);
      },
    );

    // DELETE /api/orgs/:orgId/teams/:teamId/server-access/:vendor — revoke vendor
    app.delete<{ Params: { orgId: string; teamId: string; vendor: string } }>(
      "/api/orgs/:orgId/teams/:teamId/server-access/:vendor",
      async (request, reply) => {
        const { orgId, teamId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        await orgService.revokeTeamServerAccess(teamId, vendorSlug);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "team_server_access_revoked",
            metadata: { teamId, teamName: team.name, vendor: vendorSlug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Org credentials
    // -----------------------------------------------------------------------

    // POST /api/orgs/:orgId/credentials/:vendor — store org credential
    //
    // WRITE-PATH AUTHORITY (WYREAI-171 Phase-3 close, msg-1781725198971 +
    // warden HARD-REQ 2): uses requireOrgRoleForWrite so an actingAs
    // operator's binding is RE-VERIFIED against current DB state before
    // the write proceeds. A revoked operator with a still-valid cookie
    // session is rejected with 401 (binding-invalid), NOT a stale 200.
    app.post<{
      Params: { orgId: string; vendor: string };
      Body: Record<string, string>;
    }>(
      "/api/orgs/:orgId/credentials/:vendor",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const { orgId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        // Require pro plan
        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) {
          return reply
            .code(402)
            .send({ error: "Upgrade to Pro to manage team credentials" });
        }

        const vendor = getVendor(vendorSlug);
        if (!vendor) {
          return reply.code(404).send({ error: "Unknown vendor" });
        }

        // OAuth-only vendors must authenticate via the OAuth flow, not direct credential posting.
        if (vendor.oauthConfig && vendor.fields.length === 0) {
          return reply.code(400).send({
            error: `${vendor.name} requires OAuth authentication. Use the "Connect for Team" button on the Team Connections page.`,
          });
        }

        // Validate required fields
        const body = request.body;
        const credData: Record<string, string> = {};
        for (const field of vendor.fields) {
          if (field.required && !body[field.key]?.trim()) {
            return reply
              .code(400)
              .send({ error: `${field.label} is required` });
          }
          if (body[field.key]) {
            credData[field.key] = body[field.key].trim();
          }
        }

        // Validate against vendor API
        if (vendor.validate) {
          try {
            const result = await vendor.validate(credData);
            if (!result.valid) {
              return reply
                .code(422)
                .send({ error: result.error || "Invalid credentials" });
            }
          } catch {
            app.log.warn(
              { vendor: vendorSlug },
              "Org credential validation skipped: vendor API unreachable",
            );
          }
        }

        const id = await credentialService.storeOrgCredential(
          orgId,
          vendorSlug,
          credData,
          user.sub,
        );
        // Warden HARD-REQ 4 (boss msg-1781726477131): emit the
        // actingAsAuditTriplet INDEPENDENTLY of authorization input —
        // (actor, viaResellerOrgId, onBehalfOfOrgId) are SCOPE/FORENSICS
        // record, not authz-eval, and must never be conflated (ruby
        // Finding 1 from PR #386).
        //
        // First-class columns on admin_audit_log are (org_id, actor_id,
        // event_type, ...). For actingAs writes, org_id IS the
        // onBehalfOfOrgId by route shape — but we ALSO embed the full
        // triplet in metadata so a future audit-log schema-migration
        // (adding dedicated via_reseller_org_id / on_behalf_of columns)
        // can backfill from JSON without reading the route URL. Direct
        // writes (no actingAs) emit the triplet with null acting-fields
        // so forensics queries are uniform across paths.
        const triplet = actingAsAuditTriplet(request, user);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "org_credential_created",
            metadata: {
              vendor: vendorSlug,
              acting_as: {
                actor: triplet.actor,
                via_reseller_org_id: triplet.viaResellerOrgId,
                on_behalf_of_org_id: triplet.onBehalfOfOrgId,
              },
            },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(201).send({ id, vendor: vendorSlug });
      },
    );

    // GET /api/orgs/:orgId/credentials — list org vendor connections
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/credentials",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "member",
        );
        if (!user) return;

        const vendors = await credentialService.listOrgVendors(orgId);
        return reply.send(vendors);
      },
    );

    // DELETE /api/orgs/:orgId/credentials/:vendor — remove org credential
    app.delete<{ Params: { orgId: string; vendor: string } }>(
      "/api/orgs/:orgId/credentials/:vendor",
      async (request, reply) => {
        const { orgId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        await credentialService.deleteOrgCredential(orgId, vendorSlug);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "org_credential_deleted",
            metadata: { vendor: vendorSlug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Invitation acceptance (web routes)
    // -----------------------------------------------------------------------

    // GET /invite/:token — show invitation acceptance page
    app.get<{ Params: { token: string } }>(
      "/invite/:token",
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return; // Redirects to login

        const { token } = request.params;
        const invitation = await orgService.getInvitationByToken(token);
        if (!invitation) {
          return reply
            .code(404)
            .type("text/html")
            .send(
              renderInviteErrorPage(
                "This invitation has expired or is no longer valid.",
              ),
            );
        }

        const org = await orgService.getOrg(invitation.orgId);
        if (!org) {
          return reply
            .code(404)
            .type("text/html")
            .send(renderInviteErrorPage("Organization not found."));
        }

        return reply.type("text/html").send(renderInvitePage(org.name, token));
      },
    );

    // POST /invite/:token — accept invitation
    app.post<{ Params: { token: string } }>(
      "/invite/:token",
      { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { token } = request.params;
        // Layer 1: acceptInvitation can now return a discriminated-union
        // failure (email-match miss or owner-invite scope violation) in
        // addition to OrgMember | null. Each kind maps to the right HTTP
        // status + named-actionable-choice copy.
        //
        // 2026-06-12 launch-day workaround (boss): wrap in runAsSystem so the
        // underlying INSERT into customer-org-org_members bypasses the RLS
        // policy that currently hangs request-path writes initiated by a
        // user who is not yet a row in that table for the target org. The
        // acceptee is BY DEFINITION not yet a member (that's what accept is
        // adding them as), so the request-path connection's row-visibility
        // context lacks the membership row the RLS policy is checking
        // against. Same hang class boss hit on POST /api/orgs/:customerId/
        // invitations earlier today; sibling workaround PR #370 sidestepped
        // that one via a reseller-scoped route — this one needs a different
        // shape because the acceptee, not the reseller, initiates accept.
        //
        // Security model preserved: requireAuth0 above verifies the caller's
        // identity, and acceptInvitation internally enforces
        // recipient_email match, max_uses, expiry, and owner-invite scope
        // — those checks all run inside the runAsSystem block, just on the
        // BYPASSRLS pool. RLS bypass only widens DB row-visibility for the
        // function's own queries; it does NOT change the caller-identity or
        // the function's own authorization logic.
        //
        // Removing this workaround once the RLS policy is fixed is a
        // one-line revert.
        const result = await runAsSystem(() =>
          orgService.acceptInvitation(
            token,
            user.sub,
            request.log,
            user.email ?? null,
          ),
        );
        if (!result) {
          return reply
            .code(404)
            .type("text/html")
            .send(
              renderInviteErrorPage(
                "This invitation has expired or is no longer valid.",
              ),
            );
        }
        if (isAcceptInvitationError(result)) {
          // Distinct surfaces — different recovery paths.
          //   email_mismatch → 403, recovery is sign-in-with-invited-account
          //     or reissue-from-admin.
          //   owner_invite_scope_violation → 409, system-level invariant
          //     violation (should never reach a user in production; design
          //     constraint refused at the boundary).
          const status = result.kind === "email_mismatch" ? 403 : 409;
          return reply
            .code(status)
            .type("text/html")
            .send(renderInviteErrorPage(result.message));
        }

        void adminAuditService
          .log({
            orgId: result.orgId,
            actorId: user.sub,
            eventType: "invitation_accepted",
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        // MR1+MR2 (ruby launch-blocker 2026-06-05): notify both sides of
        // the invite-accept cap-stone. Best-effort lookups for names +
        // emails; transactional helpers handle missing-name graceful
        // defaults at the template substrate. Failure to look up does
        // NOT block the accept-redirect (the security-critical action
        // already succeeded).
        try {
          // 2026-06-12 launch-day fix (boss): wrap these post-accept lookups
          // in runAsSystem too. The acceptee just transitioned from non-member
          // to member of the customer org, but the request-path RLS context
          // still sees the PRE-accept membership (the request-pool tx hasn't
          // committed yet — onResponse settles it AFTER this handler returns).
          // Running `getMembersWithProfiles(customerOrgId)` on the request
          // pool against an org the caller is not-yet-a-row-in causes the
          // INSTRUMENTED hang surfaced via the step markers — handler runs
          // through E (acceptInvitation success) but never reaches reply.send,
          // confirmed via PR #372 instrumentation. Using runAsSystem here
          // bypasses RLS so these read-only lookups for the welcome-email +
          // inviter-notify side-effects complete. They are best-effort and
          // already wrapped in try/catch — non-fatal for the accept itself.
          const [org, invitation, members] = await runAsSystem(() =>
            Promise.all([
              orgService.getOrg(result.orgId).catch(() => null),
              orgService.getInvitationByToken(token).catch(() => null),
              orgService.getMembersWithProfiles(result.orgId).catch(() => []),
            ]),
          );
          const orgName = org?.name ?? "your organization";
          const acceptorMember = members.find((m) => m.userId === user.sub);
          const acceptorName =
            acceptorMember?.name ??
            acceptorMember?.displayName ??
            user.name ??
            undefined;
          const acceptorEmail = user.email ?? acceptorMember?.email ?? null;

          // MR2 — welcome the new member to the org.
          if (acceptorEmail) {
            sendJoinedOrgWelcomeEmail(request.log, {
              to: acceptorEmail,
              orgName,
              role: result.role,
              memberName: acceptorName,
            });
          }

          // MR1 — notify the admin/inviter that the invite was accepted.
          if (invitation?.invitedBy) {
            const inviterMember = members.find(
              (m) => m.userId === invitation.invitedBy,
            );
            const inviterEmail = inviterMember?.email ?? null;
            if (inviterEmail) {
              sendInvitationAcceptedEmail(request.log, {
                to: inviterEmail,
                orgName,
                inviteeEmail:
                  acceptorEmail ?? invitation.recipientEmail ?? "a teammate",
                inviteeName: acceptorName,
              });
            }
          }
        } catch (err) {
          request.log.warn(
            { err, orgId: result.orgId },
            "MR1/MR2 post-accept notify failed (non-fatal)",
          );
        }

        return reply.redirect("/settings", 302);
      },
    );

    // -----------------------------------------------------------------------
    // Service client management (M2M / AI agent access)
    // -----------------------------------------------------------------------

    // POST /api/orgs/:orgId/service-clients — create a service client
    app.post<{
      Params: { orgId: string };
      Body: { name: string; expires_in_days?: number };
    }>("/api/orgs/:orgId/service-clients", async (request, reply) => {
      const user = await requireOrgRoleForWrite(
        request,
        reply,
        orgService,
        request.params.orgId,
        "admin",
      );
      if (!user) return;

      // Business-tier gate. Enforced at the API layer (not just the
      // /org/service-clients web page, which gates on requireTeamAccess)
      // so a below-Business org admin cannot create a service client by
      // calling this endpoint directly. List + revoke stay ungated so a
      // downgraded org can still see and wind down existing clients.
      if (!(await billingGate.canUseServiceClients(request.params.orgId))) {
        return reply
          .code(402)
          .send({ error: "Service clients require the Business plan" });
      }

      const { name, expires_in_days: expiresInDays } = request.body;
      if (!name?.trim()) {
        return reply
          .code(400)
          .send({ error: "Service client name is required" });
      }

      // Generate credentials
      const clientId = `svc_${nanoid(24)}`;
      const clientSecret = nanoid(48);
      const clientSecretHash = createHash("sha256")
        .update(clientSecret)
        .digest("hex");

      const expiresAt = expiresInDays
        ? new Date(
            Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
          ).toISOString()
        : undefined;

      const serviceClient = await orgService.createServiceClient({
        orgId: request.params.orgId,
        name: name.trim(),
        clientId,
        clientSecretHash,
        createdBy: user.sub,
        expiresAt,
      });

      void adminAuditService
        .log({
          orgId: request.params.orgId,
          actorId: user.sub,
          eventType: "service_client_created",
          metadata: {
            clientId,
            name: name.trim(),
            expiresAt: expiresAt ?? "never",
          },
        })
        .catch((err) => request.log.error(err, "admin audit log failed"));

      // Return secret ONCE — it's hashed in DB and cannot be retrieved later
      return reply.code(201).send({
        id: serviceClient.id,
        name: serviceClient.name,
        client_id: clientId,
        client_secret: clientSecret,
        expires_at: serviceClient.expiresAt,
        created_at: serviceClient.createdAt,
      });
    });

    // GET /api/orgs/:orgId/service-clients — list service clients
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/service-clients",
      async (request, reply) => {
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          request.params.orgId,
          "admin",
        );
        if (!user) return;

        const clients = await orgService.listServiceClients(
          request.params.orgId,
        );
        return reply.send(
          clients.map((c) => ({
            id: c.id,
            name: c.name,
            client_id: c.clientId,
            last_used_at: c.lastUsedAt,
            expires_at: c.expiresAt,
            created_at: c.createdAt,
          })),
        );
      },
    );

    // DELETE /api/orgs/:orgId/service-clients/:clientId — revoke a service client
    app.delete<{ Params: { orgId: string; clientId: string } }>(
      "/api/orgs/:orgId/service-clients/:clientId",
      async (request, reply) => {
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          request.params.orgId,
          "admin",
        );
        if (!user) return;

        const deleted = await orgService.deleteServiceClient(
          request.params.orgId,
          request.params.clientId,
        );
        if (!deleted) {
          return reply.code(404).send({ error: "Service client not found" });
        }

        void adminAuditService
          .log({
            orgId: request.params.orgId,
            actorId: user.sub,
            eventType: "service_client_revoked",
            metadata: { clientId: request.params.clientId },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // SCIM connection management
    // -----------------------------------------------------------------------

    // POST /api/orgs/:orgId/scim/connections — create a SCIM connection
    app.post<{
      Params: { orgId: string };
      Body: { idp_type: string; default_role: string };
    }>("/api/orgs/:orgId/scim/connections", async (request, reply) => {
      const user = await requireOrgRoleForWrite(
        request,
        reply,
        orgService,
        request.params.orgId,
        "admin",
      );
      if (!user) return;

      // Business-tier gate. Enforced at the API layer (not just the
      // /org/scim web page, which gates on requireTeamAccess) so a
      // below-Business org admin cannot create a SCIM/SSO connection by
      // calling this endpoint directly. List + revoke stay ungated so a
      // downgraded org can still see and wind down existing connections.
      if (!(await billingGate.canUseSso(request.params.orgId))) {
        return reply.code(402).send({
          error: "SSO / SCIM provisioning requires the Business plan",
        });
      }

      const { idp_type: idpType, default_role: defaultRole } = request.body;
      const allowedIdps = ["entra", "okta", "jumpcloud", "google", "generic"];
      if (!allowedIdps.includes(idpType)) {
        return reply.code(400).send({ error: "Unsupported idp_type" });
      }
      if (!defaultRole?.trim()) {
        return reply.code(400).send({ error: "default_role is required" });
      }

      // Tenant scope: customer/standalone orgs. Reseller scope: type=reseller.
      const org = await orgService.getOrg(request.params.orgId);
      if (!org) return reply.code(404).send({ error: "Org not found" });
      const scope = org.type === "reseller" ? "reseller" : "tenant";

      const { ScimConnectionsService } =
        await import("../scim/connections-service.js");
      const connections = new ScimConnectionsService();
      const created = await connections.create({
        orgId: request.params.orgId,
        scope,
        idpType: idpType as
          | "entra"
          | "okta"
          | "jumpcloud"
          | "google"
          | "generic",
        defaultRole: defaultRole.trim(),
        createdBy: user.sub,
      });

      void adminAuditService
        .log({
          orgId: request.params.orgId,
          actorId: user.sub,
          eventType: "scim_connection_created",
          metadata: { connectionId: created.connection.id, idpType, scope },
        })
        .catch((err) => request.log.error(err, "admin audit log failed"));

      return reply.code(201).send({
        id: created.connection.id,
        idp_type: created.connection.idpType,
        scope: created.connection.scope,
        default_role: created.connection.defaultRole,
        token: created.token,
        created_at: created.connection.createdAt,
      });
    });

    // GET /api/orgs/:orgId/scim/connections — list connections
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/scim/connections",
      async (request, reply) => {
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          request.params.orgId,
          "admin",
        );
        if (!user) return;

        const { ScimConnectionsService } =
          await import("../scim/connections-service.js");
        const connections = new ScimConnectionsService();
        const rows = await connections.listForOrg(request.params.orgId);
        return reply.send(
          rows.map((c) => ({
            id: c.id,
            idp_type: c.idpType,
            scope: c.scope,
            default_role: c.defaultRole,
            status: c.status,
            last_sync_at: c.lastSyncAt,
            last_error: c.lastError,
            created_at: c.createdAt,
          })),
        );
      },
    );

    // DELETE /api/orgs/:orgId/scim/connections/:id — revoke a connection
    app.delete<{ Params: { orgId: string; id: string } }>(
      "/api/orgs/:orgId/scim/connections/:id",
      async (request, reply) => {
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          request.params.orgId,
          "admin",
        );
        if (!user) return;

        const { ScimConnectionsService } =
          await import("../scim/connections-service.js");
        const connections = new ScimConnectionsService();
        const conn = await connections.getById(request.params.id);
        if (!conn || conn.orgId !== request.params.orgId) {
          return reply.code(404).send({ error: "Connection not found" });
        }
        const revoked = await connections.revoke(request.params.id);
        if (!revoked) return reply.code(404).send({ error: "Already revoked" });

        void adminAuditService
          .log({
            orgId: request.params.orgId,
            actorId: user.sub,
            eventType: "scim_connection_revoked",
            metadata: {
              connectionId: request.params.id,
              idpType: conn.idpType,
            },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Team credentials
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/teams/:teamId/credentials — list team vendors
    app.get<{ Params: { orgId: string; teamId: string } }>(
      "/api/orgs/:orgId/teams/:teamId/credentials",
      async (request, reply) => {
        const { orgId, teamId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        const vendors = await credentialService.listTeamVendors(teamId);
        return reply.send({ vendors });
      },
    );

    // POST /api/orgs/:orgId/teams/:teamId/credentials/:slug — store team credential
    app.post<{
      Params: { orgId: string; teamId: string; slug: string };
      Body: Record<string, string>;
    }>(
      "/api/orgs/:orgId/teams/:teamId/credentials/:slug",
      async (request, reply) => {
        const { orgId, teamId, slug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        const vendor = getVendor(slug);
        if (!vendor) {
          return reply.code(404).send({ error: `Unknown vendor: ${slug}` });
        }

        await credentialService.storeTeamCredential(
          teamId,
          orgId,
          slug,
          request.body,
          user.sub,
        );
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: teamId,
            eventType: "team_credential_created",
            metadata: { teamId, vendor: slug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.send({ ok: true });
      },
    );

    // DELETE /api/orgs/:orgId/teams/:teamId/credentials/:slug — delete team credential
    app.delete<{ Params: { orgId: string; teamId: string; slug: string } }>(
      "/api/orgs/:orgId/teams/:teamId/credentials/:slug",
      async (request, reply) => {
        const { orgId, teamId, slug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== orgId) {
          return reply.code(404).send({ error: "Team not found" });
        }

        await credentialService.deleteTeamCredential(teamId, slug);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: teamId,
            eventType: "team_credential_deleted",
            metadata: { teamId, vendor: slug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Service client credentials
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/service-clients/:clientId/credentials — list vendors
    app.get<{ Params: { orgId: string; clientId: string } }>(
      "/api/orgs/:orgId/service-clients/:clientId/credentials",
      async (request, reply) => {
        const { orgId, clientId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const vendors =
          await credentialService.listServiceClientVendors(clientId);
        return reply.send({ vendors });
      },
    );

    // POST /api/orgs/:orgId/service-clients/:clientId/credentials/:slug — store credential
    app.post<{
      Params: { orgId: string; clientId: string; slug: string };
      Body: Record<string, string>;
    }>(
      "/api/orgs/:orgId/service-clients/:clientId/credentials/:slug",
      async (request, reply) => {
        const { orgId, clientId, slug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        const vendor = getVendor(slug);
        if (!vendor) {
          return reply.code(404).send({ error: `Unknown vendor: ${slug}` });
        }

        await credentialService.storeServiceClientCredential(
          clientId,
          orgId,
          slug,
          request.body,
          user.sub,
        );
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: clientId,
            eventType: "service_client_credential_created",
            metadata: { clientId, vendor: slug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.send({ ok: true });
      },
    );

    // DELETE /api/orgs/:orgId/service-clients/:clientId/credentials/:slug — delete credential
    app.delete<{ Params: { orgId: string; clientId: string; slug: string } }>(
      "/api/orgs/:orgId/service-clients/:clientId/credentials/:slug",
      async (request, reply) => {
        const { orgId, clientId, slug } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "admin",
        );
        if (!user) return;

        await credentialService.deleteServiceClientCredential(clientId, slug);
        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            targetId: clientId,
            eventType: "service_client_credential_deleted",
            metadata: { clientId, vendor: slug },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));
        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------------
    // Track C reseller-settings sweep-3 — headless JSON API for org API keys.
    //
    // Boss split-decision per Aaron's UI-Figma-first directive
    // (msg-1781453810337): the substrate (mig 048 + service + audit-events
    // + these JSON endpoints) ships independent of the HTML render layer.
    // PR-B adds the GET /org/reseller/api HTML wizard surface after the
    // Aaron-Figma cycle.
    //
    // Sign-axis discipline (boss msg-1781452776703 + pearl's sign-axis
    // sub-pin): plaintext returned ONLY from the create response, never
    // from list/get/anywhere. Validation-witness lives at
    // src/org/org-api-key-service.test.ts (5 by-construction tests pin the
    // contract at the service-substrate).
    // -----------------------------------------------------------------------

    // POST /api/orgs/:orgId/api-keys — create. Returns plaintext ONCE in
    // the JSON response body; no other surface ever exposes it.
    app.post<{ Params: { orgId: string }; Body: { name?: string } }>(
      "/api/orgs/:orgId/api-keys",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "owner",
        );
        if (!user) return;
        if (!orgApiKeyService) {
          return reply
            .code(503)
            .send({ error: "API key service is not configured in this environment" });
        }

        const name = (request.body?.name ?? "").trim();
        if (!name || name.length > 60) {
          return reply
            .code(400)
            .send({ error: "name is required and must be 60 chars or fewer" });
        }

        const { apiKey, plaintextKey } = await orgApiKeyService.create({
          orgId,
          name,
          createdByUserId: user.sub,
        });

        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "api_key_created",
            metadata: {
              name: apiKey.name,
              key_prefix: apiKey.keyPrefix,
              id: apiKey.id,
            },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        return reply.code(201).send({
          api_key: {
            id: apiKey.id,
            org_id: apiKey.orgId,
            name: apiKey.name,
            key_prefix: apiKey.keyPrefix,
            created_by_user_id: apiKey.createdByUserId,
            last_used_at: apiKey.lastUsedAt,
            revoked_at: apiKey.revokedAt,
            created_at: apiKey.createdAt,
          },
          // Plaintext is returned EXACTLY ONCE in this response body —
          // never persisted, never retrievable from any other endpoint.
          // Caller must surface to the user + drop.
          plaintext_key: plaintextKey,
        });
      },
    );

    // GET /api/orgs/:orgId/api-keys — list (no plaintext).
    app.get<{ Params: { orgId: string } }>(
      "/api/orgs/:orgId/api-keys",
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(
          request,
          reply,
          orgService,
          orgId,
          "member",
        );
        if (!user) return;
        if (!orgApiKeyService) {
          return reply.code(503).send({ error: "API key service is not configured" });
        }
        const list = await orgApiKeyService.listForOrg(orgId);
        return reply.send({
          api_keys: list.map((k) => ({
            id: k.id,
            org_id: k.orgId,
            name: k.name,
            key_prefix: k.keyPrefix,
            created_by_user_id: k.createdByUserId,
            last_used_at: k.lastUsedAt,
            revoked_at: k.revokedAt,
            created_at: k.createdAt,
          })),
        });
      },
    );

    // POST /api/orgs/:orgId/api-keys/:keyId/revoke — soft revoke + audit.
    app.post<{ Params: { orgId: string; keyId: string } }>(
      "/api/orgs/:orgId/api-keys/:keyId/revoke",
      async (request, reply) => {
        const { orgId, keyId } = request.params;
        const user = await requireOrgRoleForWrite(
          request,
          reply,
          orgService,
          orgId,
          "owner",
        );
        if (!user) return;
        if (!orgApiKeyService) {
          return reply.code(503).send({ error: "API key service is not configured" });
        }

        const existing = await orgApiKeyService.getById(keyId);
        if (!existing || existing.orgId !== orgId) {
          return reply.code(404).send({ error: "API key not found" });
        }

        await orgApiKeyService.revoke(keyId);

        void adminAuditService
          .log({
            orgId,
            actorId: user.sub,
            eventType: "api_key_revoked",
            metadata: {
              name: existing.name,
              key_prefix: existing.keyPrefix,
              id: existing.id,
            },
          })
          .catch((err) => request.log.error(err, "admin audit log failed"));

        return reply.code(204).send();
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Minimal inline HTML templates for invite pages
// ---------------------------------------------------------------------------

const INVITE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: #0a0a0a; color: #e5e5e5;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 48px 24px;
  }
  .card {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 40px 32px; max-width: 420px; width: 100%; text-align: center;
  }
  .brand { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: #737373; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 600; color: #f5f5f5; margin-bottom: 8px; }
  .subtitle { font-size: 14px; color: #a3a3a3; margin-bottom: 28px; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 100%; padding: 10px 20px; background: #2563eb; color: #fff;
    font-size: 14px; font-weight: 600; font-family: inherit;
    border: none; border-radius: 6px; cursor: pointer; text-decoration: none;
  }
  .btn:hover { background: #1d4ed8; }
  .error-icon { font-size: 32px; margin-bottom: 16px; color: #ef4444; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInvitePage(orgName: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Join ${escapeHtml(orgName)} - ${escapeHtml(brand.name)}</title>
<style>${INVITE_STYLES}</style></head>
<body><div class="card">
  <div class="brand">${escapeHtml(brand.name)}</div>
  <h1>Join ${escapeHtml(orgName)}</h1>
  <p class="subtitle">You've been invited to join this team. Accept to share vendor connections and collaborate with your team.</p>
  <form method="POST" action="/invite/${escapeHtml(token)}">
    <button type="submit" class="btn">Accept &amp; Join Team</button>
  </form>
</div></body></html>`;
}

function renderInviteErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Invalid Invitation - ${escapeHtml(brand.name)}</title>
<style>${INVITE_STYLES}</style></head>
<body><div class="card">
  <div class="brand">${escapeHtml(brand.name)}</div>
  <div class="error-icon">&#10007;</div>
  <h1>Invalid Invitation</h1>
  <p class="subtitle">${escapeHtml(message)}</p>
  <a class="btn" href="/settings">Go to Settings</a>
</div></body></html>`;
}
