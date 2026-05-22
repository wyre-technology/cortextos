/**
 * SeatSyncer — pushes seat-count changes to the Stripe seat-item quantity.
 *
 * Per LOCKED DOR §6: each of the four seat-change events (human add,
 * human remove, agent create, agent delete) recomputes billableSeats and
 * writes it to the org's Stripe subscription item. Five code sites map
 * to the four events (invitation-accept + domain-auto-join are both
 * "human added"); all five route through OrgService.syncSeats which
 * delegates to the injected SeatSyncer.
 *
 * Trialing-state proration suppression: per the trial-end contract
 * (ruby spec 2026-05-22 + L4 mid-trial integration test), seat changes
 * during the trial must NOT fire a partial-period charge. We pass
 * proration_behavior:'none' on EVERY subscriptionItems.update — works
 * the same for trialing and active subs. The L4 verifier in
 * trial-end-contract.integration.test.ts exercises the mid-trial path
 * end-to-end and is already in place; this module reuses the same
 * arithmetic via seatService.getSeatBilling (single source).
 *
 * Two-mode wiring (mirrors createConduitBillingProvisioner, item 1a):
 *   - CONDUIT_BILLING_REQUIRED=true (prod): missing seatPriceId throws
 *     at factory call → src/index.ts boot fails. Same wire-proven
 *     boot-assert family.
 *   - default (dev/test/CI): missing seatPriceId makes the syncer return
 *     null at invoke; OrgService.syncSeats treats null as "skip".
 */

import type Stripe from 'stripe';
import type { SeatService } from './seat-service.js';
import { ConduitBillingConfigError } from '../org/org-billing-provisioner.js';

/**
 * Called from OrgService after any of the 5 seat-mutation sites finishes
 * its DB write. orgId is the only input — the syncer reads getSeatBilling
 * AND the org's stripeSubscriptionId from the live state. Returns null
 * when no sync was performed (no subscription on org, or syncer disabled
 * for the environment); returns SeatSyncResult with the new quantity on
 * success.
 */
export type SeatSyncer = (orgId: string) => Promise<SeatSyncResult | null>;

export interface SeatSyncResult {
  /** The new billableSeats value pushed to Stripe. Same shape as SeatBilling.billableSeats. */
  newQuantity: number;
  /** The Stripe subscription_item ID that was updated. */
  subscriptionItemId: string;
}

export interface ConduitSeatSyncerDeps {
  stripe: Stripe;
  seatService: SeatService;
  /** Same env var as the provisioner — needed to identify the seat item
   *  on the existing subscription so we can update only that item, not
   *  the base item. */
  seatPriceId: string;
  /**
   * The injected getter for the org's Stripe subscription ID. Decoupled
   * from OrgService (which we can't depend on without a cycle) — src/index.ts
   * passes `(orgId) => orgService.getOrg(orgId).then(o => o?.stripeSubscriptionId ?? null)`.
   */
  getSubscriptionId: (orgId: string) => Promise<string | null>;
  /** Same launch-gate semantics as the provisioner (item 1a). */
  required?: boolean;
}

/**
 * Builds the production conduit seat-syncer. Same shape as
 * createConduitBillingProvisioner: env-gated boot-time validation,
 * silent-skip-at-invoke for dev/test, named-actionable-choice error
 * messages for required-mode misconfig.
 */
export function createConduitSeatSyncer(deps: ConduitSeatSyncerDeps): SeatSyncer {
  if (deps.required && !deps.seatPriceId) {
    throw new ConduitBillingConfigError({ basePrice: false, seatPrice: true });
  }

  return async (orgId) => {
    if (!deps.seatPriceId) return null;

    const subscriptionId = await deps.getSubscriptionId(orgId);
    if (!subscriptionId) {
      // No Stripe subscription on this org (legacy free, pre-Layer-1
      // migration, or provisioner-skipped at create time). Seat-sync is
      // a no-op — there is nothing to push the quantity to.
      return null;
    }

    const billing = await deps.seatService.getSeatBilling(orgId);

    // Find the seat item on the subscription. Two-item subscriptions have
    // a base item (qty 1, never changes) and a seat item (qty = billableSeats).
    // We must NOT touch the base item — only the seat item's quantity.
    const subscription = await deps.stripe.subscriptions.retrieve(subscriptionId);
    const seatItem = subscription.items.data.find((it) => it.price.id === deps.seatPriceId);
    if (!seatItem) {
      // The subscription exists but has no seat item with the configured
      // seatPriceId — either it predates Layer 1's two-item shape or the
      // priceId env was changed underneath us. Skip rather than blindly
      // create a new item (that would be a different repair flow).
      return null;
    }

    // No-op short-circuit: quantity unchanged, skip the Stripe call.
    // Saves an API round-trip on idempotent re-sync (e.g. a domain auto-
    // join that races with itself; only one INSERT wins via the ON CONFLICT
    // but both code paths still call syncSeats).
    if (seatItem.quantity === billing.billableSeats) {
      return { newQuantity: billing.billableSeats, subscriptionItemId: seatItem.id };
    }

    await deps.stripe.subscriptionItems.update(seatItem.id, {
      quantity: billing.billableSeats,
      // Same discipline as the subscription-create: no partial-period
      // proration. In trialing state Stripe naturally suppresses
      // proration; passing 'none' explicitly defends against active-state
      // unintended proration too. L4 integration test covers the trial
      // path; this preserves it for post-trial too.
      proration_behavior: 'none',
    });

    return { newQuantity: billing.billableSeats, subscriptionItemId: seatItem.id };
  };
}
