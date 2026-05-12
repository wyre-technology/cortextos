import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultBillingGate, isPaidPlan } from './gate.js';
import type { OrgService } from '../org/org-service.js';
import type { Organization } from '../org/org-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Test Org',
    ownerId: 'user-1',
    plan: 'free',
    defaultServerAccess: 'none',
    promptCaptureEnabled: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    type: 'standalone',
    parentOrgId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultBillingGate', () => {
  let gate: DefaultBillingGate;
  const mockOrgService = {
    getUserOrgs: vi.fn<[string], Organization[]>(),
    getOrg: vi.fn<[string], Organization | null>(),
    getMembers: vi.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    gate = new DefaultBillingGate(mockOrgService as unknown as OrgService);
  });

  // -------------------------------------------------------------------------
  // getUserPlan
  // -------------------------------------------------------------------------

  describe('getUserPlan', () => {
    it('returns "pro" when user belongs to a pro org', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ id: 'org-1', plan: 'pro' }),
      ]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('pro');
      expect(mockOrgService.getUserOrgs).toHaveBeenCalledWith('user-1');
    });

    it('returns "pro" when at least one org is pro among several', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ id: 'org-1', plan: 'free' }),
        makeOrg({ id: 'org-2', plan: 'pro' }),
        makeOrg({ id: 'org-3', plan: 'free' }),
      ]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('pro');
    });

    it('returns "free" when no orgs are pro', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ id: 'org-1', plan: 'free' }),
        makeOrg({ id: 'org-2', plan: 'free' }),
      ]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('free');
    });

    it('returns "free" when user belongs to no orgs', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('free');
    });
  });

  // -------------------------------------------------------------------------
  // getConnectionLimit
  // -------------------------------------------------------------------------

  describe('getConnectionLimit', () => {
    it('returns 3 for free plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const limit = await gate.getConnectionLimit('user-1');

      expect(limit).toBe(3);
    });

    it('returns Infinity for pro plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ plan: 'pro' }),
      ]);

      const limit = await gate.getConnectionLimit('user-1');

      expect(limit).toBe(Infinity);
    });
  });

  // -------------------------------------------------------------------------
  // getRateLimit
  // -------------------------------------------------------------------------

  describe('getRateLimit', () => {
    it('returns 100 for free plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const limit = await gate.getRateLimit('user-1');

      expect(limit).toBe(100);
    });

    it('returns 1000 for pro plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ plan: 'pro' }),
      ]);

      const limit = await gate.getRateLimit('user-1');

      expect(limit).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // canUseTeamFeatures
  // -------------------------------------------------------------------------

  describe('canUseTeamFeatures', () => {
    it('returns true for a pro org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));

      const result = await gate.canUseTeamFeatures('org-1');

      expect(result).toBe(true);
      expect(mockOrgService.getOrg).toHaveBeenCalledWith('org-1');
    });

    it('returns false for a free org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'free' }));

      const result = await gate.canUseTeamFeatures('org-1');

      expect(result).toBe(false);
    });

    it('returns false when org does not exist', async () => {
      mockOrgService.getOrg.mockResolvedValue(null);

      const result = await gate.canUseTeamFeatures('nonexistent');

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // canAddMember (delegates to canUseTeamFeatures)
  // -------------------------------------------------------------------------

  describe('canAddMember', () => {
    it('returns true for a pro org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'pro' }));

      const result = await gate.canAddMember('org-1');

      expect(result).toBe(true);
    });

    it('returns false for a free org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'free' }));

      const result = await gate.canAddMember('org-1');

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getCreditAllocation
  // -------------------------------------------------------------------------

  describe('getCreditAllocation', () => {
    it('returns flat allocation for free orgs', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'free' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);

      const result = await gate.getCreditAllocation('org-1');

      expect(result).toBe(500);
    });

    it('multiplies pro allocation by seat count', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'pro' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]);

      const result = await gate.getCreditAllocation('org-1');

      expect(result).toBe(4500); // 1500 × 3
    });

    it('multiplies business allocation by seat count', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'business' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);

      const result = await gate.getCreditAllocation('org-1');

      expect(result).toBe(8000); // 4000 × 2
    });

    it('treats zero-member paid orgs as 1 seat', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'pro' }));
      mockOrgService.getMembers.mockResolvedValue([]);

      const result = await gate.getCreditAllocation('org-1');

      expect(result).toBe(1500);
    });
  });
});

// ---------------------------------------------------------------------------
// isPaidPlan — single source of truth for "team-features tier" gate
// ---------------------------------------------------------------------------
//
// Empirical origin (2026-05-11): requireTeamAccess used `plan !== "pro"`
// while renderLayout used `plan === "pro" || plan === "business"`. The
// strict-equality vs OR-set drift produced a business-plan-owner who saw
// the sidebar team-nav but had every click 302'd back to /settings.
//
// These tests guard the invariant: any plan with PLAN_RANK >= pro returns
// true; anything below or unknown returns false. Both call sites route
// through this helper so future plan tiers (e.g. "enterprise") pick up
// automatically without per-call-site edits.

describe('isPaidPlan', () => {
  it('returns false for free plan', () => {
    expect(isPaidPlan('free')).toBe(false);
  });

  it('returns true for pro plan', () => {
    expect(isPaidPlan('pro')).toBe(true);
  });

  it('returns true for business plan (the bug-fix evidence)', () => {
    expect(isPaidPlan('business')).toBe(true);
  });

  it('returns false for undefined plan (handles no-org case)', () => {
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it('returns false for null plan', () => {
    expect(isPaidPlan(null)).toBe(false);
  });

  it('returns false for unknown plan slug (defensive, e.g. legacy "enterprise" not in PLAN_RANK)', () => {
    // Cast forces an out-of-PLAN_RANK slug through the helper.
    expect(isPaidPlan('legacy-unknown' as never)).toBe(false);
  });

  // Regression guard against the original drift: the SAME helper must
  // return TRUE for every plan that renderLayout admits to the team-nav,
  // AND for every plan that requireTeamAccess admits to /org/*.
  // Listing them explicitly so a future "drop business from team-features"
  // decision fails THIS test and forces an explicit review.
  it('admits both pro and business — render/handler gate parity', () => {
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('business')).toBe(true);
  });
});
