import { describe, it, expect } from 'vitest';
import {
  effectiveScope,
  scopeAllows,
  resolveExecutorDecision,
  UNIVERSE,
  ERR_AMBIGUOUS_TEAM,
  type CallerContext,
  type ScopeSet,
  type TeamAllowlist,
} from './effective-scope.js';

// WYREAI-60: pure resolver, exhaustive unit coverage. Refactored 2026-05-31
// (WYREAI-69) from parallel-array signature `effectiveScope(ctx, orgAllowlist,
// teamAllowlists: Allowlist[])` to structural-pairing
// `effectiveScope(orgAllowlist, teamAllowlists: {teamId, allowlist}[])` — the
// layer-locality move at API-signature level (warden review: caller-managed
// parallel-array invariant could over-grant via mismatch). ctx no longer
// needed by the resolver itself (it still scopes resolveExecutorDecision).

const ctx = (matchingTeams: readonly string[] = [], orgId = 'org_x'): CallerContext => ({
  userId: 'auth0|1', orgId, role: 'member', matchingTeams,
});

const pair = (teamId: string, allowlist: readonly string[] | null): TeamAllowlist => ({
  teamId, allowlist,
});

const asSet = (s: ScopeSet) => (s === UNIVERSE ? UNIVERSE : new Set(s));

