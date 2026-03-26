import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org-service.js';
import { requireOrgRole } from './helpers.js';

interface MemberRouteDeps {
  orgService: OrgService;
}

export function memberRoutes(deps: MemberRouteDeps) {
  const { orgService } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // GET /api/orgs/:orgId/members — list members
    app.get<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId/members',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'member');
        if (!user) return;

        const members = await orgService.getMembers(orgId);
        return reply.send(members);
      },
    );

    // DELETE /api/orgs/:orgId/members/:userId — remove member
    app.delete<{ Params: { orgId: string; userId: string } }>(
      '/api/orgs/:orgId/members/:userId',
      async (request, reply) => {
        const { orgId, userId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        const removed = await orgService.removeMember(orgId, userId);
        if (!removed) {
          return reply.code(400).send({ error: 'Cannot remove the org owner' });
        }
        return reply.code(204).send();
      },
    );
  };
}
