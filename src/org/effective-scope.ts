/**
 * Per-team tool scoping — the pure resolver spine (WYREAI-60, parity port of
 * gateway PR #189). Two concerns, deliberately separated:
 *
 *   - effectiveScope(): WHAT tools are visible/callable. Pure set logic,
 *     least-privilege intersection across all matching teams ∩ org.
 *   - resolveExecutorDecision(): WHICH credential executes a call. Safety-
 *     gated — under BYOC each team's credential authenticates as a DIFFERENT
 *     vendor account, so a multi-team-same-vendor user is REJECTED rather
 *     than having an account silently chosen (which could write to the wrong
 *     client/billing).
 *
 * Both are pure functions over already-resolved data so they can be unit-
 * tested exhaustively and called identically by enforcement (WYREAI-61), any
 * downstream awareness layer, and a future router. Aaron-locked decisions
 * (per gateway #189 source — same conduit-side: precedence = team ∩ org;
 * multi-team = option (b) least-privilege; executor = reject-ambiguous in v1).
 *
 * Data substrate (sibling WYREAI-59, merged): a row in org_tool_allowlist is
 * EITHER team-scoped (team_id NOT NULL, role NULL) OR role-scoped (team_id
 * NULL, role NOT NULL) — never both/neither, enforced by the CHECK XOR.
 * `ToolAllowlistService.getTeamToolAllowlist` returns the team-scoped list
 * (string[] or null); the role-scoped getToolAllowlist mirrors it. This
 * resolver consumes whatever each caller has fetched — it does not query.
 */

/** Sentinel meaning "all of the vendor's tools are allowed" (an unscoped allowlist). */
export const UNIVERSE = Symbol('UNIVERSE');
export type ScopeSet = ReadonlySet<string> | typeof UNIVERSE;

/**
 * A single allowlist as stored: an array of capability identifiers, or `null`
 * meaning "no allowlist row" — which today's getToolAllowlist treats as "all".
 *
 * KEYING (v1): entries are the un-prefixed vendor tool name; together with the
 * vendor_slug column they compose the capability URN `{vendor_slug}:{tool}`.
 * Conduit's proxy exposes tools as `{slug}__{tool}` (cli-router.ts + unified-
 * router.ts) but enforcement matches on the un-prefixed name on both hooks,
 * so the stored form lines up.
 *
 * RENAME BEHAVIOR (v1 = FAILS CLOSED, by design — acceptable): if a vendor
 * renames a tool, the old allowlist entry stops matching, so the tool falls
 * OUT of scope (unavailable until an admin re-adds it under the new name).
 * That is the SAFE direction — it never silently GRANTS or fails open.
 * `aliasOf` rename-bridging (old→new) is a documented FAST-FOLLOW; this key
 * is additive-compatible with it (alias resolution happens before the scope
 * check — no allowlist migration).
 */
export type Allowlist = readonly string[] | null;

/** Resolved once per request; consumed identically by every scope/credential caller. */
export interface CallerContext {
  userId: string;
  orgId?: string;
  role?: string;
  /** Teams the caller belongs to that hold creds for the vendor AND pass hasServerAccess. */
  matchingTeams: readonly string[];
}

function toScopeSet(list: Allowlist): ScopeSet {
  if (list === null) return UNIVERSE;
  return new Set<string>(list);
}

function intersect(a: ScopeSet, b: ScopeSet): ScopeSet {
  if (a === UNIVERSE) return b;
  if (b === UNIVERSE) return a;
  const out = new Set<string>();
  for (const urn of a) if (b.has(urn)) out.add(urn);
  return out;
}

/**
 * Per-team allowlist bound to its team id. The structural pairing
 * makes the (teamId, allowlist) correspondence inexpressible-when-wrong:
 * a caller cannot mismatch parallel arrays because there are no parallel
 * arrays — each team's id travels with its allowlist (WYREAI-69, the
 * layer-locality refactor at API-signature level).
 */
