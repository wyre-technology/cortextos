// Layer 1 — seat-billing view object.
//
// The single data seam between Hank's billing data-layer and Pearl's §8
// customer-facing UI, locked per the LOCKED decision-of-record §3/§10
// (2026-05-20-layer-1-model-LOCKED-decision-of-record.md).
//
// One paid model: monthly bill = $600 base + $20 × billableSeats.
//   billableSeats = humans + max(0, agents − 2)   — Stripe per-unit qty
//   creditSeats   = humans + agents               — credit-pool basis
// The first 2 agent (service-client) seats are included in the base ($0);
// the 3rd agent onward bills at $20. Human seats bill $20 from seat 1.
//
// CONTRACT: the data layer single-sources the seat MATH and the price
// constants and emits cents + integers — never a formatted string. The UI
// single-sources presentation and never recomputes seat math. The real
// `getSeatBilling(orgId)` (Hank's group A — counts org_members +
// service_clients, then derives) supersedes `mockSeatBilling` below; both
// return this exact `SeatBilling` shape.

/** The locked seat-billing view object. Cents + integers only. */
export interface SeatBilling {
  /** org_members count. */
  humans: number;
  /** service_clients (agent) count. */
  agents: number;
  /** humans + max(0, agents − 2) — the Stripe per-unit quantity. */
  billableSeats: number;
  /** humans + agents — the credit-pool basis (2500 credits/seat). */
  creditSeats: number;
  /** min(agents, 2) — agent seats covered by the base ($0). */
  includedAgentCount: number;
  /** max(0, agents − 2) — agent seats that add a $20 line. */
  billedAgentCount: number;
  /** Flat per-org base, in cents (60000 = $600). */
  basePriceCents: number;
  /** Per-billable-seat price, in cents (2000 = $20). */
  perSeatPriceCents: number;
}

/** Locked price constants (decision-of-record §1). */
export const BASE_PRICE_CENTS = 60_000;
export const PER_SEAT_PRICE_CENTS = 2_000;
/** Agent seats included in the base (decision-of-record §2). */
export const INCLUDED_AGENT_SEATS = 2;

/**
 * Mock `getSeatBilling` — derives the view object from a raw
 * `{ humans, agents }` pair. Used by §8 UI development, previews, and
 * tests until Hank's real `getSeatBilling(orgId)` (group A) lands and the
 * `/org/billing` route swaps to it. The derivation here mirrors the locked
 * formulas so the mock is faithful; the real function does the DB counts.
 */
export function mockSeatBilling(humans: number, agents: number): SeatBilling {
  const billedAgentCount = Math.max(0, agents - INCLUDED_AGENT_SEATS);
  return {
    humans,
    agents,
    billableSeats: humans + billedAgentCount,
    creditSeats: humans + agents,
    includedAgentCount: Math.min(agents, INCLUDED_AGENT_SEATS),
    billedAgentCount,
    basePriceCents: BASE_PRICE_CENTS,
    perSeatPriceCents: PER_SEAT_PRICE_CENTS,
  };
}
