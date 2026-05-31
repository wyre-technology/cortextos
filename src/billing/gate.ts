import type { OrgService } from '../org/org-service.js';
import { config } from '../config.js';
import { getPlan, getDefaultPlan, type PlanDefinition, type PlanSlug } from './plan-catalog.js';
import { ANTI_ABUSE_RATE_PER_HOUR } from './prices.js';
import type { SeatService } from './seat-service.js';

// ---------------------------------------------------------------------------
// BillingGate — plan checks for feature gating
// ---------------------------------------------------------------------------

export interface BillingGate {
  getUserPlan(userId: string): Promise<PlanSlug>;
  /**
   * Composed paid-and-service-active check used by handler gates.
   * Returns true only if the org's plan is paid (isPaidPlan) AND service
   * is active (isServiceActive with the configured grace period).
   *
   * Use this at every handler-gate site that decides "should we deliver
   * paid service right now." Distinct from isPaidPlan (tier-only) and
   * from canUseTeamFeatures (plan-feature flag) — this is the
   * dunning-aware composed gate.
   */
  canAccessPaidFeatures(orgId: string): Promise<boolean>;
  canUseTeamFeatures(orgId: string): Promise<boolean>;
  canAddMember(orgId: string): Promise<boolean>;
  getConnectionLimit(userId: string): Promise<number>;
  getRateLimit(userId: string): Promise<number>;
  canUsePromptCapture(orgId: string): Promise<boolean>;
  canUseLogShipping(orgId: string): Promise<boolean>;
  canUseAuditLogExport(orgId: string): Promise<boolean>;
  canUseSso(orgId: string): Promise<boolean>;
  canUseServiceClients(orgId: string): Promise<boolean>;
}

/**
 * "Is this org on the (single, flat) plan?" — kept as the predicate BOTH
 * renderLayout (sidebar visibility) AND requireTeamAccess (handler
 * authorization) call, so the two never disagree (the historical
 * phantom-clickable-dead-link bug). Flat-pricing collapses this: there is
 * one plan and no free tier, so any org carrying a resolvable plan slug is
 * "on the plan". Whether service is DELIVERED right now is the separate
 * dunning question (isServiceActive) — canAccessPaidFeatures composes both.
 *
 * Any legacy 'free'/'pro'/'business' slug on an un-migrated row resolves to
 * the flat plan via getPlan, so this returns true for them too; the
 * robust free-org migration + dunning govern the actual service decision.
 */
export function isPaidPlan(plan: PlanSlug | string | undefined | null): boolean {
  return getPlan(plan) !== undefined;
}

/**
 * "Is service still active for this subscription?" — dunning-aware gate.
 *
 * isPaidPlan answers "did this org pay for service" (tier question).
 * isServiceActive answers "should we still deliver service right now"
 * (dunning question). Both must be true for a paid feature gate to admit.
 *
 * Architecture: derive-on-fly. Stripe is source of truth for subscription
 * status; Conduit computes the suspension boundary as
 * (subscription.status, first_failure_at, dunningGraceDays).
 *
 * Returns true when:
 *   - subscription is missing (caller is responsible for the no-sub case
 *     — usually handled via isPaidPlan returning false first)
 *   - status is active or trialing (healthy subscription)
 *   - status is past_due / unpaid AND we are still inside the grace window
 *     measured from first_failure_at
 *
 * Returns false when:
 *   - status is canceled or incomplete_expired (Stripe terminal)
 *   - status is past_due / unpaid AND grace window has expired
 *     (first_failure_at + dunningGraceDays < now)
 *
 * The grace-window semantics correspond to Ruby's checkpoint-3 5-state
 * lifecycle: payment-failing + past-due + final-warning all return true
 * (service active, customer in dunning UI); suspended returns false
 * (gate flipped, customer sees the suspended template).
 */
