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
  if (status === 'active' || status === 'trialing') return true;

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

  async canUseTeamFeatures(orgId: string): Promise<boolean> {
    const plan = await this.resolveOrgPlan(orgId);
    return plan.teamFeatures;
  }

  async canAddMember(orgId: string): Promise<boolean> {
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
    const plan = await this.resolveOrgPlan(orgId);
    return plan.promptCapture;
  }

  async canUseLogShipping(orgId: string): Promise<boolean> {
    const plan = await this.resolveOrgPlan(orgId);
    return plan.logShipping;
  }

  async canUseAuditLogExport(orgId: string): Promise<boolean> {
    const plan = await this.resolveOrgPlan(orgId);
    return plan.auditLogExport;
  }

  async canUseSso(orgId: string): Promise<boolean> {
    const plan = await this.resolveOrgPlan(orgId);
    return plan.sso;
  }

  async canUseServiceClients(orgId: string): Promise<boolean> {
    const plan = await this.resolveOrgPlan(orgId);
    return plan.serviceClients;
  }
}
