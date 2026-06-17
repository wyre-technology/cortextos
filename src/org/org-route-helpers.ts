/**
 * org-route helpers — authority gates for /api/orgs/:orgId/* routes.
 *
 * Two gates, two threat-models:
 *
 *   requireOrgRole(...)          — READ-side. Direct membership OR an actingAs
 *                                  binding decorated by the acting-as-middleware
 *                                  earlier in this request. Soft-cache window
 *                                  matches the middleware revalidate cadence
 *                                  (~per-request). Reads may tolerate ≤60s
 *                                  staleness per warden HARD-REQ 2.
 *
 *   requireOrgRoleForWrite(...)  — WRITE-side. EVERY call hits the DB and
 *                                  re-runs the LIFECYCLE-BIND 3-check
 *                                  (verifyResellerActingAuthority) against
 *                                  CURRENT state. A revoked operator with a
 *                                  valid cookie session must NOT be able to
 *                                  mutate. Revalidation-fail → 401
 *                                  (binding-invalid), NOT 403 (don't mask
 *                                  revocation as missing-perm). Warden HARD-REQ 2.
 *
 * Five HARD-REQs from warden's pre-review of WYREAI-171 Phase-3 close
 * (boss msg-1781725403477):
 *
 *   #1 Role mapping is reseller-role → customer-role with MONOTONICITY
 *      (customer ≤ reseller, never expands). Launch policy is reseller-admin
 *      → customer-admin ONLY; every other reseller role REJECTS at /switch.
 *      `mapResellerRoleToCustomerRole` is the single site; future mappings
 *      are a pure data change.
 *
 *   #2 Per-write revalidation against current DB (above).
 *
 *   #3 onBehalfOfOrgId spoof mitigations:
 *      (a) target org id comes from the ROUTE PATH PARAM only — never
 *          body/query/header. Callers MUST pass it explicitly to these
 *          helpers so the type system enforces the source.
 *      (b) strict equality (===).
 *      (c) `normalizeOrgId()` applied to BOTH sides at comparison time
 *          AND at /switch when the binding is first persisted.
 *      (d) null/undefined either side → REJECT (explicit guard before
 *          equality).
 *
 *   #4 Audit triplet (actor + via_reseller + on_behalf_of) — see
 *      `withActingAsAuditTriplet`. Every consuming mutation handler
 *      MUST include the triplet in its audit_log row.
 *
 *   #5 Conservative launch mapping (HARD-REQ #1 corollary): a closed-set
 *      mapping minimizes blast-radius if the first mapping turns out to be
 *      wrong. Sibling roles (tier-1 support, finance, etc.) REJECT at
 *      /switch rather than getting silently widened.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth0 } from '../auth/auth0.js';
import type { Auth0User } from '../auth/auth0.js';
import type { OrgService } from './org-service.js';
import { ROLE_LEVEL } from './org-service.js';
import type { OrgRole } from './org-service.js';
import { verifyResellerActingAuthority } from '../reseller/reseller-acting-authority.js';

// ---------------------------------------------------------------------------
// HARD-REQ 1 + 5 — role mapping + monotonicity
// ---------------------------------------------------------------------------

/**
 * Map an operator's role on the reseller-org to the role they hold on a
 * customer-org during acting-as. By policy this is MONOTONIC: the customer-
 * side role NEVER exceeds the operator's reseller-side role.
 *
 * Launch policy (boss msg-1781725403477 + warden HARD-REQ 1):
 *   - reseller-admin → 'admin'
 *   - reseller-owner → 'admin'  (owner is a superset of admin on the reseller;
 *                                 customer-side capped at admin to keep
 *                                 customer-org owner role reserved for the
 *                                 customer's own owner. Monotonicity preserved.)
 *   - everything else → REJECT (null). Tier-1 support / finance / member
 *     etc. do NOT get acting-as authority at launch. Sibling future-mapping
 *     is a pure data change to this single function.
 *
 * A return of `null` means the binding cannot be established (caller fails
 * /switch with 403) or, if loaded from a stale session, is treated as
 * revoked (caller fails the next write with 401).
 */
export function mapResellerRoleToCustomerRole(
  resellerRole: OrgRole,
): OrgRole | null {
  // Closed-set switch — adding a case is a deliberate policy change.
  switch (resellerRole) {
    case 'owner':
    case 'admin':
      return 'admin';
    case 'member':
      return null;
  }
}

// ---------------------------------------------------------------------------
// HARD-REQ 3 — normalizeOrgId
// ---------------------------------------------------------------------------

