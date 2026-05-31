// WYREAI-61: shared composition helper for proxy tool-scope enforcement.
//
// Three routers (cli, unified, aggregated) all need the same tool-scope
// composition logic. Centralizing here so the cli/unified/aggregated sites
// stay short + identical in shape — and so any future refinement (e.g.
// WYREAI-66 admin-into-RLS, WYREAI-69 already absorbed by the structural-
// pairing in effective-scope.ts) lands in one place.
//
// Per gateway #189 + boss decision-3: CONDUIT_TEAM_SCOPING is the rollout
// flag, OFF by default. Flag-off path is byte-for-byte unchanged from
// pre-WYREAI-61 (org+role allowlist only, owner-bypass). Flag-on path ADDS
// the team-allowlist intersect on top of the existing org+role enforcement
// via effectiveScope.
//
// NOTE on the pre-existing enforcement reach: the team-cred path of
// injectCredentials sets BOTH orgId AND teamId on the injection (see
// credential-injector.ts:189-190 — when a team-cred row matches, the loop
// captures `orgId = org.id; teamId = hits[0].teamId`). The old `if
// (injection.orgId)` gate therefore ALREADY fires on the team-cred path —
// the misleading "Tool allowlist enforcement (org credentials only)" comment
// in unified-router historically referred to which ALLOWLIST is consulted
// (org-row), not which CRED-PATH is enforced. There is NO pre-existing
// team-cred allowlist BYPASS; flag-on simply layers in the team-allowlist
// row as an additional narrowing source. (warden #295 framing-precision.)
//
// The aggregated-router's allowlist enforcement is INDEPENDENT of this
// helper's flag-gate semantics — that's a pre-existing security-gap-close
// (WYREAI-65), unconditional; the team-scope layer on top is flag-gated.
// Both use this helper (aggregated calls it on every request; flag
// controls only the team-intersect contribution).

import { config } from '../config.js';
import type { OrgService } from './org-service.js';
import {
  effectiveScope,
  scopeAllows,
  UNIVERSE,
  type ScopeSet,
} from './effective-scope.js';

export { scopeAllows, UNIVERSE };
export type { ScopeSet };

export interface ScopeRequest {
  userId: string;
  orgId?: string;
  teamId?: string;
}

/**
 * Compose the effective tool-scope for a proxy request. Sequential DB
 * queries (membership → org allowlist → optional team allowlist) — NOT
 * Promise.all, since request-path calls run on the single reserved-tx
 * connection (the #196/#199 hang class).
 *
 * Returns ScopeSet:
 *   - UNIVERSE = allow all (no orgId / owner-role bypass / null allowlist)
 *   - Set<string> = the permitted tool names; callers use scopeAllows.
 *
 * The role-resolution is internal: callers pass the request's injection
 * shape, this helper does membership lookup → role → allowlist → optional
 * team-scope intersect. Existing flag-off semantics:
 *   - no orgId → UNIVERSE
 *   - role=owner → UNIVERSE
 *   - role=admin|member → org allowlist for that role (or UNIVERSE when null)
 *
 * Flag-on extension (CONDUIT_TEAM_SCOPING=true, AND request.teamId present):
 *   intersect with the team's allowlist (or UNIVERSE if no team allowlist row).
 *   No prior bypass to close — the org+role enforcement was already firing on
 *   the team-cred path (injection sets both orgId + teamId); flag-on adds the
 *   team-allowlist as an additional narrowing source.
 */
export async function composeToolScope(
  orgService: OrgService,
  vendorSlug: string,
  req: ScopeRequest,
): Promise<ScopeSet> {
  if (!req.orgId) return UNIVERSE;

  const membership = await orgService.getMembership(req.orgId, req.userId);
  const role = membership?.role ?? 'member';
  if (role === 'owner') return UNIVERSE;

  const orgAllowlist = await orgService.getToolAllowlist(req.orgId, vendorSlug, role);

  if (!config.features?.teamScoping || !req.teamId) {
    // Flag off OR no team context: org+role only (unchanged behavior).
    return orgAllowlist === null ? UNIVERSE : new Set(orgAllowlist);
  }

  // Flag on + team context: compose team allowlist into the effective scope.
  const teamAllowlist = await orgService.getTeamToolAllowlist(
    req.orgId,
    req.teamId,
    vendorSlug,
  );
  return effectiveScope(orgAllowlist, [
    { teamId: req.teamId, allowlist: teamAllowlist },
  ]);
}

/**
 * Convenience: filter a tools list against a resolved scope. Used by tools/list
 * paths across all three routers.
 */
export function filterToolsByScope<T extends { name: string }>(
  tools: readonly T[],
  scope: ScopeSet,
): T[] {
  if (scope === UNIVERSE) return [...tools];
  return tools.filter((t) => scopeAllows(scope, t.name));
}
