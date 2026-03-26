import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultBillingGate } from './gate.js';
import type { OrgService } from '../org/org-service.js';
import type { Organization } from '../org/org-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Test Org',
    ownerId: 'user-1',
    plan: 'free',
    defaultServerAccess: 'none',
    promptCaptureEnabled: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultBillingGate', () => {
  let gate: DefaultBillingGate;
  const mockOrgService = {
    getUserOrgs: vi.fn<[string], Organization[]>(),
    getOrg: vi.fn<[string], Organization | null>(),
    getMembers: vi.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    gate = new DefaultBillingGate(mockOrgService as unknown as OrgService);
  });

  // -------------------------------------------------------------------------
  // getUserPlan
  // -------------------------------------------------------------------------

  describe('getUserPlan', () => {
    it('returns "pro" when user belongs to a pro org', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ id: 'org-1', plan: 'pro' }),
      ]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('pro');
      expect(mockOrgService.getUserOrgs).toHaveBeenCalledWith('user-1');
    });

    it('returns "pro" when at least one org is pro among several', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ id: 'org-1', plan: 'free' }),
        makeOrg({ id: 'org-2', plan: 'pro' }),
        makeOrg({ id: 'org-3', plan: 'free' }),
      ]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('pro');
    });

    it('returns "free" when no orgs are pro', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ id: 'org-1', plan: 'free' }),
        makeOrg({ id: 'org-2', plan: 'free' }),
      ]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('free');
    });

    it('returns "free" when user belongs to no orgs', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const plan = await gate.getUserPlan('user-1');

      expect(plan).toBe('free');
    });
  });

  // -------------------------------------------------------------------------
  // getConnectionLimit
  // -------------------------------------------------------------------------

  describe('getConnectionLimit', () => {
    it('returns 3 for free plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const limit = await gate.getConnectionLimit('user-1');

      expect(limit).toBe(3);
    });

    it('returns Infinity for pro plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ plan: 'pro' }),
      ]);

      const limit = await gate.getConnectionLimit('user-1');

      expect(limit).toBe(Infinity);
    });
  });

  // -------------------------------------------------------------------------
  // getRateLimit
  // -------------------------------------------------------------------------

  describe('getRateLimit', () => {
    it('returns 100 for free plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([]);

      const limit = await gate.getRateLimit('user-1');

      expect(limit).toBe(100);
    });

    it('returns 1000 for pro plan users', async () => {
      mockOrgService.getUserOrgs.mockResolvedValue([
        makeOrg({ plan: 'pro' }),
      ]);

      const limit = await gate.getRateLimit('user-1');

      expect(limit).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // canUseTeamFeatures
  // -------------------------------------------------------------------------

  describe('canUseTeamFeatures', () => {
    it('returns true for a pro org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'pro' }));

      const result = await gate.canUseTeamFeatures('org-1');

      expect(result).toBe(true);
      expect(mockOrgService.getOrg).toHaveBeenCalledWith('org-1');
    });

    it('returns false for a free org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ id: 'org-1', plan: 'free' }));

      const result = await gate.canUseTeamFeatures('org-1');

      expect(result).toBe(false);
    });

    it('returns false when org does not exist', async () => {
      mockOrgService.getOrg.mockResolvedValue(null);

      const result = await gate.canUseTeamFeatures('nonexistent');

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // canAddMember (delegates to canUseTeamFeatures)
  // -------------------------------------------------------------------------

  describe('canAddMember', () => {
    it('returns true for a pro org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'pro' }));

      const result = await gate.canAddMember('org-1');

      expect(result).toBe(true);
    });

    it('returns false for a free org', async () => {
      mockOrgService.getOrg.mockResolvedValue(makeOrg({ plan: 'free' }));

      const result = await gate.canAddMember('org-1');

      expect(result).toBe(false);
    });
  });
});
