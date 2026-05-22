/**
 * Org billing provisioner — the seam between createOrg and the Stripe
 * trialing-subscription factory.
 *
 * Per LOCKED DOR §9.1 + ruby Q4 ratify (msg 1779411593149), Layer 1 org
 * creation attaches a paid `conduit` subscription with a 14-day trial
 * at the moment the org row is inserted — no more unpaid `free` default.
 * The Stripe coupling is injected at OrgService construction time so:
 *   - Production (src/index.ts) wires the real Stripe + seat-service path.
 *   - Tests omit it; createOrg becomes a no-op past the DB inserts.
 *
 * Order of operations (ratified): org INSERT → owner-member INSERT →
 * provision(...) → persist returned IDs onto the org row.
 *
 * Idempotency is enforced inside createTrialingSubscription (orgId-bound
 * keys on both customer + subscription creates) so a transient failure
 * between Stripe call and the org-row UPDATE is recoverable by retry —
 * the second call returns the same Stripe objects rather than duplicates.
 */

import type Stripe from 'stripe';
import { createTrialingSubscription } from '../billing/subscription-factory.js';
import type { SeatService } from '../billing/seat-service.js';

export interface OrgBillingProvisionInputs {
  /** The newly-inserted org's ID. Used in metadata and as the idempotency-key root. */
  orgId: string;
  /** Org display name — surfaced on the Stripe customer for support readability. */
  orgName: string;
  /** Owner's email if known — Stripe sends trial-ending notifications to it. */
  ownerEmail?: string;
}

export interface OrgBillingProvisionResult {
  stripeCustomerId: string;
  stripeSubscriptionId: string;
}

/**
 * Injected into OrgService; called from createOrg AFTER the org row +
 * owner-member row are inserted, with the brand-new org's identity.
 * Returns the Stripe IDs to UPDATE onto the org row.
 *
 * Returning null is a controlled signal that no billing should attach
 * for this org (e.g. an org-type the provisioner declines to handle —
 * customer or reseller orgs billed via other paths). createOrg interprets
 * null as "skip the UPDATE", not as an error.
 */
export type OrgBillingProvisioner = (
  inputs: OrgBillingProvisionInputs,
) => Promise<OrgBillingProvisionResult | null>;

export interface ConduitProvisionerDeps {
  stripe: Stripe;
  seatService: SeatService;
  basePriceId: string;
  seatPriceId: string;
}

/**
 * Builds the production conduit provisioner. Captured at OrgService
 * construction time; called once per org created. The function reads the
 * just-inserted org's seat counts via seatService.getSeatBilling (a brand-
 * new standalone org always has 1 human + 0 agents = billableSeats=1) and
 * passes them into createTrialingSubscription verbatim.
 */
export function createConduitBillingProvisioner(
  deps: ConduitProvisionerDeps,
): OrgBillingProvisioner {
  return async ({ orgId, orgName, ownerEmail }) => {
    // Refuse to provision if the Stripe price IDs are unset — forge's
    // credential surface lands these as env vars; before that, we'd be
    // calling Stripe with empty strings. Better to skip than to fail noisily
    // and orphan a half-created Stripe customer.
    if (!deps.basePriceId || !deps.seatPriceId) {
      return null;
    }
    const seatBilling = await deps.seatService.getSeatBilling(orgId);
    const result = await createTrialingSubscription(deps.stripe, {
      orgId,
      customerEmail: ownerEmail,
      customerName: orgName,
      basePriceId: deps.basePriceId,
      seatPriceId: deps.seatPriceId,
      seatBilling,
    });
    return {
      stripeCustomerId: result.customerId,
      stripeSubscriptionId: result.subscriptionId,
    };
  };
}
