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
  // canUseX / canAddMember — composed via canAccessPaidFeatures
  //
  // Every per-feature gate composes the dunning-aware paid-and-service-active
  // check at the gate.ts root (private checkFeature helper). A grace-elapsed
  // org (cutover-grace branch) or a Stripe-canceled org BOTH deny across
  // EVERY canUseX, by construction. Closes warden 2026-05-31 PR #291
  // composition-gap finding.
  // -------------------------------------------------------------------------

  describe('canUseTeamFeatures', () => {
    it('returns true (team features included; subscription active by default mock)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      expect(await gate.canUseTeamFeatures('org-1')).toBe(true);
    });

    it('returns false when canAccessPaidFeatures denies (canceled subscription)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'canceled',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canUseTeamFeatures('org-1')).toBe(false);
    });

    it('returns false on cutover-grace elapsed (trialing + cancel_at_period_end + past period_end)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'trialing',
        first_failure_at: null,
        recovered_at: null,
        cancel_at_period_end: true,
        current_period_end: new Date(Date.now() - 1 * 60 * 60 * 1000), // T−1h
      });
      expect(await gate.canUseTeamFeatures('org-1')).toBe(false);
    });
  });

  describe('canAddMember', () => {
    it('returns true (unlimited members + subscription active by default mock)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      expect(await gate.canAddMember('org-1')).toBe(true);
    });

    it('returns false when canAccessPaidFeatures denies (canceled subscription)', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg());
      mockOrgService.getSubscription.mockResolvedValue({
        status: 'canceled',
        first_failure_at: null,
        recovered_at: null,
      });
      expect(await gate.canAddMember('org-1')).toBe(false);
    });
  });

  describe('per-feature gates compose canAccessPaidFeatures uniformly', () => {
    // One table-driven assertion that each canUseX gate respects the
    // dunning-aware service check. Closes the warden composition-gap finding
    // at the gate-fleet level — every gate inherits the composition
    // by-construction (private checkFeature helper); a future-added gate
    // that DOESN'T compose would fail this contract.
    type FeatureGate = (g: DefaultBillingGate, orgId: string) => Promise<boolean>;
    const gates: Array<{ name: string; fn: FeatureGate }> = [
      { name: 'canUseTeamFeatures',   fn: (g, o) => g.canUseTeamFeatures(o) },
      { name: 'canUsePromptCapture',  fn: (g, o) => g.canUsePromptCapture(o) },
      { name: 'canUseLogShipping',    fn: (g, o) => g.canUseLogShipping(o) },
      { name: 'canUseAuditLogExport', fn: (g, o) => g.canUseAuditLogExport(o) },
      { name: 'canUseSso',            fn: (g, o) => g.canUseSso(o) },
      { name: 'canUseServiceClients', fn: (g, o) => g.canUseServiceClients(o) },
    ];

    for (const g of gates) {
      it(`${g.name} denies when subscription is canceled (composition holds)`, async () => {
        mockOrgService.getOrg.mockResolvedValue(makeOrg());
        mockOrgService.getSubscription.mockResolvedValue({
          status: 'canceled',
          first_failure_at: null,
          recovered_at: null,
        });
        expect(await g.fn(gate, 'org-1')).toBe(false);
      });

      it(`${g.name} denies when cutover-grace has elapsed (composition holds)`, async () => {
        mockOrgService.getOrg.mockResolvedValue(makeOrg());
        mockOrgService.getSubscription.mockResolvedValue({
          status: 'trialing',
          first_failure_at: null,
          recovered_at: null,
          cancel_at_period_end: true,
          current_period_end: new Date(Date.now() - 1 * 60 * 60 * 1000),
        });
        expect(await g.fn(gate, 'org-1')).toBe(false);
      });
    }
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

// ---------------------------------------------------------------------------
// isServiceActive — cutover-grace / cancel-at-period-end branch
//
// Aaron's 2026-05-29 free-org cutover policy: existing 'free'-plan mcpgw orgs
// get a 14-day decide-or-revert window post-cutover. The cutover script seeds
// a local subscriptions row with status='trialing', cancel_at_period_end=TRUE,
// current_period_end=cutover+14d. The gate decides at request-time:
// (status active/trialing) + cancel_at_period_end + past current_period_end
// → service DENIED. The flip is by-time-elapsed; no cron / no status-write.
//
// Asymmetric-pair shape (ruby's pin): a flagged row with a future period_end
// is ACTIVE (left assertion); the SAME flagged row with a past period_end is
// DENIED (right assertion). The unflagged row stays ACTIVE in both — the
// flag-off axis is independent. Three rot vectors closed by construction:
// (a) future devs flipping the deny on without the flag, (b) future devs
// removing the flag-check, (c) future devs forgetting the past-vs-future
// boundary direction.
// ---------------------------------------------------------------------------

describe('isServiceActive — cutover-grace / cancel-at-period-end branch', () => {
  const NOW = new Date('2026-06-15T12:00:00Z');
  const FUTURE = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000); // T+3d
  const PAST = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);        // T−1h

  it('admits: trialing + cancel_at_period_end=TRUE + period_end IN FUTURE (grace not yet elapsed)', () => {
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: true,
          current_period_end: FUTURE,
        },
        7,
        NOW,
      ),
    ).toBe(true);
  });

  it('denies: trialing + cancel_at_period_end=TRUE + period_end IN PAST (grace elapsed)', () => {
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: true,
          current_period_end: PAST,
        },
        7,
        NOW,
      ),
    ).toBe(false);
  });

  it('denies: active + cancel_at_period_end=TRUE + period_end IN PAST (Stripe scheduled-cancel parity)', () => {
    expect(
      isServiceActive(
        {
          status: 'active',
          first_failure_at: null,
          cancel_at_period_end: true,
          current_period_end: PAST,
        },
        7,
        NOW,
      ),
    ).toBe(false);
  });

  it('admits: trialing + cancel_at_period_end=FALSE + period_end IN PAST (flag off — regular trial)', () => {
    // A regular Stripe trial whose end has been reached: Stripe flips status
    // to active or past_due via webhook. Until that webhook lands the gate
    // should NOT deny solely on a past period_end — only the flag-on path
    // denies. The cancel_at_period_end-OFF axis is the third rot vector.
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: false,
          current_period_end: PAST,
        },
        7,
        NOW,
      ),
    ).toBe(true);
  });

  it('admits: trialing + cancel_at_period_end=NULL + period_end IN PAST (null flag treated as off)', () => {
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: null,
          current_period_end: PAST,
        },
        7,
        NOW,
      ),
    ).toBe(true);
  });

  it('admits: trialing + cancel_at_period_end=TRUE + period_end NULL (no defined end → conservative)', () => {
    // Defensive: a flag-on row without a defined period_end has no boundary
    // to evaluate against. Don't deny on insufficient data — denying would
    // suspend service for a row whose end-time is genuinely unknown.
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: true,
          current_period_end: null,
        },
        7,
        NOW,
      ),
    ).toBe(true);
  });

  it('accepts ISO-string current_period_end (DB return shape)', () => {
    const pastIso = PAST.toISOString();
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: true,
          current_period_end: pastIso,
        },
        7,
        NOW,
      ),
    ).toBe(false);
  });

  it('back-compat: rows without the new fields keep the legacy behavior (active/trialing → true)', () => {
    // Existing callers that only pass (status, first_failure_at) keep
    // working unchanged — the optional fields default to undefined and
    // isPastCancelAtPeriodEnd short-circuits on missing cancel_at_period_end.
    expect(
      isServiceActive(
        { status: 'trialing', first_failure_at: null },
        7,
        NOW,
      ),
    ).toBe(true);
    expect(
      isServiceActive(
        { status: 'active', first_failure_at: null },
        7,
        NOW,
      ),
    ).toBe(true);
  });

  it('boundary: at exactly current_period_end → DENIED (boundary inclusive on the deny side)', () => {
    // Matches the existing past_due grace-end behavior — exact boundary
    // hits the deny branch, not the admit branch. Asymmetric on purpose.
    expect(
      isServiceActive(
        {
          status: 'trialing',
          first_failure_at: null,
          cancel_at_period_end: true,
          current_period_end: NOW,
        },
        7,
        NOW,
      ),
    ).toBe(false);
  });
});