export interface TeamAllowlist {
  teamId: string;
  allowlist: Allowlist;
}

/**
 * effectiveScope = orgAllowlist ∩ (⋂ teamAllowlist for each matching team).
 *
 * - A team with no allowlist contributes UNIVERSE (identity — doesn't narrow),
 *   consistent with the single-team "inherit org" rule.
 * - No matching teams ⇒ the org allowlist governs (org-credential path).
 * - An empty result is ALLOWED and EXPECTED: a multi-team user may legitimately
 *   see fewer tools than either team alone (true least-privilege).
 *
 * UNIVERSE is never materialized into the live tool list here; callers
 * interpret it as "allow all", exactly as a `null` from getToolAllowlist
 * works today.
 *
 * SIGNATURE NOTE: `teamAllowlists` is a `{teamId, allowlist}[]` object array,
 * NOT a parallel array zipped against `ctx.matchingTeams`. This is the
 * WYREAI-69 layer-locality move: at the API-signature layer the structural
 * type makes the invariant impossible to violate by accident (see warden
 * review of WYREAI-60 — caller-managed parallel-array invariant could
 * over-grant via mismatch). `ctx.matchingTeams` remains on `CallerContext`
 * for the executor-decision path; the resolver itself iterates the bound
 * pairs in `teamAllowlists`.
 */
export function effectiveScope(
  orgAllowlist: Allowlist,
  teamAllowlists: readonly TeamAllowlist[],
): ScopeSet {
  const orgSet = toScopeSet(orgAllowlist);
  if (teamAllowlists.length === 0) return orgSet;

  let acc = orgSet;
  for (const { allowlist } of teamAllowlists) {
    acc = intersect(acc, toScopeSet(allowlist));
  }
  return acc;
}

/** Whether a capability URN is permitted under a resolved scope. */
export function scopeAllows(scope: ScopeSet, urn: string): boolean {
  return scope === UNIVERSE || scope.has(urn);
}

/** JSON-RPC error code for an ambiguous multi-team execution context. */
export const ERR_AMBIGUOUS_TEAM = -32010;

export type ExecutorDecision =
  | { kind: 'org'; orgId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'reject'; code: typeof ERR_AMBIGUOUS_TEAM; message: string };

/**
 * Decide which credential executes a call — SAFETY-gated, never a silent pick.
 *
 *   0 matching teams → org credential
 *   1 matching team  → that team's credential
 *   2+ matching teams → REJECT (ambiguous: distinct BYOC accounts, refuse to guess)
 *
 * NOT WIRED IN v1 — FORWARD-INSURANCE per gateway #189. Under the single-
 * team-per-person ruling, the credential-injection layer collapses a 2+-team
 * match to the org tier upstream, so the caller context that reaches scope/
 * credential resolution never carries 2+ teams — the reject branch here is
 * currently UNREACHABLE. v1's actual behavior for the (shouldn't-happen)
 * 2+-team case is therefore org-scope fallback (safe: org creds, no wrong-
 * account pick). This function is defined + tested so it's ready the moment
 * per-(team,vendor) tool addressing can surface true multi-team ambiguity to
 * it. Wiring it earlier would require the injection path to stop collapsing
 * to org — i.e. undo the scope reduction the single-team ruling deliberately
 * bought.
 */
export function resolveExecutorDecision(ctx: CallerContext, vendorSlug: string): ExecutorDecision {
  switch (ctx.matchingTeams.length) {
    case 0:
      if (!ctx.orgId) {
        return {
          kind: 'reject',
          code: ERR_AMBIGUOUS_TEAM,
          message: `no team or org context for ${vendorSlug}`,
        };
      }
      return { kind: 'org', orgId: ctx.orgId };
    case 1:
      return { kind: 'team', teamId: ctx.matchingTeams[0] };
    default:
      return {
        kind: 'reject',
        code: ERR_AMBIGUOUS_TEAM,
        message: `ambiguous team context for ${vendorSlug}: specify team`,
      };
  }
}