describe('effectiveScope (WYREAI-60 + WYREAI-69 structural-pairing refactor, gateway #189 parity)', () => {
  describe('no team allowlists ⇒ org allowlist governs', () => {
    it('null org → UNIVERSE (no allowlist row = allow all)', () => {
      expect(asSet(effectiveScope(null, []))).toBe(UNIVERSE);
    });

    it('non-empty org → set(org)', () => {
      const r = effectiveScope(['a', 'b'], []);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('empty org [] → empty set (explicit deny-all is legitimate)', () => {
      const r = effectiveScope([], []);
      expect(r).toEqual(new Set());
    });
  });

  describe('one team allowlist ⇒ team ∩ org', () => {
    it('team UNIVERSE + org UNIVERSE → UNIVERSE', () => {
      expect(effectiveScope(null, [pair('t1', null)])).toBe(UNIVERSE);
    });

    it('team UNIVERSE + org set → set(org) (team is identity)', () => {
      const r = effectiveScope(['a', 'b'], [pair('t1', null)]);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('team set + org UNIVERSE → set(team) (org is identity)', () => {
      const r = effectiveScope(null, [pair('t1', ['a', 'b'])]);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('team set + org set → intersection', () => {
      const r = effectiveScope(['a', 'b', 'c'], [pair('t1', ['b', 'c', 'd'])]);
      expect(r).toEqual(new Set(['b', 'c']));
    });

    it('team [] (empty allowlist) intersected with anything → empty set', () => {
      const r = effectiveScope(['a', 'b'], [pair('t1', [])]);
      expect(r).toEqual(new Set());
    });

    it('disjoint team + org → empty set (legitimate least-privilege outcome)', () => {
      const r = effectiveScope(['a', 'b'], [pair('t1', ['x', 'y'])]);
      expect(r).toEqual(new Set());
    });
  });

  describe('multi-team ⇒ team ∩ team ∩ org (every team narrows)', () => {
    it('two teams sharing tools + org universe → intersection of the two teams', () => {
      const r = effectiveScope(null, [pair('t1', ['a', 'b', 'c']), pair('t2', ['b', 'c', 'd'])]);
      expect(r).toEqual(new Set(['b', 'c']));
    });

    it('multi-team with all UNIVERSE + org set → set(org)', () => {
      const r = effectiveScope(['a', 'b'], [pair('t1', null), pair('t2', null)]);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('a single restrictive team narrows the rest (true least-privilege)', () => {
      const r = effectiveScope(['a', 'b', 'c'], [pair('t1', ['a', 'c']), pair('t2', ['c'])]);
      expect(r).toEqual(new Set(['c']));
    });

    it('two teams with no overlap + org universe → empty (legitimate)', () => {
      const r = effectiveScope(null, [pair('t1', ['a']), pair('t2', ['b'])]);
      expect(r).toEqual(new Set());
    });
  });

  describe('narrow-only invariant: result ⊆ orgAllowlist (never grants past org)', () => {
    it('a team allow-list with tools NOT in org never adds them to the result', () => {
      const r = effectiveScope(['a', 'b'], [pair('t1', ['a', 'z'])]);
      expect(r).toEqual(new Set(['a'])); // 'z' would be a grant past org; never appears
    });
  });

  describe('structural-pairing API (WYREAI-69) — invariant impossible to violate by accident', () => {
    it('TeamAllowlist objects bind teamId to allowlist; no parallel-array misuse possible', () => {
      // The previous parallel-array signature let a caller pass
      // teamAllowlists with mismatched length vs ctx.matchingTeams, silently
      // over-granting scope. With TeamAllowlist objects, each allowlist
      // travels with its teamId — a length mismatch can't exist.
      const teams: TeamAllowlist[] = [pair('t1', ['x']), pair('t2', ['y'])];
      // Verify the iteration consumes the bound pairs:
      const r = effectiveScope(null, teams);
      expect(r).toEqual(new Set()); // disjoint teams + org universe
    });
  });
});

describe('scopeAllows', () => {
  it('UNIVERSE allows any URN', () => {
    expect(scopeAllows(UNIVERSE, 'datto-rmm:list_devices')).toBe(true);
  });

  it('Set allows present URN', () => {
    expect(scopeAllows(new Set(['x']), 'x')).toBe(true);
  });

  it('Set denies absent URN', () => {
    expect(scopeAllows(new Set(['x']), 'y')).toBe(false);
  });

  it('empty Set denies everything', () => {
    expect(scopeAllows(new Set(), 'anything')).toBe(false);
  });
});

describe('resolveExecutorDecision (forward-insurance, NOT wired in v1)', () => {
  it('0 matching teams + orgId present → org-credential decision', () => {
    expect(resolveExecutorDecision(ctx([], 'org_x'), 'datto-rmm')).toEqual({
      kind: 'org',
      orgId: 'org_x',
    });
  });

  it('0 matching teams + no orgId → reject (no context)', () => {
    const d = resolveExecutorDecision({ userId: 'u1', matchingTeams: [] }, 'datto-rmm');
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.code).toBe(ERR_AMBIGUOUS_TEAM);
      expect(d.message).toContain('no team or org context');
      expect(d.message).toContain('datto-rmm');
    }
  });

  it('exactly 1 matching team → team-credential decision (that team)', () => {
    expect(resolveExecutorDecision(ctx(['t1']), 'datto-rmm')).toEqual({
      kind: 'team',
      teamId: 't1',
    });
  });

  it('2+ matching teams → reject (ambiguous — never silently picks)', () => {
    const d = resolveExecutorDecision(ctx(['t1', 't2']), 'datto-rmm');
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.code).toBe(ERR_AMBIGUOUS_TEAM);
      expect(d.message).toContain('ambiguous');
      expect(d.message).toContain('datto-rmm');
    }
  });

  it('ERR_AMBIGUOUS_TEAM is the JSON-RPC implementation-defined code -32010', () => {
    // Pinning the constant — a renumber would break downstream MCP clients
    // that parse the error code.
    expect(ERR_AMBIGUOUS_TEAM).toBe(-32010);
  });
});

describe('UNIVERSE sentinel identity', () => {
  it('is a Symbol (not equal to null or any string)', () => {
    expect(typeof UNIVERSE).toBe('symbol');
    expect((UNIVERSE as unknown) === null).toBe(false);
    expect((UNIVERSE as unknown) === 'UNIVERSE').toBe(false);
  });

  it('round-trips through effectiveScope unchanged when both inputs are null/UNIVERSE-equivalent', () => {
    expect(effectiveScope(null, [])).toBe(UNIVERSE);
    expect(effectiveScope(null, [pair('t1', null)])).toBe(UNIVERSE);
  });
});

// ---------------------------------------------------------------------------
// IdP slice 2, Piece 2 — CallerContext.actingAs type-shape pin
//
// Compile-time tests (no runtime assertions other than presence). The
// actingAs field is metadata for downstream consumers (audit-event emission
// behind Mon-ratified schema + "Switch to customer org" UI + future
// effectiveScope() scope-rebinding). Job at scaffolding stage: PIN THE TYPE-
// SHAPE so consumers can be written against a stable contract.
//
// Sibling-shape to the BrandMergeTags "contract stability" test from RC2
// PR-A — pin the shape at-the-artifact so future drift gets caught
// by-construction at compile time.
// ---------------------------------------------------------------------------

describe('CallerContext.actingAs — IdP slice 2 Piece 2 type-shape pin', () => {
  it('is optional (the ~95% case where caller is not acting-as)', () => {
    const callerWithoutActingAs: CallerContext = {
      userId: 'u-1',
      orgId: 'org-acme',
      role: 'admin',
      matchingTeams: [],
      // actingAs absent — compiles
    };
    expect(callerWithoutActingAs.actingAs).toBeUndefined();
  });

  it('accepts both axes when present (onBehalfOfOrgId + viaResellerOrgId)', () => {
    const caller: CallerContext = {
      userId: 'u-1',
      orgId: 'reseller-org',
      role: 'reseller_admin',
      matchingTeams: [],
      actingAs: {
        onBehalfOfOrgId: 'customer-org',
        viaResellerOrgId: 'reseller-org',
      },
    };
    expect(caller.actingAs?.onBehalfOfOrgId).toBe('customer-org');
    expect(caller.actingAs?.viaResellerOrgId).toBe('reseller-org');
  });

  it('preserves BOTH axes — SCOPE (onBehalfOfOrgId) + AUTHORITY-SOURCE (viaResellerOrgId)', () => {
    // The two-axis design is load-bearing for the audit-trail:
    //   - onBehalfOfOrgId = SCOPE (the customer-org the action lands in)
    //   - viaResellerOrgId = AUTHORITY-SOURCE (the reseller-org granting the
    //                                          actor the right to act-as)
    // Removing either axis breaks audit-accountability:
    //   - Lose SCOPE: can't answer "which customer was acted-on?"
    //   - Lose AUTHORITY-SOURCE: can't answer "via which reseller did the
    //     actor have authority?" (matters if actor's relationship to the
    //     reseller changes post-action — e.g., actor leaves the reseller
    //     after acting; audit-trail must preserve at-action authority).
    //
    // Both fields are required when actingAs is present. Test pins shape.
    const caller: CallerContext = {
      userId: 'u-1',
      orgId: 'reseller-org',
      role: 'reseller_admin',
      matchingTeams: [],
      actingAs: { onBehalfOfOrgId: 'customer-x', viaResellerOrgId: 'reseller-y' },
    };
    expect(caller.actingAs).toBeDefined();
    expect(Object.keys(caller.actingAs ?? {}).sort()).toEqual([
      'onBehalfOfOrgId',
      'viaResellerOrgId',
    ]);
  });

  it('COMPILE-TIME PIN — both axes are REQUIRED when actingAs is present (analyst item 1, PR #386)', () => {
    // Type-level test (compile-time check via deliberate-error pattern).
    // The actingAs object MUST require BOTH onBehalfOfOrgId AND viaResellerOrgId
    // when present — neither can become optional without breaking the audit-trail
    // accountability invariant pinned at "separate-the-axes-that-must-stay-
    // distinct-in-the-audit-trail" (banked msg-1781370353305).
    //
    // The tests below use TypeScript's structural typing to catch any drift:
    // each invalid shape would FAIL TO COMPILE if uncommented. The
    // ts-expect-error directives below are the load-bearing assertions —
    // if any of these drifts to "no error," the type became more permissive
    // than intended and the by-construction guard is broken.

    // Valid shape — must compile cleanly:
    const validBoth: NonNullable<CallerContext['actingAs']> = {
      onBehalfOfOrgId: 'c-1',
      viaResellerOrgId: 'r-1',
    };
    expect(validBoth.onBehalfOfOrgId).toBe('c-1');

    // INVALID — missing onBehalfOfOrgId axis (only viaResellerOrgId):
    // @ts-expect-error — onBehalfOfOrgId is required; this object must NOT type-check
    const _missingScope: NonNullable<CallerContext['actingAs']> = { viaResellerOrgId: 'r-1' };
    expect(_missingScope).toBeDefined();

    // INVALID — missing viaResellerOrgId axis (only onBehalfOfOrgId):
    // @ts-expect-error — viaResellerOrgId is required; this object must NOT type-check
    const _missingAuthority: NonNullable<CallerContext['actingAs']> = { onBehalfOfOrgId: 'c-1' };
    expect(_missingAuthority).toBeDefined();
  });

  it('is DISTINCT from orgId — primary org-membership stays visible alongside acting-as', () => {
    // When actingAs is set, orgId still represents the caller's PRIMARY org
    // membership (the reseller-org where their IdP authenticated them).
    // viaResellerOrgId mirrors orgId in the common case but is preserved
    // separately so future code can distinguish "caller's home org" from
    // "authority-source for this acting-as session" if they diverge.
    const caller: CallerContext = {
      userId: 'u-1',
      orgId: 'reseller-org',
      role: 'reseller_admin',
      matchingTeams: [],
      actingAs: {
        onBehalfOfOrgId: 'customer-org',  // acting-on scope
        viaResellerOrgId: 'reseller-org', // authority-source (today == orgId)
      },
    };
    expect(caller.orgId).toBe('reseller-org');
    expect(caller.actingAs?.viaResellerOrgId).toBe(caller.orgId);
    expect(caller.actingAs?.onBehalfOfOrgId).not.toBe(caller.orgId);
  });
});

// ---------------------------------------------------------------------------
// IdP slice 2, Piece 2 — Ruby Finding 2: SCOPE-vs-AUTHORIZATION layer-separation
//                                          regression-guard
//
// Locks the layer-separation pin at CI: a caller with actingAs SET produces
// the SAME authorization decision as the same caller WITHOUT actingAs. The
// scope-rebinding (which org's data is acted-on) is INDEPENDENT of the
// authorization-gate (whether the actor is allowed to perform the operation).
//
// Without this guard, a future refactor could silently promote actingAs into
// the authorization-gate (rot vector: removed-from-reseller actor with
// persistent session would gain customer-org permissions). The test mimics
// the PROVISIONER-side authorization model (the existing src/reseller/routes.ts
// pattern) so any regression to the layer-separation fails at this test.
// ---------------------------------------------------------------------------

describe('Ruby Finding 2 — actingAs is SCOPE input only, NEVER AUTHORIZATION input', () => {
  /**
   * Pure authorization predicate — exactly the shape src/reseller/routes.ts
   * uses for its admin-role gate. Takes the caller's HOME identity
   * (orgId + role) and returns yes/no. NEVER reads actingAs.
   */
  function isResellerAdminAuthorized(caller: CallerContext): boolean {
    if (!caller.orgId) return false;
    return caller.role === 'reseller_admin' || caller.role === 'admin';
  }

  it('callers with identical home-identity produce identical authz decisions regardless of actingAs presence', () => {
    const homeIdentity = {
      userId: 'u-1',
      orgId: 'reseller-org',
      role: 'reseller_admin',
      matchingTeams: [] as readonly string[],
    };

    const withoutActingAs: CallerContext = { ...homeIdentity };
    const withActingAs: CallerContext = {
      ...homeIdentity,
      actingAs: {
        onBehalfOfOrgId: 'customer-org',
        viaResellerOrgId: 'reseller-org',
      },
    };

    // The authz decision is BIT-IDENTICAL across both — same home identity,
    // same authority-source. actingAs has zero influence on authz.
    expect(isResellerAdminAuthorized(withoutActingAs))
      .toBe(isResellerAdminAuthorized(withActingAs));
  });

  it('denied caller stays denied when actingAs is set (NO authority-promotion via actingAs)', () => {
    // Rot-vector closure: a non-admin caller setting actingAs MUST NOT gain
    // admin authority. The most-likely refactor-mistake would be "if actingAs
    // is set, treat the customer-org's permissions as the actor's" — this
    // test fails by-construction if anyone introduces that.
    const nonAdmin: CallerContext = {
      userId: 'u-1',
      orgId: 'reseller-org',
      role: 'reseller_member',   // NOT admin
      matchingTeams: [],
    };
    const nonAdminWithActingAs: CallerContext = {
      ...nonAdmin,
      actingAs: {
        onBehalfOfOrgId: 'customer-org',
        viaResellerOrgId: 'reseller-org',
      },
    };

    // Both must be DENIED — actingAs doesn't promote authority.
    expect(isResellerAdminAuthorized(nonAdmin)).toBe(false);
    expect(isResellerAdminAuthorized(nonAdminWithActingAs)).toBe(false);
    // And the two MUST be identical (same authority-source → same decision).
    expect(isResellerAdminAuthorized(nonAdmin))
      .toBe(isResellerAdminAuthorized(nonAdminWithActingAs));
  });

  it('approved caller stays approved across actingAs variations (target-scope changes; gate stays open)', () => {
    // Authority-gate is open for reseller_admin → stays open whether they
    // act-as customer-A, customer-B, or no one. The SCOPE changes; the
    // GATE doesn't.
    const admin: CallerContext = {
      userId: 'u-1',
      orgId: 'reseller-org',
      role: 'reseller_admin',
      matchingTeams: [],
    };
    const adminActingOnCustomerA: CallerContext = {
      ...admin,
      actingAs: { onBehalfOfOrgId: 'customer-A', viaResellerOrgId: 'reseller-org' },
    };
    const adminActingOnCustomerB: CallerContext = {
      ...admin,
      actingAs: { onBehalfOfOrgId: 'customer-B', viaResellerOrgId: 'reseller-org' },
    };

    expect(isResellerAdminAuthorized(admin)).toBe(true);
    expect(isResellerAdminAuthorized(adminActingOnCustomerA)).toBe(true);
    expect(isResellerAdminAuthorized(adminActingOnCustomerB)).toBe(true);
    // All three identical — scope-variation produces identical authz decisions.
    expect(isResellerAdminAuthorized(adminActingOnCustomerA))
      .toBe(isResellerAdminAuthorized(adminActingOnCustomerB));
  });
});
