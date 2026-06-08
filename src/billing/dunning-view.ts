import type Stripe from 'stripe';
import type { OrgService } from '../org/org-service.js';
import type { DunningView } from '../web/templates/team-billing.js';

/**
 * Derives the DunningView discriminated union from Conduit's subscription
 * read-model + Stripe API direct (for visual fields like card brand/last4
 * and attempt counts that we don't persist).
 *
 * Source of truth split:
 *   - status, first_failure_at, recovered_at → Conduit subscriptions table
 *     (mig 017 + mig 024; via orgService.getSubscription).
 *   - card_brand, card_last4, attempt_count, next_retry_date, amount, currency,
 *     current_period_end → Stripe API direct (derive-on-fly; no Conduit
 *     mirror table per Hank's Track A architecture).
 *
 * State mapping (per PR #94 body):
 *   - active|trialing + recovered_at within 1h          → recovered
 *   - active|trialing + no recent recovery              → none
 *   - past_due|unpaid|incomplete + inside Stripe-retry  → payment-failing (<=24h)
 *                                                       → past-due (24h–7d)
 *   - past_due|unpaid|incomplete + inside WYRE-grace    → final-warning
 *   - past_due|unpaid|incomplete + past-grace           → suspended
 *   - canceled|incomplete_expired                       → suspended
 *
 * Stripe fetch is best-effort. When the API call fails or no Stripe client
 * is supplied (test/dev), visual fields fall back to empty strings — the
 * state-machine still produces the correct UI variant from
 * (status, first_failure_at, recovered_at) alone.
 */

interface SubscriptionRow {
  status: string;
  first_failure_at: Date | null;
  recovered_at: Date | null;
  /**
   * Whether Stripe carries cancel_at_period_end=TRUE on the subscription.
   * Required for CC4 'scheduled-cancel' state derivation (ruby 2026-06-05):
   * previously the field lived in the DB row but wasn't read into the
   * view, so the scheduled-cancel UX state was structurally unreachable.
   * Optional for backward-compat with existing test fixtures; falsy
   * defaults to FALSE on read (= not-scheduled-cancel, the safe default).
   */
  cancel_at_period_end?: boolean | null;
  /**
   * Current billing period end. For active+scheduled-cancel subs this is
   * the date service will end; the renderer derives the countdown from it.
   * Optional for backward-compat with existing test fixtures.
   */
  current_period_end?: Date | null;
  /**
   * History-marker for PSR2 recovery-toast copy-pivot (ruby 2026-06-05).
   * Set in stripe-webhook invoice.payment_succeeded handler iff the
   * recovery was from a previously-suspended state (suspension_notified_at
   * was non-null at recovery time). Used here to discriminate the
   * 'Welcome back. / Your service is restored.' copy variant from the
   * routine 'You're set. / Card was charged successfully.' copy.
   * Optional for backward-compat with existing fixtures.
   */
  recovered_from_suspended_at?: Date | null;
}

