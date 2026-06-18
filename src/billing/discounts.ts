/**
 * Per-org discount primitive — Layer-1 §8 EAP slice (WYREAI-25).
 *
 * Pedigree: boss msg-1781749682091 (A* + shared-apply-helper, GO),
 *           ruby msg-1781749672262 (primitive shape + audit-housed-in-
 *           primitive + applies_to compile-fail-as-linchpin),
 *           mig 054_org_discounts.sql (the SoT table).
 *
 * Why this module exists
 * ----------------------
 * The seat-billing data path (src/billing/seat-service.ts) computes the
 * monthly bill the customer sees. The Stripe-driving path (src/billing/
 * subscription-factory.ts) builds the line items the customer is actually
 * charged. For the page-and-billing-agree contract (PR wyre-ai#32 +
 * conduit#449) to survive across launch, those two paths MUST apply
 * discounts identically — otherwise the display says one number and the
 * invoice says another. The (a)-discipline we just shipped.
 *
 * That is exactly what `applyDiscounts` enforces by being the only place
 * discount math lives. Both call sites import it; neither has its own
 * copy. The reason+applies_to enum types are switched on at each consumer
 * so the apply-side stays explicit at every call (a future
 * discount-type addition lands compile-failed at any consumer that has not
 * declared its handling — drift-by-omission closed by-construction).
 *
 * Today's discounts
 * -----------------
 *   eap          / org_fee         / 100   — drops the $399 base entirely
 *   annual_prepay / invoice_total / 15     — (c) ship, NOT yet wired here
 *
 * The EAP case ((b), this PR) reduces the base line to 0 and is
 * translated by subscription-factory into ITEM OMISSION (basePriceId is
 * left out of items[]) — not a Stripe coupon. Stripe sees a single seat
 * line and charges accordingly; no Stripe-coupon-state to sync.
 *
 * The annual-prepay case ((c), next PR) will discount the invoice-total
 * line and is translated by subscription-factory into a Stripe sub-level
 * discount[]; the helper API does not change.
 *
 * Pure functions
 * --------------
 * Everything here is pure: no I/O, no DB, no Stripe. Inputs are integers
 * and a frozen discount-row array; outputs are integers. Service-shaped
 * fetching of the discount rows from the DB lives at
 * OrgDiscountService.getDiscounts(orgId) below — that is the I/O surface;
 * applyDiscounts itself stays test-friendly and call-site-cheap.
 */

import { getSql, type Sql } from '../db/context.js';

/**
 * Reason a discount was granted. Drives customer-facing badge copy AND
 * the admin-trail entry. Extension to volume/promo/etc. is a CHECK-
 * constraint update at mig-level + an enum extension here; every consumer
 * that switches on this MUST declare its handling or the switch fails
 * closed (compile-fail-as-linchpin per ruby msg-1781749672262).
 */
export type DiscountReason = 'eap' | 'annual_prepay';

/**
 * Math scope the discount applies to. 'org_fee' targets only the $399
 * base line; 'invoice_total' targets the entire base+seat sum after the
 * org_fee discounts land. Order matters — applyDiscounts applies all
 * org_fee discounts first, then all invoice_total discounts on top. Past
 * 100% is clamped to 100% per scope (no negative bills, ever).
 */
export type DiscountAppliesTo = 'org_fee' | 'invoice_total';

export interface OrgDiscount {
  readonly reason: DiscountReason;
  readonly appliesTo: DiscountAppliesTo;
  /** 1..100 — see mig 054 CHECK constraint. */
  readonly percent: number;
  readonly grantedBy: string;
  /** ISO-8601 timestamp. */
  readonly grantedAt: string;
}

export interface DiscountedBill {
  /** Cents. The $399 base after any org_fee discounts. 0 if fully waived. */
  readonly baseCents: number;
  /** Cents. PER_SEAT_PRICE_CENTS × billableSeats. Untouched by org_fee
   *  discounts; reduced only by invoice_total discounts (proportionally
   *  with the base). */
  readonly seatTotalCents: number;
  /** Cents. baseCents + seatTotalCents AFTER invoice_total discounts.
   *  This is the number the customer is charged each month. */
  readonly monthlyTotalCents: number;
  /** The rows that actually contributed. A discount with percent=0 (not
   *  reachable today since the CHECK rejects it, but defensible) or that
   *  is dominated by an earlier 100% is omitted from this list so render
   *  code does not show no-op grants. Today this is identical to the
   *  input array. */
  readonly appliedDiscounts: ReadonlyArray<OrgDiscount>;
}

