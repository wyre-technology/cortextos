/**
 * Dashboard API routes — usage analytics endpoints.
 *
 * All endpoints require authentication and Pro plan.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth0 } from '../auth/auth0.js';
import type { OrgService, Organization, OrgRole } from '../org/org-service.js';
import { ROLE_LEVEL } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import { isPaidPlan } from '../billing/gate.js';
import type { DashboardService } from './dashboard-service.js';

interface DashboardRouteDeps {
  dashboardService: DashboardService;
  orgService: OrgService;
  billingGate: BillingGate;
}

export function dashboardRoutes(deps: DashboardRouteDeps) {
  const { dashboardService, orgService, billingGate } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    async function resolveOrg(request: FastifyRequest, reply: FastifyReply): Promise<Organization | null> {
      const user = requireAuth0(request, reply);
      if (!user) return null;

      const plan = await billingGate.getUserPlan(user.sub);
      // Use isPaidPlan helper — same drift class PR #71 closed in
      // requireTeamAccess. Strict `plan !== "pro"` rejected business-tier
      // users from the dashboard API; isPaidPlan admits any tier >= pro
      // (currently pro + business; future tiers pick up automatically).
      if (!isPaidPlan(plan)) {
        reply.code(402).send({ error: 'Dashboard requires Pro plan' });
        return null;
      }

      const orgs = await orgService.getUserOrgs(user.sub);
      const org = orgs[0];
      if (!org) {
        reply.code(404).send({ error: 'No organization found' });
        return null;
      }

      const membership = await orgService.getMembership(org.id, user.sub);
      if (!membership || ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin) {
        reply.code(403).send({ error: 'Only admins and owners can view the dashboard' });
        return null;
      }

      return org;
    }

    // GET /api/dashboard/usage
    app.get<{
      Querystring: { start?: string; end?: string };
    }>('/api/dashboard/usage', async (request, reply) => {
      const org = await resolveOrg(request, reply);
      if (!org) return;

      const summary = await dashboardService.getUsageSummary(org.id, {
        start: request.query.start,
        end: request.query.end,
      });
      return reply.send(summary);
    });

    // GET /api/dashboard/savings
    app.get<{
      Querystring: { start?: string; end?: string };
    }>('/api/dashboard/savings', async (request, reply) => {
      const org = await resolveOrg(request, reply);
      if (!org) return;

      const savings = await dashboardService.getTokenSavings(org.id, {
        start: request.query.start,
        end: request.query.end,
      });
      return reply.send(savings);
    });

    // GET /api/dashboard/vendors
    app.get<{
      Querystring: { start?: string; end?: string };
    }>('/api/dashboard/vendors', async (request, reply) => {
      const org = await resolveOrg(request, reply);
      if (!org) return;

      const vendors = await dashboardService.getVendorBreakdown(org.id, {
        start: request.query.start,
        end: request.query.end,
      });
      return reply.send({ vendors });
    });
  };
}