interface StripeVisuals {
  cardBrand: string;
  cardLast4: string;
  attemptCount: number;
  nextRetryDate: string | null;
  amountCents: number;
  currency: string;
  currentPeriodEnd: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STRIPE_RETRY_WINDOW_DAYS = 7;
const RECOVERED_TTL_MS = 1 * HOUR_MS;

const EMPTY_VISUALS: StripeVisuals = {
  cardBrand: '',
  cardLast4: '',
  attemptCount: 0,
  nextRetryDate: null,
  amountCents: 0,
  currency: 'usd',
  currentPeriodEnd: null,
};

export interface DeriveDunningViewDeps {
  orgService: Pick<OrgService, 'getSubscription'>;
  /** Stripe client. Null/undefined when STRIPE_SECRET_KEY is unset (dev/test). */
  stripe: Stripe | null | undefined;
  /** Conduit-side grace days post-Stripe-retries. Config-driven. */
  graceDays: number;
  /** Stripe subscription id, when known (read off Conduit subscription row). */
  stripeSubscriptionId: string | null;
  /** Override for testability. */
  now?: Date;
}

export async function deriveDunningView(
  orgId: string,
  deps: DeriveDunningViewDeps,
): Promise<DunningView> {
  const now = deps.now ?? new Date();
  const sub = await deps.orgService.getSubscription(orgId);
  if (!sub) return { state: 'none' };

  // Fetch visual fields once. State-machine decides which fields apply.
  const visuals = await fetchStripeVisuals(deps.stripe ?? null, deps.stripeSubscriptionId);

  return mapSubscriptionToDunningView(sub, visuals, deps.graceDays, now);
}

export function mapSubscriptionToDunningView(
  sub: SubscriptionRow,
  visuals: StripeVisuals,
  graceDays: number,
  now: Date,
): DunningView {
  const {
    status,
    first_failure_at: firstFailAt,
    recovered_at: recoveredAt,
    cancel_at_period_end: cancelAtPeriodEnd,
    current_period_end: currentPeriodEnd,
    recovered_from_suspended_at: recoveredFromSuspendedAt,
  } = sub;

  // Recovered toast: within 1h of a successful recovery on an active sub.
  // After 1h the toast collapses to 'none' so it doesn't replay forever.
  if ((status === 'active' || status === 'trialing') && recoveredAt) {
    const ageMs = now.getTime() - recoveredAt.getTime();
    if (ageMs >= 0 && ageMs < RECOVERED_TTL_MS) {
      // PSR2 (ruby 2026-06-05, Aaron-option-A): discriminate post-
      // suspension recovery vs routine recovery via the
      // recovered_from_suspended_at marker (mig 045). Must be within
      // the same 1h-TTL window — checked against recovered_at, not
      // separately (a stale recovered_from_suspended_at from an older
      // cycle would not pair with a fresh recovered_at). Per the SQL
      // write in stripe-webhook, recovered_from_suspended_at is only
      // (re)written in the same payment_succeeded UPDATE that sets
      // recovered_at = NOW(), so timestamp-comparison is sufficient.
      const wasPreviouslySuspended =
        !!recoveredFromSuspendedAt
        && Math.abs(recoveredFromSuspendedAt.getTime() - recoveredAt.getTime()) < RECOVERED_TTL_MS;
      return {
        state: 'recovered',
        recoveredAt: recoveredAt.toISOString(),
        amountCents: visuals.amountCents,
        currency: visuals.currency,
        nextChargeDate: visuals.currentPeriodEnd ?? new Date(now.getTime() + 30 * DAY_MS).toISOString(),
        wasPreviouslySuspended,
      };
    }
  }

  // CC4 scheduled-cancel (ruby 2026-06-05): active sub that the customer
  // scheduled to end at the current period boundary. Distinct UX from
  // 'none' (which would hide the scheduled-end entirely) and from
  // 'canceled' (which is the post-end state). Banner-class surface: lets
  // the customer see the countdown + uncancel before service ends.
  if (
    (status === 'active' || status === 'trialing')
    && cancelAtPeriodEnd === true
    && currentPeriodEnd
  ) {
    return {
      state: 'scheduled-cancel',
      scheduledEndAt: currentPeriodEnd.toISOString(),
    };
  }

  if (status === 'active' || status === 'trialing') {
    return { state: 'none' };
  }

  // CC2 (ruby 2026-06-05): split customer-cancel-intent from payment-
  // failure-suspension. Both used to collapse into 'suspended' here,
  // which rendered identical copy for semantically different lifecycle
  // moments (customer chose to leave vs we couldn't bill them).
  if (status === 'canceled') {
    return {
      state: 'canceled',
      canceledAt: now.toISOString(),
    };
  }

  // Stripe terminal payment-failure -> suspended. No grace, no countdown.
  // 'incomplete_expired' = Stripe gave up on the initial payment after
  // 23h of retries (not a customer-intent cancel).
  if (status === 'incomplete_expired') {
    return {
      state: 'suspended',
      firstFailDate: firstFailAt?.toISOString() ?? now.toISOString(),
      attemptCount: visuals.attemptCount,
      suspendedAt: now.toISOString(),
      cardBrand: visuals.cardBrand,
      cardLast4: visuals.cardLast4,
    };
  }

  // Failure states with retry/grace semantics.
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') {
    // Defensive: a status flip without a recorded first_failure_at is a
    // brief race between Stripe and our webhook. Treat as just-entered.
    const fail = firstFailAt ?? now;
    const stripeRetryEnd = new Date(fail.getTime() + STRIPE_RETRY_WINDOW_DAYS * DAY_MS);
    const graceEnd = new Date(stripeRetryEnd.getTime() + graceDays * DAY_MS);

    if (now.getTime() >= graceEnd.getTime()) {
      return {
        state: 'suspended',
        firstFailDate: fail.toISOString(),
        attemptCount: visuals.attemptCount,
        suspendedAt: graceEnd.toISOString(),
        cardBrand: visuals.cardBrand,
        cardLast4: visuals.cardLast4,
      };
    }

    if (now.getTime() >= stripeRetryEnd.getTime()) {
      // WYRE-grace window — final-warning (countdown widget tracks
      // serviceEndDate; banner escalates urgent in last 48h via the
      // template, not here).
      return {
        state: 'final-warning',
        firstFailDate: fail.toISOString(),
        attemptCount: visuals.attemptCount,
        serviceEndDate: graceEnd.toISOString(),
        cardBrand: visuals.cardBrand,
        cardLast4: visuals.cardLast4,
        amountCents: visuals.amountCents,
        currency: visuals.currency,
      };
    }

    // Inside Stripe-retry window. First 24h reads as informational
    // (payment-failing / cyan); 24h–7d reads as steady warn (past-due).
    const ageHours = (now.getTime() - fail.getTime()) / HOUR_MS;
    const state: 'payment-failing' | 'past-due' = ageHours <= 24 ? 'payment-failing' : 'past-due';
    return {
      state,
      firstFailDate: fail.toISOString(),
      attemptCount: visuals.attemptCount,
      nextRetryDate: visuals.nextRetryDate,
      cardBrand: visuals.cardBrand,
      cardLast4: visuals.cardLast4,
      amountCents: visuals.amountCents,
      currency: visuals.currency,
    };
  }

