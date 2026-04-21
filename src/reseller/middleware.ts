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
import type { OrgService } from '../org/org-service.js';

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

// ---------------------------------------------------------------------------
// requireResellerRole(minRole)
//
// Scoped version of `requireResellerAccess`: instead of accepting any
// reseller membership, it enforces that the caller has a membership row
// for the *specific* reseller identified by `:resellerId` in the route
// params, with a role at or above `minRole`.
//
// On failure, writes the appropriate response (404 for feature flag,
// 302 for missing session, 400 for missing param, 403 for missing or
// insufficient membership) and returns null.
// ---------------------------------------------------------------------------

export interface ResellerRoleContext {
  user: Auth0User;
  membership: ResellerMember;
  resellerId: string;
}

interface ResellerIdParams {
  resellerId?: string;
}

export function makeRequireResellerRole(resellerService: ResellerService) {
  return function requireResellerRole(minRole: ResellerRole) {
    return async function check(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<ResellerRoleContext | null> {
      // 1. Feature flag — 404 to keep surface dark.
      if (!config.features.resellerConsole) {
        reply.code(404).send({ error: 'Not found' });
        return null;
      }

      // 2. Auth0 session.
      const user = requireAuth0(request, reply);
      if (!user) return null;

      // 3. Route param.
      const params = (request.params ?? {}) as ResellerIdParams;
      const resellerId = params.resellerId;
      if (!resellerId) {
        reply.code(400).send({ error: 'Missing resellerId route parameter' });
        return null;
      }

      // 4. Membership-for-this-reseller check.
      const membership = await resellerService.getMembership(resellerId, user.sub);
      if (!membership) {
        reply.code(403).send({ error: 'Reseller access required' });
        return null;
      }

      if (RESELLER_ROLE_LEVEL[membership.role] < RESELLER_ROLE_LEVEL[minRole]) {
        reply.code(403).send({ error: 'Insufficient reseller role' });
        return null;
      }

      return { user, membership, resellerId };
    };
  };
}

export type RequireResellerRole = ReturnType<typeof makeRequireResellerRole>;

// ---------------------------------------------------------------------------
// requireResellerOrCustomerAccess()
//
// For routes shaped like `/admin/reseller/:resellerId/customers/:customerId`
// (and similar). Grants access when EITHER:
//
//   (a) the caller has a reseller_members row for :resellerId, AND the
//       :customerId organization's parent_org_id equals :resellerId
//       (i.e. the customer actually belongs to this reseller); OR
//
//   (b) the caller is a direct org_member of :customerId (customer-side
//       self-access — works for standalone orgs and for customers logging
//       into their own tenant regardless of reseller linkage).
//
// The reseller branch intentionally requires *any* reseller role — callers
// that need finer-grained checks should compose with `requireResellerRole`.
// ---------------------------------------------------------------------------

export interface ResellerOrCustomerContext {
  user: Auth0User;
  resellerId: string;
  customerId: string;
  /** How access was granted — useful for audit logging. */
  accessVia: 'reseller' | 'customer';
  /** Populated only when accessVia === 'reseller'. */
  resellerMembership: ResellerMember | null;
}

interface ResellerCustomerParams {
  resellerId?: string;
  customerId?: string;
}

export function makeRequireResellerOrCustomerAccess(
  resellerService: ResellerService,
  orgService: OrgService,
) {
  return function requireResellerOrCustomerAccess() {
    return async function check(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<ResellerOrCustomerContext | null> {
      // 1. Feature flag.
      if (!config.features.resellerConsole) {
        reply.code(404).send({ error: 'Not found' });
        return null;
      }

      // 2. Auth0 session.
      const user = requireAuth0(request, reply);
      if (!user) return null;

      // 3. Route params.
      const params = (request.params ?? {}) as ResellerCustomerParams;
      const { resellerId, customerId } = params;
      if (!resellerId || !customerId) {
        reply.code(400).send({
          error: 'Missing resellerId or customerId route parameter',
        });
        return null;
      }

      // 4a. Reseller branch.
      const resellerMembership = await resellerService.getMembership(
        resellerId,
        user.sub,
      );
      if (resellerMembership) {
        const parent = await orgService.getResellerOfCustomer(customerId);
        if (parent && parent.id === resellerId) {
          return {
            user,
            resellerId,
            customerId,
            accessVia: 'reseller',
            resellerMembership,
          };
        }
        // Reseller is a member of :resellerId but the customer doesn't
        // belong to them — fall through to the customer-side check; the
        // caller could still legitimately be a direct org_member.
      }

      // 4b. Customer-side self-access.
      const orgMembership = await orgService.getMembership(customerId, user.sub);
      if (orgMembership) {
        return {
          user,
          resellerId,
          customerId,
          accessVia: 'customer',
          resellerMembership: null,
        };
      }

      reply.code(403).send({ error: 'Access denied' });
      return null;
    };
  };
}

export type RequireResellerOrCustomerAccess = ReturnType<
  typeof makeRequireResellerOrCustomerAccess
>;