/**
 * Canonicalize an org id for comparison. Today the cheapest correct
 * normalization is trim + lowercase: conduit org ids are UUID v4 or
 * `L-…`/`org_…` slugs that PG stores case-insensitively. Applying this to
 * BOTH sides at every comparison closes the case-mismatch spoof axis.
 *
 * Returns null for null/undefined/empty-string input — callers MUST treat
 * null as REJECT-the-comparison, not equal-to-something-that-was-also-null.
 */
export function normalizeOrgId(orgId: string | null | undefined): string | null {
  if (typeof orgId !== 'string') return null;
  const trimmed = orgId.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

// ---------------------------------------------------------------------------
// ActingAs binding shape (sibling type augment lives in
// src/reseller/acting-as-middleware.ts; we read it here through a local
// shape-cast so the helper has no reseller-side import dependency at compile)
// ---------------------------------------------------------------------------

interface DecoratedActingAs {
  onBehalfOfOrgId: string;
  viaResellerOrgId: string;
  sessionId: string;
  startedAt: string;
  /** Result of `mapResellerRoleToCustomerRole(operator's reseller-side role)`. */
  effectiveRole: OrgRole;
}

interface DecoratedRequest {
  caller?: {
    actingAs?: DecoratedActingAs;
  };
}

function readActingAs(request: FastifyRequest): DecoratedActingAs | null {
  return (request as FastifyRequest & DecoratedRequest).caller?.actingAs ?? null;
}

// ---------------------------------------------------------------------------
// requireOrgRole (READ-side gate)
// ---------------------------------------------------------------------------

/**
 * Authority gate for READ-side handlers on /api/orgs/:orgId/*.
 *
 * Two paths to authority:
 *   PATH A — direct org_member row with role ≥ minRole.
 *   PATH B — actingAs binding for THIS org with effectiveRole ≥ minRole.
 *
 * The actingAs binding is trusted at PATH B because the acting-as-middleware
 * re-runs the LIFECYCLE-BIND 3-check on every request before this helper
 * runs (the binding is null on the request if any check failed). Reads
 * inherit a per-request revalidation cadence by-construction.
 *
 * WRITE-side handlers MUST call `requireOrgRoleForWrite` instead — it
 * additionally re-verifies the 3-check against the DB INSIDE the gate so a
 * mid-flight revocation can't be masked by stale session state.
 *
 * Failure → 403 (sends reply, returns null).
 *
 * SECURITY: the caller MUST pass `orgId` extracted from the ROUTE PATH PARAM.
 * Passing a body/query/header-sourced id reopens HARD-REQ 3 (a) spoof axis;
 * the type system can't enforce the source here, so the convention is the
 * load-bearing safeguard. Every consuming handler in src/org/routes.ts and
 * src/org/domain-routes.ts already follows this convention.
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

  // HARD-REQ 3 (d) — null/empty orgId rejects before any comparison.
  const targetOrgId = normalizeOrgId(orgId);
  if (targetOrgId === null) {
    reply.code(400).send({ error: 'Invalid organization id' });
    return null;
  }

  // PATH A — direct membership.
  const membership = await orgService.getMembership(orgId, user.sub);
  if (
    membership &&
    ROLE_LEVEL[membership.role as OrgRole] >= ROLE_LEVEL[role as OrgRole]
  ) {
    return user;
  }

  // PATH B — actingAs binding (LIFECYCLE-BIND-decorated this request).
  const actingAs = readActingAs(request);
  if (actingAs) {
    const bindingOrgId = normalizeOrgId(actingAs.onBehalfOfOrgId);
    if (
      bindingOrgId !== null &&
      bindingOrgId === targetOrgId &&
      ROLE_LEVEL[actingAs.effectiveRole] >= ROLE_LEVEL[role as OrgRole]
    ) {
      return user;
    }
  }

  // Failure shaping preserved (role-shortfall vs no-membership signal).
  if (membership) {
    reply.code(403).send({ error: `Requires ${role} role or higher` });
  } else {
    reply.code(403).send({ error: 'Not a member of this organization' });
  }
  return null;
}

// ---------------------------------------------------------------------------
// HARD-REQ 2 — requireOrgRoleForWrite (per-write DB revalidation)
// ---------------------------------------------------------------------------

/**
 * Authority gate for WRITE-side handlers on /api/orgs/:orgId/*.
 *
 * Same two paths as `requireOrgRole`, but PATH B additionally re-runs
 * `verifyResellerActingAuthority` against CURRENT DB state. A revoked
 * operator with a still-valid cookie session WILL be rejected.
 *
 * Failure mapping (warden HARD-REQ 2):
 *   - PATH A absent + PATH B never satisfied                 → 403
 *   - PATH B binding present but DB-revalidation FAILS       → 401
 *     (binding-invalid; the session was revoked since
 *     the cookie was minted. Do NOT mask as 403.)
 *   - PATH B binding present but role-threshold fails        → 403
 *
 * SECURITY: same path-param-only convention as requireOrgRole. The caller
 * provides `orgId` from `request.params`.
 */
export async function requireOrgRoleForWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  orgService: OrgService,
  orgId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<Auth0User | null> {
  const user = requireAuth0(request, reply);
  if (!user) return null;

  // HARD-REQ 3 (d) — null/empty orgId rejects before any comparison.
  const targetOrgId = normalizeOrgId(orgId);
  if (targetOrgId === null) {
    reply.code(400).send({ error: 'Invalid organization id' });
    return null;
  }

  // PATH A — direct membership (writes still preferred when the operator
  // is a direct member; cheaper than DB-revalidating an actingAs binding).
  const membership = await orgService.getMembership(orgId, user.sub);
  if (
    membership &&
    ROLE_LEVEL[membership.role as OrgRole] >= ROLE_LEVEL[role as OrgRole]
  ) {
    return user;
  }

  // PATH B — actingAs binding + per-write revalidation against DB.
  const actingAs = readActingAs(request);
  if (actingAs) {
    const bindingOrgId = normalizeOrgId(actingAs.onBehalfOfOrgId);
    const sameOrg = bindingOrgId !== null && bindingOrgId === targetOrgId;
    if (sameOrg) {
      // HARD-REQ 2 — DB revalidation. The 3-check primitive runs under
      // runAsSystem (BYPASSRLS) — same as in /switch and the
      // acting-as-middleware. A non-ok result means the operator was
      // removed / demoted / customer archived / customer reparented
      // SINCE the binding was minted. Surface as 401 (binding-invalid),
      // NOT 403 (don't mask revocation as missing-perm).
      const verdict = await verifyResellerActingAuthority(
        orgService,
        user.sub,
        actingAs.viaResellerOrgId,
        actingAs.onBehalfOfOrgId,
      );
      if (!verdict.ok) {
        reply.code(401).send({
          error: 'actingAs binding revoked',
          reason: verdict.reason,
        });
        return null;
      }
      // Re-map the LIVE reseller-side role to the customer-side role at
      // gate time (NOT the role stamped on the binding). If a policy
      // change tightens the mapping, in-flight bindings get the new
      // mapping on their next write.
      const liveEffectiveRole = mapResellerRoleToCustomerRole(verdict.role);
      if (
        liveEffectiveRole !== null &&
        ROLE_LEVEL[liveEffectiveRole] >= ROLE_LEVEL[role as OrgRole]
      ) {
        return user;
      }
      // 3-check passes but role-threshold fails. Tier-1 routes-to-owner
      // case → 403 (role-shortfall), not 401.
      reply.code(403).send({ error: `Requires ${role} role or higher` });
      return null;
    }
  }

  // No PATH A, no qualifying PATH B → 403.
  if (membership) {
    reply.code(403).send({ error: `Requires ${role} role or higher` });
  } else {
    reply.code(403).send({ error: 'Not a member of this organization' });
  }
  return null;
}

// ---------------------------------------------------------------------------
// HARD-REQ 4 — audit triplet helper
// ---------------------------------------------------------------------------

/**
 * The forensics triplet that every actingAs-write-handler MUST log:
 * actor + via_reseller + on_behalf_of, recorded INDEPENDENTLY. NEVER
 * conflate the audit-emit input with the authority-eval input (ruby #386).
 *
 * Direct-member writes log `via_reseller` and `on_behalf_of` as null —
 * a write made WITHOUT acting-as is the absence of those two columns.
 * The triplet shape is the same whether you're auditing direct or
 * acting-as so query-side analytics can union without special-casing.
 */
export interface ActingAsAuditTriplet {
  /** The Auth0 sub of the operator who issued the request. */
  actor: string;
  /** The reseller org the operator is a member of (null if direct). */
  viaResellerOrgId: string | null;
  /** The customer org being acted upon (null if direct). */
  onBehalfOfOrgId: string | null;
}

/**
 * Compute the audit triplet for a request after authority has been
 * established. `user.sub` is always the actor; the acting-as fields are
 * sourced from `request.caller.actingAs` if a binding is present.
 *
 * Use exactly as:
 *   const user = await requireOrgRoleForWrite(...);
 *   if (!user) return;
 *   const triplet = actingAsAuditTriplet(request, user);
 *   await audit.emit({ ...triplet, ...event });
 */
export function actingAsAuditTriplet(
  request: FastifyRequest,
  user: Auth0User,
): ActingAsAuditTriplet {
  const actingAs = readActingAs(request);
  return {
    actor: user.sub,
    viaResellerOrgId: actingAs?.viaResellerOrgId ?? null,
    onBehalfOfOrgId: actingAs?.onBehalfOfOrgId ?? null,
  };
}
