// Test-layer single-source-pin for SeatBilling fixtures.
//
// Built around the canonical `computeSeatBilling` (the same pure derivation
// production reads) so tests cannot drift from the live shape — if the
// canonical fields change, every fixture moves with it, no per-test
// hand-built object to update. Same shape as the subscription-factory
// pattern dev uses for Stripe-side tests.
//
// Usage: `makeSeatBilling(5, 2)` → a frozen SeatBilling for 5 humans + 2
// agents, derived identically to what the route handler builds at runtime.

import { computeSeatBilling, type SeatBilling } from '../../../billing/seat-service.js';

export function makeSeatBilling(humans: number, agents: number): SeatBilling {
  return computeSeatBilling({ humans, agents });
}
