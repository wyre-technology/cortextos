import type { OrgService } from '../org/org-service.js';
import { getPlan, getDefaultPlan, type PlanDefinition } from './plan-catalog.js';

// ---------------------------------------------------------------------------
// BillingGate — plan checks for feature gating
// ---------------------------------------------------------------------------

export interface BillingGate {
  getUserPlan(userId: string): Promise<'free' | 'pro'>;
  canUseTeamFeatures(orgId: string): Promise<boolean>;
  canAddMember(orgId: string): Promise<boolean>;
  getConnectionLimit(userId: string): Promise<number>;
  getRateLimit(userId: string): Promise<number>;
  canUsePromptCapture(orgId: string): Promise<boolean>;
  canUseLogShipping(orgId: string): Promise<boolean>;
}

export class DefaultBillingGate implements BillingGate {
  constructor(private orgService: OrgService) {}

  private async resolveOrgPlan(orgId: string): Promise<PlanDefinition> {
    const org = await this.orgService.getOrg(orgId);
    return getPlan(org?.plan ?? 'free') ?? getDefaultPlan();
  }

  private async resolveUserPlan(userId: string): Promise<PlanDefinition> {
    const orgs = await this.orgService.getUserOrgs(userId);
    for (const org of orgs) {
      const plan = getPlan(org.plan);
      if (plan && plan.teamFeatures) return plan;
    }
    return getDefaultPlan();
  }

  async getUserPlan(userId: string): Promise<'free' | 'pro'> {
    const orgs = await this.orgService.getUserOrgs(userId);
    for (const org of orgs) {
      if (org.plan === 'pro') return 'pro';
    }
    return 'free';
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
}