export interface SubscriptionLike {
  status: string;
  first_failure_at: Date | string | null;
  /**
   * Period end of the current billing cycle (or, for a cutover-grace row, the
   * T+14d natural-flip moment). Read together with `cancel_at_period_end` to
   * deny service after the period elapses without a paid Stripe subscription
   * superseding the row — see the cutover-grace branch in isServiceActive.
   * Optional so existing callers that only carry (status, first_failure_at)
   * keep working unchanged.
   */
  current_period_end?: Date | string | null;
  /**
   * "End service when the period ends" flag. TRUE on cutover-seeded local
   * grace rows for the existing-free-org population (Aaron's 2026-05-29
   * 14-day decide-or-revert policy) AND on Stripe subscriptions the user
   * has chosen to cancel-at-period-end. Combined with `current_period_end`,
   * lets isServiceActive flip service off by-time-elapsed, no cron needed.
   * Optional for the same back-compat reason as `current_period_end`.
   */
  cancel_at_period_end?: boolean | null;
}

/**
 * Internal helper — does the cutover-grace / cancel-at-period-end flip
 * deny service yet? Returns true (deny) when the row asks to end at period
 * end AND the period has elapsed. The state is read at request time so the
 * flip happens by-time-elapsed with no cron or status-write needed
 * (boss/Aaron-approved Shape-A″ for the free-org cutover policy).
 */
function isPastCancelAtPeriodEnd(
  subscription: SubscriptionLike,
  now: Date,
): boolean {
  if (!subscription.cancel_at_period_end) return false;
  if (!subscription.current_period_end) return false;
  const periodEndMs =
    typeof subscription.current_period_end === 'string'
      ? Date.parse(subscription.current_period_end)
      : subscription.current_period_end.getTime();
  return now.getTime() >= periodEndMs;
}

export function isServiceActive(
  subscription: SubscriptionLike | null | undefined,
  graceDays: number,
  now: Date = new Date(),
): boolean {
  // No subscription record → caller decides via isPaidPlan. We return true
  // here so that free-tier orgs (no subscription) aren't accidentally
  // flagged as "suspended" by this helper. The plan-tier gate handles
  // the free-vs-paid distinction.
  if (!subscription) return true;

  const status = subscription.status;
  if (status === 'active' || status === 'trialing') {
    // Cutover-grace / cancel-at-period-end branch (Aaron 2026-05-29 free-org
    // policy + Stripe scheduled-cancel parity): an otherwise-active row with
    // cancel_at_period_end=TRUE and a past current_period_end denies service.
    // Read-time evaluation means the T+14d flip happens by-time-elapsed; no
    // cron is needed to mutate the row.
    return !isPastCancelAtPeriodEnd(subscription, now);
  }

  // Terminal states — service is over regardless of grace.
  if (status === 'canceled' || status === 'incomplete_expired') return false;

  // past_due / unpaid / incomplete — gated on grace window.
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') {
    if (!subscription.first_failure_at) {
      // Defensive: status indicates failure but we never recorded the
      // first-failure timestamp. Treat as just-entered-dunning (grace
      // window starts now). Caller's webhook should populate this on
      // the first invoice.payment_failed; the missing-value path is
      // a brief race-window between Stripe's status flip and our
      // webhook handler running.
      return true;
    }
    const firstFailMs =
      typeof subscription.first_failure_at === 'string'
        ? Date.parse(subscription.first_failure_at)
        : subscription.first_failure_at.getTime();
    const graceMs = graceDays * 24 * 60 * 60 * 1000;
    return now.getTime() < firstFailMs + graceMs;
  }

  // Unknown status — fail closed (safer to deny than admit on unknowns).
  return false;
}

export class DefaultBillingGate implements BillingGate {
  // seatService is accepted for call-site compatibility (index.ts passes the
  // shared instance) but the gate no longer needs it — credit allocation was
  // its only consumer, removed with the credit model. Underscore-prefixed so
  // an intentionally-unused constructor param does not trip noUnusedParameters.
  constructor(private orgService: OrgService, _seatService?: SeatService) {}

  // Flat-pricing: one plan. Org/user plan resolution collapses to the flat
  // plan regardless of the stored slug — no tier-ranking, no highest-across-
  // orgs selection (there is nothing to rank).
  private async resolveOrgPlan(_orgId: string): Promise<PlanDefinition> {
    return getDefaultPlan();
  }

  private async resolveUserPlan(_userId: string): Promise<PlanDefinition> {
    return getDefaultPlan();
  }

