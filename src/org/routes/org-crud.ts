import type { FastifyInstance } from 'fastify';
import { requireAuth0 } from '../../auth/auth0.js';
import type { OrgService } from '../org-service.js';
import { config } from '../../config.js';
import { requireOrgRole } from './helpers.js';
import { isPaidPlan } from '../../billing/gate.js';

interface OrgCrudDeps {
  orgService: OrgService;
}

export function orgCrudRoutes(deps: OrgCrudDeps) {
  const { orgService } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // POST /api/orgs — create a new organization
    app.post<{ Body: { name: string; invite_code?: string } }>(
      '/api/orgs',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { name, invite_code: inviteCode } = request.body;
        if (!name?.trim()) {
          return reply.code(400).send({ error: 'Organization name is required' });
        }

        // Check if user already owns an org
        const existingOrgs = await orgService.getUserOrgs(user.sub);
        const ownedOrg = existingOrgs.find((o) => o.ownerId === user.sub);
        if (ownedOrg) {
          return reply.code(409).send({ error: 'You already own an organization', org: ownedOrg });
        }

        // Alpha invite code grants pro plan
        const plan = (inviteCode && config.alphaInviteCodes.has(inviteCode))
          ? 'pro' as const
          : 'free' as const;

        const org = await orgService.createOrg(name.trim(), user.sub, plan);
        return reply.code(201).send(org);
      },
    );

    // GET /api/orgs — list user's orgs
    app.get('/api/orgs', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const orgs = await orgService.getUserOrgs(user.sub);
      return reply.send(orgs);
    });

    // GET /api/orgs/:orgId — get org details
    app.get<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'member');
        if (!user) return;

        const org = await orgService.getOrg(orgId);
        if (!org) {
          return reply.code(404).send({ error: 'Organization not found' });
        }

        return reply.send(org);
      },
    );

    // PATCH /api/orgs/:orgId — update org name
    app.patch<{ Params: { orgId: string }; Body: { name: string } }>(
      '/api/orgs/:orgId',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        const { name } = request.body;
        if (!name?.trim()) {
          return reply.code(400).send({ error: 'Organization name is required' });
        }

        const org = await orgService.updateOrg(orgId, name.trim());
        return reply.send(org);
      },
    );

    // POST /api/orgs/:orgId/redeem-code — redeem an invite code to upgrade to pro
    app.post<{ Params: { orgId: string }; Body: { code: string } }>(
      '/api/orgs/:orgId/redeem-code',
      { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        const { code } = request.body;
        if (!code?.trim()) {
          return reply.code(400).send({ error: 'Invite code is required' });
        }

        if (!config.alphaInviteCodes.has(code.trim())) {
          return reply.code(422).send({ error: 'Invalid invite code' });
        }

        const org = await orgService.getOrg(orgId);
        if (isPaidPlan(org?.plan)) {
          return reply.code(409).send({ error: 'Organization is already on a paid plan' });
        }

        await orgService.updateOrgPlan(orgId, 'pro');
        return reply.send({ success: true, plan: 'pro' });
      },
    );

    // DELETE /api/orgs/:orgId — delete org
    app.delete<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        await orgService.deleteOrg(orgId);
        return reply.code(204).send();
      },
    );

    // PUT /api/orgs/:orgId/settings/prompt-capture — toggle prompt capture (owner-only)
    app.put<{ Params: { orgId: string }; Body: { enabled: boolean } }>(
      '/api/orgs/:orgId/settings/prompt-capture',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        const { enabled } = request.body;
        if (typeof enabled !== 'boolean') {
          return reply.code(400).send({ error: '"enabled" must be a boolean' });
        }

        await orgService.setPromptCaptureEnabled(orgId, enabled);
        return reply.send({ promptCaptureEnabled: enabled });
      },
    );
  };
}
