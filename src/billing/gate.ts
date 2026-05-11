import type { OrgService } from '../org/org-service.js';
import { getPlan, getDefaultPlan, type PlanDefinition, type PlanSlug } from './plan-catalog.js';

// ---------------------------------------------------------------------------
// BillingGate — plan checks for feature gating
// ---------------------------------------------------------------------------

export interface BillingGate {
  getUserPlan(userId: string): Promise<PlanSlug>;
  canUseTeamFeatures(orgId: string): Promise<boolean>;
  canAddMember(orgId: string): Promise<boolean>;
  getConnectionLimit(userId: string): Promise<number>;
  getRateLimit(userId: string): Promise<number>;
  canUsePromptCapture(orgId: string): Promise<boolean>;
  canUseLogShipping(orgId: string): Promise<boolean>;
  canUseAuditLogExport(orgId: string): Promise<boolean>;
  canUseSso(orgId: string): Promise<boolean>;
  canUseServiceClients(orgId: string): Promise<boolean>;
  /**
   * Monthly credit allocation for an org. For free plans this is a flat
   * total. For paid plans it is `creditAllocation × seat count`, pooled
   * across the org.
   */
  getCreditAllocation(orgId: string): Promise<number>;
}

const PLAN_RANK: Record<PlanSlug, number> = { free: 0, pro: 1, business: 2 };

/**
 * "Is this plan paid?" — single source of truth for the team-features
 * tier gate used by BOTH renderLayout (sidebar visibility) AND
 * requireTeamAccess (handler authorization). The two gates MUST use the
 * same predicate or the user sees clickable team-nav items that 302
 * back to /settings — a "phantom-clickable-dead-link" UX bug.
 *
 * Empirical origin: 2026-05-11 found business-plan-owner Aaron stuck
 * because requireTeamAccess used `plan !== "pro"` (strict equality)
 * while layout used `plan === "pro" || plan === "business"` (OR-set).
 * `business` rendered the nav but failed the gate. Fix: both call sites
 * route through isPaidPlan; future plan tiers above pro pick up
 * automatically.
 */
export function isPaidPlan(plan: PlanSlug | undefined | null): boolean {
  if (!plan) return false;
  const rank = PLAN_RANK[plan];
  if (rank === undefined) return false;
  return rank >= PLAN_RANK.pro;
}

export class DefaultBillingGate implements BillingGate {
  constructor(private orgService: OrgService) {}

  private async resolveOrgPlan(orgId: string): Promise<PlanDefinition> {
    const org = await this.orgService.getOrg(orgId);
    return getPlan(org?.plan ?? 'free') ?? getDefaultPlan();
  }

  private async resolveUserPlan(userId: string): Promise<PlanDefinition> {
    const orgs = await this.orgService.getUserOrgs(userId);
    let best: PlanDefinition | undefined;
    for (const org of orgs) {
      const plan = getPlan(org.plan);
      if (!plan) continue;
      const rank = PLAN_RANK[plan.slug as PlanSlug] ?? 0;
      const bestRank = best ? PLAN_RANK[best.slug as PlanSlug] ?? 0 : -1;
      if (rank > bestRank) best = plan;
    }
    return best ?? getDefaultPlan();
  }

  async getUserPlan(userId: string): Promise<PlanSlug> {
    const orgs = await this.orgService.getUserOrgs(userId);
    let highest: PlanSlug = 'free';
    for (const org of orgs) {
      const slug = org.plan as PlanSlug;
      if ((PLAN_RANK[slug] ?? 0) > PLAN_RANK[highest]) highest = slug;
    }
    return highest;
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

  async getRateLimit(userId: string): Promise<number> {
    const plan = await this.resolveUserPlan(userId);
    return plan.rateLimitPerHour;
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

  async getCreditAllocation(orgId: string): Promise<number> {
    const plan = await this.resolveOrgPlan(orgId);
    if (plan.slug === 'free') return plan.creditAllocation;
    const members = await this.orgService.getMembers(orgId);
    const seatCount = Math.max(members.length, 1);
    return plan.creditAllocation * seatCount;
  }
}