  async getUserPlan(_userId: string): Promise<PlanSlug> {
    return getDefaultPlan().slug as PlanSlug;
  }

  async canAccessPaidFeatures(orgId: string): Promise<boolean> {
    const org = await this.orgService.getOrg(orgId);
    if (!isPaidPlan(org?.plan)) return false;
    // Plan-tier is paid. Now check whether service is currently active
    // per the dunning grace window. If no subscription record exists for
    // a paid org (mid-flight before checkout webhook lands), isServiceActive
    // returns true defensively — same shape as the missing-first_failure_at
    // race-window in past_due status.
    const subscription = await this.orgService.getSubscription(orgId);
    return isServiceActive(subscription, config.dunningGraceDays);
  }

  /**
   * Single-source feature-gate helper: every "can use feature X" gate
   * composes the dunning-aware paid-and-service-active check with the
   * plan-level feature flag. Closes the warden 2026-05-31 PR #291 finding —
   * pre-this-PR, canUseX returned plan-level booleans WITHOUT consulting
   * isServiceActive, so a grace-elapsed org (or a Stripe-cancelled one
   * pre-#275 — same vector via past-grace past_due, smaller class) could
   * still pass the per-feature gates while being denied paid-feature access.
   * Post-#275 the bypass class is the dunning-grace subset; post-#291 the
   * cutover-grace + cancel-at-period-end class joins it (larger population).
   * Composition-at-root is the construction-side fix (architecture-of-record
   * at gate.ts) — every canUseX inherits the dunning + cutover semantics
   * automatically; new gates added in the future inherit by-construction.
   */
  private async checkFeature(
    orgId: string,
    featureKey: keyof Pick<
      PlanDefinition,
      'teamFeatures' | 'logShipping' | 'promptCapture' | 'auditLogExport' | 'sso' | 'serviceClients'
    >,
  ): Promise<boolean> {
    if (!(await this.canAccessPaidFeatures(orgId))) return false;
    const plan = await this.resolveOrgPlan(orgId);
    return plan[featureKey];
  }

  async canUseTeamFeatures(orgId: string): Promise<boolean> {
    return this.checkFeature(orgId, 'teamFeatures');
  }

  async canAddMember(orgId: string): Promise<boolean> {
    // canAddMember has the same paid-and-service-active prerequisite as the
    // other feature gates (same composition discipline) plus a member-count
    // cap unique to itself. The cap is structural (Infinity in the flat plan,
    // so always-true post-flat), kept for non-flat future plans.
    if (!(await this.canAccessPaidFeatures(orgId))) return false;
    const plan = await this.resolveOrgPlan(orgId);
    if (!plan.teamFeatures) return false;
    if (plan.maxMembers === Infinity) return true;
    const members = await this.orgService.getMembers(orgId);
    return members.length < plan.maxMembers;
  }

  async getConnectionLimit(userId: string): Promise<number> {
    const plan = await this.resolveUserPlan(userId);
    return plan.vendorLimit;
  }

  async getRateLimit(_userId: string): Promise<number> {
    // Flat anti-abuse ceiling — same for every user, NOT a pricing tier.
    // The per-user-keyed Fastify rate-limit mechanism in the proxy routers
    // is unchanged; only the max value is flattened off the plan onto a
    // module constant (divorced-from-plan-object so it can never drift back
    // into a tier gate).
    return ANTI_ABUSE_RATE_PER_HOUR;
  }

  async canUsePromptCapture(orgId: string): Promise<boolean> {
    return this.checkFeature(orgId, 'promptCapture');
  }

  async canUseLogShipping(orgId: string): Promise<boolean> {
    return this.checkFeature(orgId, 'logShipping');
  }

  async canUseAuditLogExport(orgId: string): Promise<boolean> {
    return this.checkFeature(orgId, 'auditLogExport');
  }

  async canUseSso(orgId: string): Promise<boolean> {
    return this.checkFeature(orgId, 'sso');
  }

  async canUseServiceClients(orgId: string): Promise<boolean> {
    return this.checkFeature(orgId, 'serviceClients');
  }
}
