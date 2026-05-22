/**
 * SeatService — single source of truth for Layer 1 seat counts and the
 * composed monthly billing snapshot.
 *
 * Per LOCKED DOR (2026-05-20) + PR-A spec (2026-05-22):
 *
 *   billableSeats     = humans + max(0, agents − INCLUDED_AGENT_SEATS)
 *   creditSeats       = humans + agents
 *   monthlyTotalCents = BASE_PRICE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats
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
  BASE_PRICE_CENTS,
  CREDITS_PER_SEAT,
  INCLUDED_AGENT_SEATS,
  PER_SEAT_PRICE_CENTS,
} from './prices.js';

export interface SeatCounts {
  /** Active org_members rows. Each human bills at PER_SEAT_PRICE_CENTS from seat 1. */
  readonly humans: number;
  /** Active service_clients rows. First INCLUDED_AGENT_SEATS included in base; rest bill. */
  readonly agents: number;
}

export interface SeatBilling {
  readonly counts: SeatCounts;
  /** humans + agents — drives the credit pool (every seat allocated, included counted). */
  readonly creditSeats: number;
  /** humans + max(0, agents − INCLUDED_AGENT_SEATS) — Stripe per-unit quantity. */
  readonly billableSeats: number;
  /** Of agents present, how many fall inside the inclusion (0..INCLUDED_AGENT_SEATS). */
  readonly includedAgents: number;
  /** Of agents present, how many are billed (agents − includedAgents). */
  readonly billedAgents: number;
  /** BASE_PRICE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats. */
  readonly monthlyTotalCents: number;
  /** CREDITS_PER_SEAT × creditSeats — the pooled monthly allocation. */
  readonly monthlyCreditAllocation: number;
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
   * invoice-preview, BillingGate.getCreditAllocation) call this — no
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
 * function as production. Same input ⇒ same output, by construction.
 */
export function computeSeatBilling(counts: SeatCounts): SeatBilling {
  const humans = Math.max(0, counts.humans | 0);
  const agents = Math.max(0, counts.agents | 0);

  const creditSeats = humans + agents;
  const includedAgents = Math.min(agents, INCLUDED_AGENT_SEATS);
  const billedAgents = agents - includedAgents;
  const billableSeats = humans + billedAgents;

  const monthlyTotalCents = BASE_PRICE_CENTS + PER_SEAT_PRICE_CENTS * billableSeats;
  const monthlyCreditAllocation = CREDITS_PER_SEAT * creditSeats;

  return Object.freeze({
    counts: Object.freeze({ humans, agents }),
    creditSeats,
    billableSeats,
    includedAgents,
    billedAgents,
    monthlyTotalCents,
    monthlyCreditAllocation,
  });
}

export class DefaultSeatService implements SeatService {
  constructor(private orgService: OrgService) {}

  async getSeatCounts(orgId: string): Promise<SeatCounts> {
    // Sequential awaits — NOT Promise.all — per the #196/#199/#201
    // reserved-tx hang class: Promise.all of service-method calls on a
    // request-path-reserved-tx connection can stall. getSeatBilling is on
    // the hot path of gate.getCreditAllocation, every seat-mutation via
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
    const counts = await this.getSeatCounts(orgId);
    return computeSeatBilling(counts);
  }

  computeSeatBilling(counts: SeatCounts): SeatBilling {
    return computeSeatBilling(counts);
  }
}
