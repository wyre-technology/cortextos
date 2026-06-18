/**
 * SeatService — single source of truth for Layer 1 seat counts and the
 * composed monthly billing snapshot.
 *
 * Per LOCKED DOR (2026-05-20) + PR-A spec (2026-05-22) + AGENTS-BILLABLE
 * decision (boss msg-1781747082415, 2026-06-17, WYREAI-25):
 *
 *   billableSeats     = humans + max(0, agents − INCLUDED_AGENT_SEATS)
 *   monthlyTotalCents = ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats
 *
 * Flat-pricing (Aaron 2026-05-26): no tiers, no credits, no call-gating.
 * The credit pool / monthlyCreditAllocation is removed. The Shape-A agent
 * inclusion (first INCLUDED_AGENT_SEATS agents free) is REMOVED at Aaron's
 * 2026-06-17 GO: INCLUDED_AGENT_SEATS = 0. Every agent bills from seat 1,
 * identical to a human. The formula structure is unchanged for shape-
 * stability; the inclusion-mechanic stays at 0 so a future promotional
 * inclusion lands by bumping the const without re-wiring this function.
 *
 * TRIAL-END CHARGE CONTRACT (ruby 2026-05-22, amplified by boss):
 *   getSeatBilling is a deterministic function of {humans, agents}. At
 *   trial_end the first Stripe invoice MUST equal getSeatBilling(orgId)
 *   .monthlyTotalCents evaluated AT trial_end. The customer-facing trial
 *   banner (#203) and the first Stripe charge call the SAME function —
 *   never parallel arithmetic paths. This is enforced structurally: every
 *   consumer (banner, Stripe sub-create, Stripe sub-update, invoice
 *   preview, gate's credit allocation) receives the same frozen
 *   SeatBilling snapshot. No call site recomputes from raw counts.
 */

import type { OrgService } from '../org/org-service.js';
import {
  ORG_FEE_CENTS,
  INCLUDED_AGENT_SEATS,
  PER_SEAT_PRICE_CENTS,
} from './prices.js';
import {
  applyDiscounts,
  type OrgDiscount,
  type OrgDiscountService,
} from './discounts.js';

export interface SeatCounts {
  /** Active org_members rows. Each human bills at PER_SEAT_PRICE_CENTS from seat 1. */
  readonly humans: number;
  /** Active service_clients rows. Each agent bills at PER_SEAT_PRICE_CENTS from seat 1 (identical to humans; no free-agent tier). */
  readonly agents: number;
}

export interface SeatBilling {
  readonly counts: SeatCounts;
  /** humans + max(0, agents − INCLUDED_AGENT_SEATS) — Stripe per-unit quantity. With INCLUDED_AGENT_SEATS=0, this reduces to humans + agents. */
  readonly billableSeats: number;
  /** Of agents present, how many fall inside the inclusion (0..INCLUDED_AGENT_SEATS). Today INCLUDED_AGENT_SEATS=0, so this is always 0. Kept for shape-stability. */
  readonly includedAgents: number;
  /** Of agents present, how many are billed (agents − includedAgents). With includedAgents=0, this is always = agents. */
  readonly billedAgents: number;
  /**
   * ORG_FEE_CENTS portion of the bill AFTER any org_fee-scope discounts
   * (EAP today; see src/billing/discounts.ts). For an org with no discounts
   * this equals ORG_FEE_CENTS. For an EAP-waived org this equals 0 — the
   * subscription-factory uses that as the structural signal to OMIT the
   * basePriceId from Stripe items[] entirely (no Stripe coupon needed).
   */
  readonly baseCents: number;
  /** PER_SEAT_PRICE_CENTS × billableSeats. Unaffected by org_fee-scope
   *  discounts; reduced only by invoice_total-scope discounts ((c) ship). */
  readonly seatTotalCents: number;
  /** baseCents + seatTotalCents AFTER invoice_total discounts. This is the
   *  number the customer is charged each month — the single source for
   *  both the billing-card display and the Stripe first-invoice total. */
  readonly monthlyTotalCents: number;
  /**
   * The discount rows that fed applyDiscounts on this snapshot, frozen for
   * the consuming render+Stripe surfaces. Empty array on un-discounted
   * orgs. Used by team-billing.ts to render the grant-applied badge and
   * by subscription-factory.ts to translate org_fee=100% into item
   * omission. The ARRAY is the SoT — display, audit-trail-viewer pedigree,
   * and Stripe-derivation all consume the same rows.
   */
  readonly discounts: ReadonlyArray<OrgDiscount>;
}

