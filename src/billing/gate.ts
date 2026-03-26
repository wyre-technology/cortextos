import type { OrgService } from '../org/org-service.js';

// ---------------------------------------------------------------------------
// BillingGate — plan checks for feature gating
// ---------------------------------------------------------------------------

export interface BillingGate {
  getUserPlan(userId: string): Promise<'free' | 'pro'>;
  canUseTeamFeatures(orgId: string): Promise<boolean>;
  canAddMember(orgId: string): Promise<boolean>;
  getConnectionLimit(userId: string): Promise<number>;
  getRateLimit(userId: string): Promise<number>;
}

const FREE_CONNECTION_LIMIT = 3;
const FREE_RATE_LIMIT = 100;    // requests/hour/vendor
const PRO_RATE_LIMIT = 1000;    // requests/hour/vendor

export class DefaultBillingGate implements BillingGate {
  constructor(private orgService: OrgService) {}

  async getUserPlan(userId: string): Promise<'free' | 'pro'> {
    const orgs = await this.orgService.getUserOrgs(userId);
    // User is "pro" if they belong to any org on a pro plan
    for (const org of orgs) {
      if (org.plan === 'pro') return 'pro';
    }
    return 'free';
  }

  async canUseTeamFeatures(orgId: string): Promise<boolean> {
    const org = await this.orgService.getOrg(orgId);
    return org?.plan === 'pro';
  }

  async canAddMember(orgId: string): Promise<boolean> {
    return this.canUseTeamFeatures(orgId);
  }

  async getConnectionLimit(userId: string): Promise<number> {
    const plan = await this.getUserPlan(userId);
    return plan === 'pro' ? Infinity : FREE_CONNECTION_LIMIT;
  }

  async getRateLimit(userId: string): Promise<number> {
    const plan = await this.getUserPlan(userId);
    return plan === 'pro' ? PRO_RATE_LIMIT : FREE_RATE_LIMIT;
  }
}
