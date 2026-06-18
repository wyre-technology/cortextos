// Test-layer single-source-pin for SeatBilling fixtures.
//
// Built around the canonical `computeSeatBilling` (the same pure derivation
// production reads) so tests cannot drift from the live shape — if the
// canonical fields change, every fixture moves with it, no per-test
// hand-built object to update. Same shape as the subscription-factory
// pattern dev uses for Stripe-side tests.
//
// Usage:
//   makeSeatBilling(5, 2)
//     → 5 humans + 2 agents, no discounts ($672/mo at flat-pricing).
//   makeSeatBilling(5, 2, [{ reason:'eap', appliesTo:'org_fee', percent:100,
//                           grantedBy:'admin-x', grantedAt:'2026-06-18…' }])
//     → same seats, base waived ($273/mo from $39×7, baseCents=0).
// The fixture passes through to computeSeatBilling so the discount math
// is the same applyDiscounts() the production path takes (boss msg-
// 1781749682091 — shared-helper, divergence-impossible by construction).

import { computeSeatBilling, type SeatBilling } from '../../../billing/seat-service.js';
import type { OrgDiscount } from '../../../billing/discounts.js';

export function makeSeatBilling(
  humans: number,
  agents: number,
  discounts: ReadonlyArray<OrgDiscount> = [],
): SeatBilling {
  return computeSeatBilling({ humans, agents }, discounts);
}

/**
 * Test-only EAP discount row. Use with makeSeatBilling for any test that
 * needs an org-fee-waived snapshot. Timestamps are static so equality
 * tests stay deterministic.
 */
export const EAP_WAIVER: OrgDiscount = Object.freeze({
  reason: 'eap',
  appliesTo: 'org_fee',
  percent: 100,
  grantedBy: 'test-admin',
  grantedAt: '2026-06-18T00:00:00.000Z',
});