export interface SeatService {
  /**
   * Raw {humans, agents} pair from the org's authoritative records.
   * Pure of derived counts — derivations live exclusively in computeSeatBilling
   * so the inclusion-and-pricing rules cannot drift between call sites.
   */
  getSeatCounts(orgId: string): Promise<SeatCounts>;

  /**
   * Composed billing snapshot for an org. Deterministic function of
   * {humans, agents} at the moment of evaluation. ALL consumers
   * (billing banner, Stripe subscription-create, Stripe subscription-update,
   * invoice-preview) call this — no
   * parallel arithmetic. Trial-end charge contract enforced by construction:
   * Stripe webhook and trial-banner both receive the same snapshot at
   * trial_end timestamp.
   */
  getSeatBilling(orgId: string): Promise<SeatBilling>;

  /**
   * Pure variant — same arithmetic, no I/O. For callers that already hold
   * counts: tests; Pearl's banner with mocked inputs; the S3 at-creation
   * preview that computes the post-add SeatBilling before the mutation
   * commits.
   */
  computeSeatBilling(counts: SeatCounts): SeatBilling;
}

/**
 * Pure arithmetic — no I/O, no class methods. Exported separately so
 * tests, previews, and the S3 consequence-copy renderer all hit the same
 * function as production. Same input + same discounts ⇒ same output, by
 * construction.
 *
 * `discounts` defaults to an empty array so call sites that genuinely
 * have no discount context (test fixtures, the at-creation S3 preview
 * BEFORE an org exists to grant against) keep the prior shape. Production
 * call sites coming through DefaultSeatService receive the org's actual
 * rows via OrgDiscountService — applyDiscounts is the single math path
 * regardless.
 */
export function computeSeatBilling(
  counts: SeatCounts,
  discounts: ReadonlyArray<OrgDiscount> = [],
): SeatBilling {
  const humans = Math.max(0, counts.humans | 0);
  const agents = Math.max(0, counts.agents | 0);

  const includedAgents = Math.min(agents, INCLUDED_AGENT_SEATS);
  const billedAgents = agents - includedAgents;
  const billableSeats = humans + billedAgents;

  const seatTotalCents = PER_SEAT_PRICE_CENTS * billableSeats;
  const bill = applyDiscounts(ORG_FEE_CENTS, seatTotalCents, discounts);

  return Object.freeze({
    counts: Object.freeze({ humans, agents }),
    billableSeats,
    includedAgents,
    billedAgents,
    baseCents: bill.baseCents,
    seatTotalCents: bill.seatTotalCents,
    monthlyTotalCents: bill.monthlyTotalCents,
    discounts: bill.appliedDiscounts,
  });
}

export class DefaultSeatService implements SeatService {
  constructor(
    private orgService: OrgService,
    /**
     * Optional discount-row source. When omitted, getSeatBilling behaves
     * exactly as before (no discounts applied) — back-compat for callers
     * not yet wired with the org_discounts SoT. Production composition
     * (deps factory) passes a DefaultOrgDiscountService so EAP grants on
     * an org take effect at every consumer.
     */
    private discountService?: OrgDiscountService,
  ) {}

  async getSeatCounts(orgId: string): Promise<SeatCounts> {
    // Sequential awaits — NOT Promise.all — per the #196/#199/#201
    // reserved-tx hang class: Promise.all of service-method calls on a
    // request-path-reserved-tx connection can stall. getSeatBilling is on
    // the hot path of every seat-mutation via
    // seat-syncer, and standalone-org creation via the billing provisioner
    // — all request-path. The conservative serialization costs one extra
    // round-trip on a single connection (negligible) and refuses the hang
    // class structurally rather than relying on "Promise.all happens to
    // work here." Caught by pearl's comment-anchored discipline at the
    // PR-A consumer call sites (ruby msg 1779441145372) post-Layer-1
    // merge — same shape as the standing analyst checklist axis.
    const members = await this.orgService.getMembers(orgId);
    const serviceClients = await this.orgService.listServiceClients(orgId);
    return { humans: members.length, agents: serviceClients.length };
  }

  async getSeatBilling(orgId: string): Promise<SeatBilling> {
    // Sequential awaits — same reserved-tx-hang discipline as
    // getSeatCounts. Discount-row fetch is a single indexed read on
    // (org_id, reason) so latency is negligible.
    const counts = await this.getSeatCounts(orgId);
    const discounts =
      (await this.discountService?.getDiscounts(orgId)) ?? [];
    return computeSeatBilling(counts, discounts);
  }

  computeSeatBilling(counts: SeatCounts): SeatBilling {
    return computeSeatBilling(counts);
  }
}
