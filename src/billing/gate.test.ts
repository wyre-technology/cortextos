import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultBillingGate, isPaidPlan, isServiceActive } from './gate.js';
import { ANTI_ABUSE_RATE_PER_HOUR } from './prices.js';
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
    plan: 'conduit',
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

describe('DefaultBillingGate (flat-pricing — one plan)', () => {
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
  // getUserPlan — collapses to the one plan regardless of stored slug
  // -------------------------------------------------------------------------

  describe('getUserPlan', () => {
    it('always returns "conduit" (no tier ranking across orgs)', async () => {
      // Flat-pricing: there is nothing to rank. resolveUserPlan ignores the
      // org set entirely; every user is on the one plan.
      expect(await gate.getUserPlan('user-1')).toBe('conduit');
    });

    it('returns "conduit" even for a user with no orgs', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);
      expect(await gate.getUserPlan('user-1')).toBe('conduit');
    });
  });

  // -------------------------------------------------------------------------
  // getConnectionLimit — unlimited, flat
  // -------------------------------------------------------------------------

  describe('getConnectionLimit', () => {
    it('returns Infinity (everything-included)', async () => {
      expect(await gate.getConnectionLimit('user-1')).toBe(Infinity);
    });
  });

  // -------------------------------------------------------------------------
  // getRateLimit — flat anti-abuse ceiling, divorced from the plan object
  // -------------------------------------------------------------------------

  describe('getRateLimit', () => {
    it('returns the flat anti-abuse ceiling for every user', async () => {
      expect(await gate.getRateLimit('user-1')).toBe(ANTI_ABUSE_RATE_PER_HOUR);
    });
  });

  // -------------------------------------------------------------------------
  // canUseTeamFeatures / canAddMember — always true (everything-included)
  // -------------------------------------------------------------------------

  describe('canUseTeamFeatures', () => {
    it('returns true (team features are included in the flat plan)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      expect(await gate.canUseTeamFeatures('org-1')).toBe(true);
    });
  });

  describe('canAddMember', () => {
    it('returns true (unlimited members in the flat plan)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      expect(await gate.canAddMember('org-1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // canAccessPaidFeatures — composed paid-AND-service-active gate
  //
  // Post-flat, isPaidPlan is true for any resolvable slug, so the access
  // decision flows entirely through the dunning-aware service check
  // (subscriptions.status). Org-missing is the only "not paid" path.
  // -------------------------------------------------------------------------

  describe('canAccessPaidFeatures (dunning-aware composed gate)', () => {
    it('returns true: active subscription', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'active',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns true: trialing subscription', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'trialing',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns true: past_due INSIDE grace window', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'past_due',
        first_failure_at: twoDaysAgo,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('returns false: past_due PAST grace window', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'past_due',
        first_failure_at: eightDaysAgo,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(false);
    });

    it('returns false: canceled subscription (terminal)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'canceled',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(false);
    });

    it('returns true: no subscription record (defensive — pre-checkout / net-new race)', async () => {
      // Post-flat every org is paid, so the no-sub branch is the defensive
      // path for an org whose seed/checkout subscription row has not landed
      // yet. isServiceActive returns true on null so a brand-new org is not
      // falsely suspended.
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue(null);
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(true);
    });

    it('legacy "free" slug resolves to paid — service governed by subscription, not tier', async () => {
      // An un-migrated org row still carrying plan='free' resolves to the
      // flat plan (isPaidPlan true), so access flows through the dunning
      // check rather than early-exiting on tier. With a canceled sub it is
      // denied — the slug no longer short-circuits the decision.
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'free' }));
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'canceled',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAccessPaidFeatures('org-1')).toBe(false);
    });

    it('returns false: org missing entirely (no resolvable plan)', async () => {
      mockOrgService.getOrg.mockResolvedValue(null);
      expect(await gate.canAccessPaidFeatures('org-missing')).toBe(false);
      // No subscription fetch — early exit on the unresolvable-plan check.
      expect(mockOrgService.getSubscription).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// isPaidPlan — post-flat, true for any resolvable slug
//
// Flat-pricing has one plan and no free tier. Any org carrying a resolvable
// plan slug — including a legacy 'free'/'pro'/'business' value on an
// un-migrated row — is "on the plan". Only genuinely-absent input is not
// paid. The service-delivery decision is the separate dunning question
// (isServiceActive); canAccessPaidFeatures composes both.
// ---------------------------------------------------------------------------

describe('isPaidPlan', () => {
  it('returns true for conduit', () => {
    expect(isPaidPlan('conduit')).toBe(true);
  });

  it('returns true for legacy free/pro/business slugs (resolve to the flat plan)', () => {
    expect(isPaidPlan('free')).toBe(true);
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('business')).toBe(true);
  });

  it('returns false for undefined plan (no-org case)', () => {
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it('returns false for null plan', () => {
    expect(isPaidPlan(null)).toBe(false);
  });

  it('returns false for empty-string plan', () => {
    expect(isPaidPlan('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isServiceActive — dunning-aware gate (unchanged by flat-pricing)
//
// Paired accept/reject tests for each status branch + grace-window boundary.
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

    it('returns true when subscription is null (net-new / pre-checkout — not suspended)', () => {
      // isServiceActive doesn't enforce paid-vs-unresolvable; that's isPaidPlan's
      // job. Returning true here prevents a brand-new org (whose seed row has
      // not landed) from being falsely flagged as suspended.
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
