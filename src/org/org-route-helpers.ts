import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth0 } from '../auth/auth0.js';
import type { Auth0User } from '../auth/auth0.js';
import type { OrgService } from './org-service.js';
import { ROLE_LEVEL } from './org-service.js';
import type { OrgRole } from './org-service.js';

/**
 * Require that the authenticated user is a member of the org with at least the given role.
 * 'member' = any member, 'admin' = admin or owner, 'owner' = owner only.
 * Returns the Auth0User if authorized, sends 403 and returns null otherwise.
 */
export async function requireOrgRole(
  request: FastifyRequest,
  reply: FastifyReply,
  orgService: OrgService,
  orgId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<Auth0User | null> {
  const user = requireAuth0(request, reply);
  if (!user) return null;

  const membership = await orgService.getMembership(orgId, user.sub);
  if (!membership) {
    reply.code(403).send({ error: 'Not a member of this organization' });
    return null;
  }

  if (ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL[role as OrgRole]) {
    reply.code(403).send({ error: `Requires ${role} role or higher` });
    return null;
  }

  return user;
}
