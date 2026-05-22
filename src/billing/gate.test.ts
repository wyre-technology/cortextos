import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultBillingGate, isPaidPlan, isServiceActive } from './gate.js';
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
    listServiceClients: vi.fn().mockResolvedValue([]),
    getSubscription: vi.fn<[string], unknown | null>(),
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
    it('returns the default plan limit for users with no orgs (Layer 1: conduit)', async () => {
      // Pre-Layer-1 default was free (limit 3). DOR §9.1 made conduit the
      // default (every new org is conduit-with-trial), so the "no-orgs"
      // fallback also picks up conduit. A user with truly zero orgs is an
      // edge case — they have no auth context for real requests anyway.
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const limit = await gate.getConnectionLimit('user-1');

      expect(limit).toBe(Infinity);
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
    it('returns the default plan rate limit for users with no orgs (Layer 1: conduit = 5000/hr)', async () => {
      // Same Layer 1 default shift as getConnectionLimit above.
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const limit = await gate.getRateLimit('user-1');

      expect(limit).toBe(5000);
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

  // -------------------------------------------------------------------------
  // canAccessPaidFeatures (Track A, mig 024) — composed gate
  //
  // Paired accept/reject tests for the dunning-aware composed gate.
  // Each gate-call-site (web/routes.ts requireTeamAccess, dashboard/routes.ts,
  // audit/routes.ts × 2) calls this method; testing it once at the helper
  // level covers all 4 sites under the Bug B sweep shape — one composed
  // predicate, paired accept/reject coverage.
  // -------------------------------------------------------------------------

  describe('canAccessPaidFeatures (dunning-aware composed gate)', () => {
    it('returns true: paid plan + active subscription', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'active',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns true: paid plan + past_due INSIDE grace window', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'past_due',
        first_failure_at: twoDaysAgo,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns false: paid plan + past_due PAST grace window', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'past_due',
        first_failure_at: eightDaysAgo,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(false);
    });

    it('returns false: paid plan + canceled subscription (terminal)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'canceled',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(false);
    });

    it('returns false: free plan (early-exit on tier check, no sub fetch needed)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'free' }));
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(false);
      // getSubscription should not have been called — early exit on tier
      expect(mockOrgService.getSubscription).not.toHaveBeenCalled();
    });

    it('returns true: paid plan + no subscription record (defensive — pre-checkout race)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));
      mockOrgService.getSubscription.mockResolvedValue(null);
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns true: business plan + trialing subscription', async () => {
      // business is also paid (PLAN_RANK >= pro); trialing is also active-ish
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'business' }));
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'trialing',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns false: org missing entirely', async () => {
      mockOrgService.getOrg.mockResolvedValue(null);
      expect(await gate.canAccessPaidFeatures('org-missing')).toBe(false);
    });
  });

  describe('getCreditAllocation', () => {
    // Layer 1 LOCKED DOR §4: paid orgs use CREDITS_PER_SEAT × creditSeats
    // where creditSeats = humans + agents. The arithmetic routes through
    // SeatService.getSeatBilling so credits + bill total + seat composition
    // single-source through one call. Free plan retains its flat catalog
    // allocation until WI-8 migration retires it.

    it('returns flat catalog allocation for legacy free orgs', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'free' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);

      const result = await gate.getCreditAllocation('org-1');

      // Free plan in default catalog has flat creditAllocation = 500;
      // member count is intentionally ignored on the legacy free path.
      expect(result).toBe(500);
    });

    it('conduit org: 2500 × creditSeats (humans + agents, included agents counted)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'conduit' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]);
      mockOrgService.listServiceClients.mockResolvedValue([{ clientId: 'x' }, { clientId: 'y' }]);

      const result = await gate.getCreditAllocation('org-1');

      // creditSeats = 3 humans + 2 agents = 5. Allocation = 2500 × 5.
      // Note: includedAgents (2 of 2) count toward the pool because the
      // base fee funds their credit allocation — DOR §3 locked.
      expect(result).toBe(12_500);
    });

    it('conduit org: agent #3 lifts pool by 2500 even though only 2 are billed', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'conduit' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }]);
      mockOrgService.listServiceClients.mockResolvedValue([{ clientId: 'x' }, { clientId: 'y' }, { clientId: 'z' }]);

      const result = await gate.getCreditAllocation('org-1');

      // creditSeats = 1 + 3 = 4. Allocation = 2500 × 4 = 10000.
      // billableSeats = 1 + max(0, 3−2) = 2 (humans+billedAgents); that
      // drives Stripe but not credits. This row pins the divergence.
      expect(result).toBe(10_000);
    });

    it('legacy pro/business orgs route through seat-service during migration window', async () => {
      // During the WI-8 migration window, legacy paid orgs whose plan
      // slug is still 'pro' or 'business' transitionally read 2500/seat —
      // not their old plan.creditAllocation rate. Once migrated to conduit
      // (WI-8) this distinction disappears entirely.
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'business' }));
      mockOrgService.getMembers.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);
      mockOrgService.listServiceClients.mockResolvedValue([]);

      const result = await gate.getCreditAllocation('org-1');

      // creditSeats = 2 + 0 = 2. Allocation = 2500 × 2 = 5000.
      expect(result).toBe(5_000);
    });

    it('empty conduit org (no members, no agents) → base only, no credits', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'conduit' }));
      mockOrgService.getMembers.mockResolvedValue([]);
      mockOrgService.listServiceClients.mockResolvedValue([]);

      const result = await gate.getCreditAllocation('org-1');

      // Degenerate but well-defined: 2500 × 0 = 0. The legacy
      // "treat zero seats as 1" floor is gone — a real org always has
      // at least one human (its owner) by construction.
      expect(result).toBe(0);
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

