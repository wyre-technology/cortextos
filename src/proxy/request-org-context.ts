/**
 * Request-scope user→org resolution memoization (α-shape).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * RECON-FOR-GAMMA NOTICE (boss-locked discipline, 2026-05-21):
 *
 * This helper is the **tactical** request-scope single-resolution point for
 * user→org lookups in the `/v1/mcp` tools-dispatch path. It exists because
 * conduit's current request-context plugin sets `conduit.current_user_id` for
 * RLS predicates but does NOT pre-resolve the user's org — every code path
 * that needs `orgId` does its own `orgService.getUserOrgs(userId)` lookup.
 * The on-prem PR #2 dispatch fork introduced a SECOND lookup site (an
 * early-check before `getVendor`), which is a pin-1 violation (double
 * resolution per request).
 *
 * α (this helper) is the smallest correct fix: one memoization point shared
 * by the on-prem fork AND the existing `injectCredentials` internal lookup.
 * One read per request, cache write gated by the auth path that already
 * confirmed the user-org membership (RLS-safe — cache holds only gated
 * pairs, never speculative pre-auth orgs).
 *
 * γ is the proper architectural fix: make user→org a Fastify decoration set
 * during the auth middleware (`request.orgId` populated alongside
 * `conduit.current_user_id`). γ deprecates this helper. The call sites α
 * touches ARE the γ migration target — specifically:
 *   - `src/proxy/credential-injector.ts` (existing `orgService.getUserOrgs`
 *     callsite inside `injectCredentials`)
 *   - `src/proxy/unified-router.ts` (the new on-prem-fork dispatch site)
 *
 * γ is queued for the post-launch architectural-cleanup pass. Until γ lands,
 * THIS HELPER is the single resolution point — do not introduce a third
 * user→org lookup in the request lifecycle.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { FastifyRequest } from 'fastify';
import type { OrgService } from '../org/org-service.js';

/** Where the cache lives on the request. Single property so γ can find it cleanly. */
const CACHE_KEY = Symbol.for('conduit.request.userPrimaryOrg');

interface CacheEntry {
  /** The user we resolved for; cache is invalidated structurally if the user changes (it never does within a request). */
  userId: string;
  /** The resolved org id, or null if the user has no orgs. */
  orgId: string | null;
}

function readCache(request: FastifyRequest, userId: string): CacheEntry | undefined {
  const slot = (request as unknown as Record<symbol, CacheEntry | undefined>)[CACHE_KEY];
  if (!slot) return undefined;
  if (slot.userId !== userId) return undefined; // defense against caller bugs.
  return slot;
}

function writeCache(request: FastifyRequest, entry: CacheEntry): void {
  (request as unknown as Record<symbol, CacheEntry>)[CACHE_KEY] = entry;
}

/**
 * Resolve the user's primary org ID for this request, memoized at request
 * scope. Calls `orgService.getUserOrgs(userId)` at most once per request.
 *
 * **RLS-safe write discipline (boss pin 1):** the cache write happens AFTER
 * `orgService.getUserOrgs` has confirmed the user's actual org membership.
 * The cache never holds an org id that was not gated by an authorized
 * lookup — there is no path that writes a speculative "the user's org" pre-
 * auth. A caller that wants `orgId` for an on-prem check goes through this
 * helper; the helper only resolves through the same `orgService` the rest of
 * the codebase uses for authorization.
 *
 * Returns the FIRST org from `getUserOrgs` (the user's primary org). This is
 * pragmatic for M2 scope (single-tenant users). Multi-org users with on-prem
 * tunnels in non-primary orgs are explicitly out of scope for PR #2; if that
 * case becomes load-bearing, surface for re-scope rather than absorbing.
 */
export async function getUserPrimaryOrgId(
  request: FastifyRequest,
  userId: string,
  orgService: OrgService,
): Promise<string | null> {
  const cached = readCache(request, userId);
  if (cached !== undefined) return cached.orgId;
  const orgs = await orgService.getUserOrgs(userId);
  const orgId = orgs.length > 0 ? orgs[0].id : null;
  writeCache(request, { userId, orgId });
  return orgId;
}

/** Test helper — exposed for unit tests, not for production callers. */
export function _resetRequestOrgCache(request: FastifyRequest): void {
  delete (request as unknown as Record<symbol, unknown>)[CACHE_KEY];
}