/**
 * The single source of discount math. Both computeSeatBilling AND
 * subscription-factory call this. There is no other apply path. New
 * consumers MUST go through here.
 *
 * Math:
 *   base    = baseCents × ∏(1 - p/100) for p in [org_fee discounts]
 *   pre     = base + seatTotalCents
 *   monthly = pre × ∏(1 - p/100) for p in [invoice_total discounts]
 *
 * Each step is integer-rounded (Math.floor) so the result is always
 * representable in Stripe-cents and never produces a fractional charge.
 * Rounding down (not nearest) is the customer-favorable direction.
 */
export function applyDiscounts(
  baseCents: number,
  seatTotalCents: number,
  discounts: ReadonlyArray<OrgDiscount>,
): DiscountedBill {
  let base = Math.max(0, baseCents | 0);
  const seat = Math.max(0, seatTotalCents | 0);

  for (const d of discounts) {
    if (d.appliesTo !== 'org_fee') continue;
    base = Math.floor(base * (1 - clampPercent(d.percent) / 100));
  }

  let monthly = base + seat;

  for (const d of discounts) {
    if (d.appliesTo !== 'invoice_total') continue;
    monthly = Math.floor(monthly * (1 - clampPercent(d.percent) / 100));
  }

  return Object.freeze({
    baseCents: base,
    seatTotalCents: seat,
    monthlyTotalCents: monthly,
    appliedDiscounts: Object.freeze([...discounts]),
  });
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

/**
 * Service surface for fetching the discount rows for an org. The I/O
 * boundary — pure math stays in applyDiscounts. Both
 * computeSeatBilling and the subscription-factory call sites read
 * through this service (not direct SQL) so the SoT is single.
 */
export interface OrgDiscountService {
  getDiscounts(orgId: string): Promise<ReadonlyArray<OrgDiscount>>;
}

export class DefaultOrgDiscountService implements OrgDiscountService {
  /**
   * Lazy connection resolution — same pattern as OrgService. getSql()
   * yields the request-path connection inside an HTTP request (with the
   * conduit.current_user_id GUC set, so the RLS SELECT policy on
   * org_discounts gates rightly) and the system pool inside boot DDL or
   * the admin route's runAsSystem block.
   */
  private get sql(): Sql {
    return getSql();
  }

  async getDiscounts(orgId: string): Promise<ReadonlyArray<OrgDiscount>> {
    const rows = await this.sql<
      Array<{
        reason: string;
        applies_to: string;
        percent: number;
        granted_by: string;
        granted_at: string | Date;
      }>
    >`
      SELECT reason, applies_to, percent, granted_by, granted_at
        FROM org_discounts
       WHERE org_id = ${orgId}
       ORDER BY granted_at ASC
    `;
    return rows.map((r) =>
      Object.freeze({
        reason: r.reason as DiscountReason,
        appliesTo: r.applies_to as DiscountAppliesTo,
        percent: r.percent,
        grantedBy: r.granted_by,
        grantedAt:
          typeof r.granted_at === 'string'
            ? r.granted_at
            : r.granted_at.toISOString(),
      }),
    );
  }
}

/**
 * Convenience read helper — does an org have any discount at all? Used by
 * the display layer to decide whether to render the "discount-applied"
 * indicator without re-walking the array.
 */
export function hasAnyDiscount(discounts: ReadonlyArray<OrgDiscount>): boolean {
  return discounts.length > 0;
}

/**
 * Convenience read helper — fully-waived org-fee? (EAP fully covers the
 * $399.) Used by subscription-factory to decide whether to OMIT the
 * basePriceId item from items[] entirely, vs include it at a reduced
 * price (which would require a Stripe coupon, which the (b) cut explicitly
 * does NOT use). Today an eap row IS percent=100, but the check is
 * percent-driven, not reason-driven, so a future 100% org_fee under any
 * reason behaves identically.
 */
export function isOrgFeeFullyWaived(
  discounts: ReadonlyArray<OrgDiscount>,
): boolean {
  let remaining = 100;
  for (const d of discounts) {
    if (d.appliesTo !== 'org_fee') continue;
    remaining = remaining * (1 - clampPercent(d.percent) / 100);
  }
  return remaining === 0;
}
