import { describe, it, expect } from 'vitest';
import {
  effectiveScope,
  scopeAllows,
  resolveExecutorDecision,
  UNIVERSE,
  ERR_AMBIGUOUS_TEAM,
  type CallerContext,
  type ScopeSet,
} from './effective-scope.js';

// WYREAI-60: pure resolver, exhaustive unit coverage. No DB, no service —
// these tests pin the structural correctness of the team ∩ org narrow-only
// intersection + the safety-gated executor decision shape.

const ctx = (matchingTeams: readonly string[] = [], orgId = 'org_x'): CallerContext => ({
  userId: 'auth0|1', orgId, role: 'member', matchingTeams,
});

const asSet = (s: ScopeSet) => (s === UNIVERSE ? UNIVERSE : new Set(s));

describe('effectiveScope (WYREAI-60, parity port of gateway #189 resolver)', () => {
  describe('no matching teams ⇒ org allowlist governs', () => {
    it('null org → UNIVERSE (no allowlist row = allow all)', () => {
      expect(asSet(effectiveScope(ctx([]), null, []))).toBe(UNIVERSE);
    });

    it('non-empty org → set(org)', () => {
      const r = effectiveScope(ctx([]), ['a', 'b'], []);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('empty org [] → empty set (explicit deny-all is legitimate)', () => {
      const r = effectiveScope(ctx([]), [], []);
      expect(r).toEqual(new Set());
    });
  });

  describe('one matching team ⇒ team ∩ org', () => {
    it('team UNIVERSE + org UNIVERSE → UNIVERSE', () => {
      expect(effectiveScope(ctx(['t1']), null, [null])).toBe(UNIVERSE);
    });

    it('team UNIVERSE + org set → set(org) (team is identity)', () => {
      const r = effectiveScope(ctx(['t1']), ['a', 'b'], [null]);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('team set + org UNIVERSE → set(team) (org is identity)', () => {
      const r = effectiveScope(ctx(['t1']), null, [['a', 'b']]);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('team set + org set → intersection', () => {
      const r = effectiveScope(ctx(['t1']), ['a', 'b', 'c'], [['b', 'c', 'd']]);
      expect(r).toEqual(new Set(['b', 'c']));
    });

    it('team [] (empty allowlist) intersected with anything → empty set', () => {
      const r = effectiveScope(ctx(['t1']), ['a', 'b'], [[]]);
      expect(r).toEqual(new Set());
    });

    it('disjoint team + org → empty set (legitimate least-privilege outcome)', () => {
      const r = effectiveScope(ctx(['t1']), ['a', 'b'], [['x', 'y']]);
      expect(r).toEqual(new Set());
    });
  });

  describe('multi-team ⇒ team ∩ team ∩ org (every team narrows)', () => {
    it('two teams sharing tools + org universe → intersection of the two teams', () => {
      const r = effectiveScope(ctx(['t1', 't2']), null, [['a', 'b', 'c'], ['b', 'c', 'd']]);
      expect(r).toEqual(new Set(['b', 'c']));
    });

    it('multi-team with all UNIVERSE + org set → set(org)', () => {
      const r = effectiveScope(ctx(['t1', 't2']), ['a', 'b'], [null, null]);
      expect(r).toEqual(new Set(['a', 'b']));
    });

    it('a single restrictive team narrows the rest (true least-privilege)', () => {
      const r = effectiveScope(ctx(['t1', 't2']), ['a', 'b', 'c'], [['a', 'c'], ['c']]);
      expect(r).toEqual(new Set(['c']));
    });

    it('two teams with no overlap + org universe → empty (legitimate)', () => {
      const r = effectiveScope(ctx(['t1', 't2']), null, [['a'], ['b']]);
      expect(r).toEqual(new Set());
    });
  });

  describe('narrow-only invariant: result ⊆ orgAllowlist (never grants past org)', () => {
    it('a team allow-list with tools NOT in org never adds them to the result', () => {
      const r = effectiveScope(ctx(['t1']), ['a', 'b'], [['a', 'z']]);
      expect(r).toEqual(new Set(['a'])); // 'z' would be a grant past org; never appears
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
    expect(effectiveScope(ctx([]), null, [])).toBe(UNIVERSE);
    expect(effectiveScope(ctx(['t1']), null, [null])).toBe(UNIVERSE);
  });
});
