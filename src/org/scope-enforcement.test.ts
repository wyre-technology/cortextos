import { describe, it, expect, vi } from 'vitest';

// composeToolScope tests for WYREAI-61. The unified-router.test.ts already
// exercises the helper through full request paths under flag-OFF (org+role
// only — its existing allowlist filtering tests stay green after the refactor,
// proving wiring intact across cli/unified/aggregated by composition-identity
// argument). These tests exercise composeToolScope ITSELF — especially the
// flag-ON team-scope branch + the owner-bypass + the no-orgId UNIVERSE
// shortcut — which are not naturally hit by router tests.
//
// Full E2E integration on the three routers (flag-on path through the wire)
// is the fast-follow WYREAI-70.

// Mock config so we can flip the flag per test.
vi.mock('../config.js', () => ({
  config: { features: { teamScoping: false } },
}));

// Import AFTER the mock so the helper picks up the mocked config.
import { composeToolScope, UNIVERSE, type ScopeSet } from './scope-enforcement.js';
import { config } from '../config.js';

function makeOrgService(overrides: Partial<{
  getMembership: (orgId: string, userId: string) => Promise<{ role: string } | null>;
  getToolAllowlist: (orgId: string, vendorSlug: string, role: string) => Promise<string[] | null>;
  getTeamToolAllowlist: (orgId: string, teamId: string, vendorSlug: string) => Promise<string[] | null>;
}> = {}) {
  return {
    getMembership: overrides.getMembership ?? (async () => ({ role: 'member' })),
    getToolAllowlist: overrides.getToolAllowlist ?? (async () => null),
    getTeamToolAllowlist: overrides.getTeamToolAllowlist ?? (async () => null),
    // Cast: the test only consumes the three methods composeToolScope calls.
  } as unknown as import('./org-service.js').OrgService;
}

const asSet = (s: ScopeSet) => (s === UNIVERSE ? UNIVERSE : Array.from(s).sort());

