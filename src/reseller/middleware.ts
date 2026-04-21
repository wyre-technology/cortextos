/**
 * Reseller-scope access middleware.
 *
 * `requireResellerAccess` composes three checks in order:
 *   1. Feature flag `RESELLER_CONSOLE_ENABLED` is on — otherwise 404 so the
 *      console ships dark in production.
 *   2. The caller has a valid Auth0 session (delegates to `requireAuth0`).
 *   3. The Auth0 user has at least one row in `reseller_members` whose role
 *      meets `minRole` (default: any reseller role).
 *
 * On success it returns `{ user, memberships }`. On failure it has already
 * written a response (404 / redirect / 403) and returns `null`, so callers
 * should simply `return` after a null.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { requireAuth0 } from '../auth/auth0.js';
import type { Auth0User } from '../auth/auth0.js';
import type { ResellerService } from './reseller-service.js';
import type { ResellerMember, ResellerRole } from './types.js';
import { RESELLER_ROLE_LEVEL } from './types.js';

export interface ResellerAccessContext {
  user: Auth0User;
  memberships: ResellerMember[];
}

export interface RequireResellerAccessOptions {
  /** Minimum reseller role required across at least one membership. */
  minRole?: ResellerRole;
}

export function makeRequireResellerAccess(resellerService: ResellerService) {
  return async function requireResellerAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    options: RequireResellerAccessOptions = {},
  ): Promise<ResellerAccessContext | null> {
    // 1. Feature flag — 404 so we don't even admit the surface exists.
    if (!config.features.resellerConsole) {
      reply.code(404).send({ error: 'Not found' });
      return null;
    }

    // 2. Auth0 session (will 302 to /auth/login on failure).
    const user = requireAuth0(request, reply);
    if (!user) return null;

    // 3. Reseller membership lookup.
    const memberships = await resellerService.getMembershipsForUser(user.sub);
    if (memberships.length === 0) {
      reply.code(403).send({ error: 'Reseller access required' });
      return null;
    }

    const minLevel = RESELLER_ROLE_LEVEL[options.minRole ?? 'reseller_support_agent'];
    const hasMinRole = memberships.some(
      (m) => RESELLER_ROLE_LEVEL[m.role] >= minLevel,
    );
    if (!hasMinRole) {
      reply.code(403).send({ error: 'Insufficient reseller role' });
      return null;
    }

    return { user, memberships };
  };
}

export type RequireResellerAccess = ReturnType<typeof makeRequireResellerAccess>;
