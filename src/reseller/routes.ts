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

import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import type { ResellerService } from './reseller-service.js';
import type { OrgService } from '../org/org-service.js';
import {
  ResellerMemberError,
  RESELLER_ROLES,
  type ResellerMemberErrorCode,
  type ResellerMemberService,
  type ResellerRole,
} from '../org/reseller-member-service.js';
import {
  makeRequireResellerAccess,
  makeRequireResellerRole,
  makeRequireResellerOrCustomerAccess,
} from './middleware.js';
import type { DashboardService } from '../dashboard/dashboard-service.js';

export interface ResellerRoutesDeps {
  resellerService: ResellerService;
  resellerMemberService: ResellerMemberService;
  orgService: OrgService;
  dashboardService: DashboardService;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Match by shape rather than `instanceof` — module resets in tests cause
 * `ResellerMemberError` identity to differ between the route module and the
 * test module, so `instanceof` would incorrectly miss real errors.
 */
function isResellerMemberError(err: unknown): err is { name: string; code: ResellerMemberErrorCode; message: string } {
  if (err instanceof ResellerMemberError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'ResellerMemberError' && typeof e.code === 'string';
}

function sendResellerMemberError(
  reply: FastifyReply,
  err: { code: ResellerMemberErrorCode; message: string },
): FastifyReply {
  switch (err.code) {
    case 'INVALID_ROLE':
      return reply.code(400).send({ error: err.message, code: err.code });
    case 'INSUFFICIENT_PERMISSION':
      return reply.code(403).send({ error: err.message, code: err.code });
    case 'LAST_OWNER_PROTECTION':
      return reply.code(409).send({ error: err.message, code: err.code });
    case 'ACTOR_NOT_FOUND':
    case 'MEMBER_NOT_FOUND':
      return reply.code(404).send({ error: err.message, code: err.code });
    default: {
      // Exhaustiveness guard — unknown codes fall through as 500.
      return reply.code(500).send({ error: 'Internal error' });
    }
  }
}

// ---------------------------------------------------------------------------
// Body validation helpers (inline, no zod — project convention)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResellerRole(value: unknown): value is ResellerRole {
  return typeof value === 'string' && (RESELLER_ROLES as readonly string[]).includes(value);
}

interface UpdateResellerBody {
  name: string;
}

function parseUpdateResellerBody(body: unknown): UpdateResellerBody | { error: string } {
  if (!isRecord(body)) return { error: 'Request body must be a JSON object' };
  const name = body.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name is required and must be a non-empty string' };
  }
  if (name.length > 200) {
    return { error: 'name must be 200 characters or fewer' };
  }
  return { name: name.trim() };
}

interface CreateMemberBody {
  userId: string;
  role: ResellerRole;
}

function parseCreateMemberBody(body: unknown): CreateMemberBody | { error: string } {
  if (!isRecord(body)) return { error: 'Request body must be a JSON object' };
  const userId = body.userId;
  const role = body.role;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return { error: 'userId is required and must be a non-empty string' };
  }
  if (!isResellerRole(role)) {
    return { error: `role must be one of: ${RESELLER_ROLES.join(', ')}` };
  }
  return { userId, role };
}

interface UpdateMemberBody {
  role: ResellerRole;
}