describe('composeToolScope (WYREAI-61 helper)', () => {
  describe('flag-off (CONDUIT_TEAM_SCOPING absent) — pre-refactor behavior, byte-for-byte', () => {
    it('no orgId → UNIVERSE (unscoped request)', async () => {
      const svc = makeOrgService();
      const scope = await composeToolScope(svc, 'autotask', { userId: 'u1' });
      expect(scope).toBe(UNIVERSE);
    });

    it('owner role → UNIVERSE (owner-bypass)', async () => {
      const svc = makeOrgService({
        getMembership: async () => ({ role: 'owner' }),
        getToolAllowlist: vi.fn().mockResolvedValue(['x']),
      });
      const scope = await composeToolScope(svc, 'autotask', { userId: 'u1', orgId: 'org-1' });
      expect(scope).toBe(UNIVERSE);
      // Sanity: owner short-circuits — getToolAllowlist should not be reached.
      expect(svc.getToolAllowlist).not.toHaveBeenCalled();
    });

    it('member role + null allowlist → UNIVERSE', async () => {
      const svc = makeOrgService({
        getMembership: async () => ({ role: 'member' }),
        getToolAllowlist: async () => null,
      });
      const scope = await composeToolScope(svc, 'autotask', { userId: 'u1', orgId: 'org-1' });
      expect(scope).toBe(UNIVERSE);
    });

    it('member role + allowlist → Set(allowlist)', async () => {
      const svc = makeOrgService({
        getMembership: async () => ({ role: 'member' }),
        getToolAllowlist: async () => ['list_tickets', 'create_ticket'],
      });
      const scope = await composeToolScope(svc, 'autotask', { userId: 'u1', orgId: 'org-1' });
      expect(asSet(scope)).toEqual(['create_ticket', 'list_tickets']);
    });

    it('admin role + allowlist → Set(allowlist) (admin gets a separate role row)', async () => {
      const svc = makeOrgService({
        getMembership: async () => ({ role: 'admin' }),
        getToolAllowlist: vi.fn().mockResolvedValue(['list_tickets', 'create_ticket', 'delete_ticket']),
      });
      const scope = await composeToolScope(svc, 'autotask', { userId: 'u1', orgId: 'org-1' });
      expect(asSet(scope)).toEqual(['create_ticket', 'delete_ticket', 'list_tickets']);
      // Confirm the call carried the admin role (the per-role allowlist semantic).
      expect(svc.getToolAllowlist).toHaveBeenCalledWith('org-1', 'autotask', 'admin');
    });

    it('teamId present but flag-off → team allowlist is NOT consulted (existing behavior)', async () => {
      const svc = makeOrgService({
        getMembership: async () => ({ role: 'member' }),
        getToolAllowlist: async () => ['a', 'b'],
        getTeamToolAllowlist: vi.fn().mockResolvedValue(['only_a']),
      });
      const scope = await composeToolScope(svc, 'autotask', {
        userId: 'u1', orgId: 'org-1', teamId: 't1',
      });
      expect(asSet(scope)).toEqual(['a', 'b']);
      expect(svc.getTeamToolAllowlist).not.toHaveBeenCalled();
    });
  });

  describe('flag-on (CONDUIT_TEAM_SCOPING=true) — team-scope intersect kicks in', () => {
    // Toggle the mocked flag for these tests.
    const flagOn = () => { (config.features as { teamScoping: boolean }).teamScoping = true; };
    const flagOff = () => { (config.features as { teamScoping: boolean }).teamScoping = false; };

    it('teamId present + team allowlist → team ∩ org', async () => {
      flagOn();
      try {
        const svc = makeOrgService({
          getMembership: async () => ({ role: 'member' }),
          getToolAllowlist: async () => ['a', 'b', 'c'],
          getTeamToolAllowlist: async () => ['b', 'c', 'z'],
        });
        const scope = await composeToolScope(svc, 'autotask', {
          userId: 'u1', orgId: 'org-1', teamId: 't1',
        });
        // 'z' would be a grant past org → never in result. 'b','c' are the intersection.
        expect(asSet(scope)).toEqual(['b', 'c']);
      } finally {
        flagOff();
      }
    });

    it('teamId present + team allowlist NULL → org allowlist passes through (team is UNIVERSE identity)', async () => {
      flagOn();
      try {
        const svc = makeOrgService({
          getMembership: async () => ({ role: 'member' }),
          getToolAllowlist: async () => ['a', 'b'],
          getTeamToolAllowlist: async () => null,
        });
        const scope = await composeToolScope(svc, 'autotask', {
          userId: 'u1', orgId: 'org-1', teamId: 't1',
        });
        expect(asSet(scope)).toEqual(['a', 'b']);
      } finally {
        flagOff();
      }
    });

    it('teamId present + team allowlist [] (empty) → empty set (legitimate explicit deny)', async () => {
      flagOn();
      try {
        const svc = makeOrgService({
          getMembership: async () => ({ role: 'member' }),
          getToolAllowlist: async () => ['a', 'b'],
          getTeamToolAllowlist: async () => [],
        });
        const scope = await composeToolScope(svc, 'autotask', {
          userId: 'u1', orgId: 'org-1', teamId: 't1',
        });
        expect(asSet(scope)).toEqual([]);
      } finally {
        flagOff();
      }
    });

    it('flag-on but NO teamId → org allowlist only (same as flag-off — team-scope only fires with team context)', async () => {
      flagOn();
      try {
        const svc = makeOrgService({
          getMembership: async () => ({ role: 'member' }),
          getToolAllowlist: async () => ['a', 'b'],
          getTeamToolAllowlist: vi.fn().mockResolvedValue(['only_a']),
        });
        const scope = await composeToolScope(svc, 'autotask', {
          userId: 'u1', orgId: 'org-1', // no teamId
        });
        expect(asSet(scope)).toEqual(['a', 'b']);
        expect(svc.getTeamToolAllowlist).not.toHaveBeenCalled();
      } finally {
        flagOff();
      }
    });
  });

  describe('defensive: handles malformed config gracefully', () => {
    it('config.features missing entirely → treats flag as off (no TypeError)', async () => {
      // Simulate a stale/test config without features:
      const orig = config.features;
      (config as { features?: unknown }).features = undefined;
      try {
        const svc = makeOrgService({
          getMembership: async () => ({ role: 'member' }),
          getToolAllowlist: async () => ['a'],
        });
        const scope = await composeToolScope(svc, 'autotask', { userId: 'u1', orgId: 'org-1' });
        expect(asSet(scope)).toEqual(['a']);
      } finally {
        (config as { features?: unknown }).features = orig;
      }
    });
  });
});