  // Any other status (unknown future Stripe value) — fall through to
  // none rather than mask the surface entirely.
  return { state: 'none' };
}

async function fetchStripeVisuals(
  stripe: Stripe | null,
  subscriptionId: string | null,
): Promise<StripeVisuals> {
  if (!stripe || !subscriptionId) return EMPTY_VISUALS;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'latest_invoice', 'latest_invoice.payment_intent'],
    });
    return extractVisualsFromStripeSubscription(sub);
  } catch {
    return EMPTY_VISUALS;
  }
}

export function extractVisualsFromStripeSubscription(
  sub: Stripe.Subscription,
): StripeVisuals {
  const pm = sub.default_payment_method;
  const card = pm && typeof pm !== 'string' && pm.card ? pm.card : null;
  const latestInvoice = sub.latest_invoice;
  const invoice = latestInvoice && typeof latestInvoice !== 'string' ? latestInvoice : null;

  const attemptCount = invoice?.attempt_count ?? 0;
  // next_payment_attempt is unix-seconds; null when Stripe has exhausted retries.
  const nextRetryUnix = invoice?.next_payment_attempt ?? null;
  const nextRetryDate = nextRetryUnix ? new Date(nextRetryUnix * 1000).toISOString() : null;
  const amountCents = invoice?.amount_due ?? 0;
  const currency = invoice?.currency ?? 'usd';
  // Stripe API moved current_period_end onto SubscriptionItem in newer
  // versions; fall back across both placements so we work against the
  // SDK version this repo pins to. Bracket-access keeps the older shape
  // accessible without depending on its type-level presence.
  const subRaw = sub as unknown as Record<string, unknown>;
  const periodEndRaw = (typeof subRaw['current_period_end'] === 'number'
    ? subRaw['current_period_end']
    : sub.items?.data?.[0]?.current_period_end) as number | null | undefined;
  const currentPeriodEnd = typeof periodEndRaw === 'number'
    ? new Date(periodEndRaw * 1000).toISOString()
    : null;

  return {
    cardBrand: card?.brand ?? '',
    cardLast4: card?.last4 ?? '',
    attemptCount,
    nextRetryDate,
    amountCents,
    currency,
    currentPeriodEnd,
  };
}

// Exposed for unit tests.
export const __TEST__ = { EMPTY_VISUALS, RECOVERED_TTL_MS, STRIPE_RETRY_WINDOW_DAYS };