function parseUpdateMemberBody(body: unknown): UpdateMemberBody | { error: string } {
  if (!isRecord(body)) return { error: 'Request body must be a JSON object' };
  const role = body.role;
  if (!isResellerRole(role)) {
    return { error: `role must be one of: ${RESELLER_ROLES.join(', ')}` };
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
    const n = typeof pageRaw === 'number' ? pageRaw : parseInt(String(pageRaw), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { error: 'page must be a positive integer' };
    }
    page = n;
  }
  if (pageSizeRaw !== undefined) {
    const n = typeof pageSizeRaw === 'number' ? pageSizeRaw : parseInt(String(pageSizeRaw), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
      return { error: 'pageSize must be an integer between 1 and 100' };
    }
    pageSize = n;
  }
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function resellerRoutes(deps: ResellerRoutesDeps) {
  const { resellerService, resellerMemberService, orgService, dashboardService } = deps;
  const requireResellerAccess = makeRequireResellerAccess(resellerService);
  const requireResellerRole = makeRequireResellerRole(resellerService);
  const requireResellerOrCustomerAccess = makeRequireResellerOrCustomerAccess(
    resellerService,
    orgService,
  )();

  return async function plugin(app: FastifyInstance): Promise<void> {
    // Feature-flag gate — keeps the entire /admin/reseller/* surface dark.
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/admin/reseller')) return;
      if (!config.features.resellerConsole) {
        reply.code(404).send({ error: 'Not found' });
      }
    });

    // -----------------------------------------------------------------------
    // GET /admin/reseller/ — landing (kept from scaffold; HTML)
    // -----------------------------------------------------------------------
    app.get('/admin/reseller/', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply);
      if (!ctx) return;
      return reply.type('text/html; charset=utf-8').send(
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
      '/admin/reseller/:resellerId',
      async (request, reply) => {
        const ctx = await requireResellerRole('reseller_support_agent')(request, reply);
        if (!ctx) return;

        const { resellerId } = ctx;
        const org = await orgService.getOrg(resellerId);
        if (!org || org.type !== 'reseller') {
          return reply.code(404).send({ error: 'Reseller not found' });
        }

        const [customers, members] = await Promise.all([
          orgService.getCustomersOfReseller(resellerId),
          resellerMemberService.list(resellerId),
        ]);

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
      '/admin/reseller/:resellerId',
      async (request, reply) => {
        const ctx = await requireResellerRole('reseller_admin')(request, reply);
        if (!ctx) return;

        const parsed = parseUpdateResellerBody(request.body);
        if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

        const existing = await orgService.getOrg(ctx.resellerId);
        if (!existing || existing.type !== 'reseller') {
          return reply.code(404).send({ error: 'Reseller not found' });
        }

        const updated = await orgService.updateOrg(ctx.resellerId, parsed.name);
        if (!updated) return reply.code(404).send({ error: 'Reseller not found' });

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
      '/admin/reseller/:resellerId/members',
      async (request, reply) => {
        const ctx = await requireResellerRole('reseller_support_agent')(request, reply);
        if (!ctx) return;

        const pagination = parsePagination(request.query);
        if ('error' in pagination) {
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
      '/admin/reseller/:resellerId/members',
      async (request, reply) => {
        const ctx = await requireResellerRole('reseller_admin')(request, reply);
        if (!ctx) return;

        const parsed = parseCreateMemberBody(request.body);
        if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

        // Extra guard: only reseller_owner may create another reseller_owner.
        if (parsed.role === 'reseller_owner' && ctx.membership.role !== 'reseller_owner') {
          return reply.code(403).send({
            error: 'Only reseller_owner may create another reseller_owner',
            code: 'INSUFFICIENT_PERMISSION',
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
          if (isResellerMemberError(err)) return sendResellerMemberError(reply, err);
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // PATCH /admin/reseller/:resellerId/members/:memberId — update role
    // -----------------------------------------------------------------------
    app.patch<{ Params: { resellerId: string; memberId: string }; Body: unknown }>(
      '/admin/reseller/:resellerId/members/:memberId',
      async (request, reply) => {
        const ctx = await requireResellerRole('reseller_admin')(request, reply);
        if (!ctx) return;

        const parsed = parseUpdateMemberBody(request.body);
        if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

        const { memberId } = request.params;

        try {
          const updated = await resellerMemberService.updateRole(
            memberId,
            parsed.role,
            ctx.membership.id,
          );
          return reply.send(updated);
        } catch (err) {
          if (isResellerMemberError(err)) return sendResellerMemberError(reply, err);
          throw err;
        }
      },
    );

    // -----------------------------------------------------------------------
    // DELETE /admin/reseller/:resellerId/members/:memberId — remove member
    // -----------------------------------------------------------------------
    app.delete<{ Params: { resellerId: string; memberId: string } }>(
      '/admin/reseller/:resellerId/members/:memberId',
      async (request, reply) => {
        const ctx = await requireResellerRole('reseller_admin')(request, reply);
        if (!ctx) return;

        const { memberId } = request.params;

        try {
          const removed = await resellerMemberService.delete(memberId, ctx.membership.id);
          if (!removed) return reply.code(404).send({ error: 'Member not found' });
          return reply.code(204).send();
        } catch (err) {
          if (isResellerMemberError(err)) return sendResellerMemberError(reply, err);
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
      '/admin/reseller/:resellerId/customers/:customerId/dashboard';

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

      const vendors = await dashboardService.getVendorBreakdown(ctx.customerId, {
        start: request.query.start,
        end: request.query.end,
      });
      return reply.send({ vendors });
    });
  };
}

// Minimal local escaper — keeps the scaffold landing page self-contained.
function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