// ---------------------------------------------------------------------------
// isServiceActive — dunning-aware gate (Track A, mig 024)
//
// Paired accept/reject tests for each status branch + grace-window boundary.
// Tests cover Ruby's checkpoint-3 5-state lifecycle mapped to the boolean
// gate decision:
//   payment-failing / past-due / final-warning → isServiceActive=true
//   suspended → isServiceActive=false
//   recovered → status flips back to active → isServiceActive=true
// ---------------------------------------------------------------------------

describe('isServiceActive (dunning-aware gate)', () => {
  const NOW = new Date('2026-06-01T12:00:00Z');

  describe('admits when service should be live', () => {
    it('returns true for active subscription regardless of first_failure_at', () => {
      expect(
        isServiceActive({ status: 'active', first_failure_at: null }, 7, NOW),
      ).toBe(true);
    });

    it('returns true for trialing subscription', () => {
      expect(
        isServiceActive({ status: 'trialing', first_failure_at: null }, 7, NOW),
      ).toBe(true);
    });

    it('returns true for past_due INSIDE grace window (3 days into 7-day grace)', () => {
      const failedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: failedAt }, 7, NOW),
      ).toBe(true);
    });

    it('returns true for unpaid INSIDE grace window', () => {
      const failedAt = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
      expect(
        isServiceActive({ status: 'unpaid', first_failure_at: failedAt }, 7, NOW),
      ).toBe(true);
    });

    it('returns true for past_due with missing first_failure_at (race window)', () => {
      // Stripe flipped status but our webhook hasn't recorded first-failure yet.
      // Defensive: treat as just-entered-dunning. Brief window only.
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: null }, 7, NOW),
      ).toBe(true);
    });

    it('accepts ISO-string first_failure_at (DB return shape)', () => {
      const failedAtIso = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: failedAtIso }, 7, NOW),
      ).toBe(true);
    });

    it('returns true when subscription is null (free-tier orgs handled by isPaidPlan)', () => {
      // isServiceActive doesn't enforce the paid-vs-free distinction; that's
      // isPaidPlan's job. Returning true here prevents free-tier orgs from
      // being falsely flagged as suspended.
      expect(isServiceActive(null, 7, NOW)).toBe(true);
    });
  });

  describe('refuses when service should be suspended', () => {
    it('returns false for past_due PAST grace window (8 days into 7-day grace)', () => {
      const failedAt = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: failedAt }, 7, NOW),
      ).toBe(false);
    });

    it('returns false for unpaid PAST grace window', () => {
      const failedAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
      expect(
        isServiceActive({ status: 'unpaid', first_failure_at: failedAt }, 7, NOW),
      ).toBe(false);
    });

    it('returns false for canceled regardless of timing', () => {
      expect(
        isServiceActive({ status: 'canceled', first_failure_at: null }, 7, NOW),
      ).toBe(false);
    });

    it('returns false for incomplete_expired terminal state', () => {
      expect(
        isServiceActive({ status: 'incomplete_expired', first_failure_at: null }, 7, NOW),
      ).toBe(false);
    });

    it('returns false for unknown status (fail-closed)', () => {
      expect(
        isServiceActive({ status: 'some_future_status', first_failure_at: null }, 7, NOW),
      ).toBe(false);
    });
  });

  describe('grace-window boundary', () => {
    it('returns true at exactly grace-1 second (just inside window)', () => {
      const justInside = new Date(NOW.getTime() - (7 * 24 * 60 * 60 * 1000 - 1000));
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: justInside }, 7, NOW),
      ).toBe(true);
    });

    it('returns false at exactly grace-end (boundary is exclusive)', () => {
      const exactly = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: exactly }, 7, NOW),
      ).toBe(false);
    });

    it('honors custom grace days (1-day for testing)', () => {
      const failedAt = new Date(NOW.getTime() - 12 * 60 * 60 * 1000); // 12h ago
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: failedAt }, 1, NOW),
      ).toBe(true);
      // Same first_failure_at, status, but grace=0 → past window
      expect(
        isServiceActive({ status: 'past_due', first_failure_at: failedAt }, 0, NOW),
      ).toBe(false);
    });
  });
});
