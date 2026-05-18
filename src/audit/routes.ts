import type { FastifyInstance } from 'fastify';
import { requireAuth0 } from '../auth/auth0.js';
import type { OrgService, OrgRole } from '../org/org-service.js';
import { ROLE_LEVEL } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import { isPaidPlan } from '../billing/gate.js';
import type { AuditService } from './audit-service.js';
import type { AdminAuditService } from './admin-audit-service.js';

interface AuditRouteDeps {
  auditService: AuditService;
  adminAuditService: AdminAuditService;
  orgService: OrgService;
  billingGate: BillingGate;
}

export function auditRoutes(deps: AuditRouteDeps) {
  const { auditService, adminAuditService, orgService, billingGate } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    // GET /api/audit — JSON audit log (Pro plan only)
    app.get<{
      Querystring: {
        org_id?: string;
        user_id?: string;
        vendor?: string;
        start?: string;
        end?: string;
        limit?: string;
        offset?: string;
        format?: string;
      };
    }>('/api/audit', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const plan = await billingGate.getUserPlan(user.sub);
      // isPaidPlan — see PR #71 / src/billing/gate.ts for the empirical origin.
      if (!isPaidPlan(plan)) {
        return reply.code(402).send({ error: 'Audit log requires Pro plan' });
      }

      // Resolve the target org FIRST so the role + billing checks both apply
      // to the same org the query will read. Pre-fix, getMembership and
      // canAccessPaidFeatures ran against orgs[0] while params.orgId used the
      // ?org_id= target — letting an admin in org A read org B's audit log
      // (cross-tenant disclosure, gateway PR #78 H3).
      const orgs = await orgService.getUserOrgs(user.sub);
      const orgId = request.query.org_id ?? orgs[0]?.id;
      if (!orgId) {
        return reply.code(404).send({ error: 'No organization found' });
      }

      // Require admin+ role in the RESOLVED org — before any billing gate, so
      // a foreign org_id is rejected here and can't probe org B's billing
      // state via the 402.
      const membership = await orgService.getMembership(orgId, user.sub);
      if (!membership || ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin) {
        return reply.code(403).send({ error: 'Only admins and owners can view the audit log' });
      }

      // Dunning-aware gate (Track A, mig 024). Audit access is suspended when
      // service is past grace, matching requireTeamAccess + dashboard semantics.
      if (!(await billingGate.canAccessPaidFeatures(orgId))) {
        return reply.code(402).send({ error: 'Service suspended — update billing to resume audit access' });
      }

      const params = {
        orgId,
        userId: request.query.user_id,
        vendorSlug: request.query.vendor,
        startDate: request.query.start,
        endDate: request.query.end,
        limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
        offset: request.query.offset ? parseInt(request.query.offset, 10) : undefined,
      };

      // CSV export
      if (request.query.format === 'csv') {
        const csv = await auditService.exportCsv(params);
        return reply
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', 'attachment; filename="audit-log.csv"')
          .send(csv);
      }

      const result = await auditService.query(params);
      return reply.send(result);
    });

    // GET /audit — redirect to sidebar-integrated audit page
    app.get('/audit', async (_request, reply) => {
      return reply.redirect('/org/audit', 301);
    });

    // GET /api/audit/admin — JSON admin audit log (Pro plan, admin+ role)
    app.get<{
      Querystring: {
        org_id?: string;
        event_type?: string;
        actor_id?: string;
        start?: string;
        end?: string;
        limit?: string;
        offset?: string;
        format?: string;
      };
    }>('/api/audit/admin', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const plan = await billingGate.getUserPlan(user.sub);
      // isPaidPlan — see PR #71 / src/billing/gate.ts for the empirical origin.
      if (!isPaidPlan(plan)) {
        return reply.code(402).send({ error: 'Admin audit log requires Pro plan' });
      }

      // Resolve the target org FIRST — same cross-tenant fix as /api/audit
      // (gateway PR #78 H3): role + billing must check the org the query
      // reads, not orgs[0].
      const orgs = await orgService.getUserOrgs(user.sub);
      const orgId = request.query.org_id ?? orgs[0]?.id;
      if (!orgId) {
        return reply.code(404).send({ error: 'No organization found' });
      }

      // Require admin+ role in the RESOLVED org — before the billing gate.
      const membership = await orgService.getMembership(orgId, user.sub);
      if (!membership || ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin) {
        return reply.code(403).send({ error: 'Only admins and owners can view the admin audit log' });
      }

      // Dunning-aware gate (Track A, mig 024). Admin audit gated same as
      // /api/audit — suspended service blocks audit access regardless of role.
      if (!(await billingGate.canAccessPaidFeatures(orgId))) {
        return reply.code(402).send({ error: 'Service suspended — update billing to resume audit access' });
      }

      const params = {
        orgId,
        eventType: request.query.event_type,
        actorId: request.query.actor_id,
        startDate: request.query.start,
        endDate: request.query.end,
        limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
        offset: request.query.offset ? parseInt(request.query.offset, 10) : undefined,
      };

      if (request.query.format === 'csv') {
        const csv = await adminAuditService.exportCsv(params);
        return reply
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', 'attachment; filename="admin-audit-log.csv"')
          .send(csv);
      }

      const result = await adminAuditService.query(params);
      return reply.send(result);
    });
  };
}
