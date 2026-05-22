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
  /**
   * Launch-gate flag. When true (production), missing basePriceId or
   * seatPriceId at provisioner-construction time throws — failing boot
   * loud rather than silently creating new orgs without subscriptions.
   * When false (dev/test/CI), missing IDs preserve the silent-skip-with-
   * warn-log path. Set true via CONDUIT_BILLING_REQUIRED=true in prod env.
   *
   * Pinned by ruby (msg 1779412681446) + boss disposition: default-permissive
   * -in-dev / rot-class-in-prod behavior gets its OWN env flag, prod-set,
   * boot-fail-loud when violated. Same family as wire-proven boot-asserts.
   */
  required?: boolean;
}

/**
 * Thrown at boot when CONDUIT_BILLING_REQUIRED=true but the Stripe price
 * IDs are missing. Named so src/index.ts (or tests) can identify it and
 * the message names both fixes per the named-actionable-choice discipline.
 */
export class ConduitBillingConfigError extends Error {
  constructor(missing: { basePrice: boolean; seatPrice: boolean }) {
    const which = [
      missing.basePrice ? 'STRIPE_CONDUIT_BASE_PRICE_ID' : null,
      missing.seatPrice ? 'STRIPE_CONDUIT_SEAT_PRICE_ID' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    super(
      `CONDUIT_BILLING_REQUIRED=true but ${which} not set; verify Azure Key Vault provisioning OR unset CONDUIT_BILLING_REQUIRED for dev/test.`,
    );
    this.name = 'ConduitBillingConfigError';
  }
}

/**
 * Builds the production conduit provisioner. Captured at OrgService
 * construction time; called once per org created. The function reads the
 * just-inserted org's seat counts via seatService.getSeatBilling (a brand-
 * new standalone org always has 1 human + 0 agents = billableSeats=1) and
 * passes them into createTrialingSubscription verbatim.
 *
 * Boot-time validation (Layer 1 launch-gate): if `required` is true and
 * either price ID is unset, throws ConduitBillingConfigError synchronously
 * from this factory call — caller in src/index.ts hits the throw during
 * module init and the process fails loud. With `required` false (default),
 * a missing price ID makes the returned provisioner return null at invoke
 * time, which createOrg interprets as "skip the Stripe attach."
 */
export function createConduitBillingProvisioner(
  deps: ConduitProvisionerDeps,
): OrgBillingProvisioner {
  const missing = { basePrice: !deps.basePriceId, seatPrice: !deps.seatPriceId };
  if (deps.required && (missing.basePrice || missing.seatPrice)) {
    throw new ConduitBillingConfigError(missing);
  }

  return async ({ orgId, orgName, ownerEmail }) => {
    if (!deps.basePriceId || !deps.seatPriceId) {
      // Dev/test path: refuse to provision against empty price IDs (would
      // orphan a half-created Stripe customer with empty product refs).
      // In prod the boot-time guard above catches this; if execution
      // reaches here with empty IDs, it's a dev/test environment by
      // CONDUIT_BILLING_REQUIRED's signal — silent-skip is the right move.
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
