import { describe, it, expect } from 'vitest';
import { planCatalog, getPlan, getDefaultPlan } from './plan-catalog.js';

describe('plan-catalog', () => {
  it('loads default catalog with free, pro, and business plans', () => {
    expect(planCatalog).toHaveLength(3);
    expect(planCatalog[0].slug).toBe('free');
    expect(planCatalog[1].slug).toBe('pro');
    expect(planCatalog[2].slug).toBe('business');
  });

  it('free plan has correct defaults', () => {
    const free = getPlan('free')!;
    expect(free.vendorLimit).toBe(3);
    expect(free.rateLimitPerHour).toBe(100);
    expect(free.teamFeatures).toBe(false);
    expect(free.logShipping).toBe(false);
    expect(free.promptCapture).toBe(false);
    expect(free.maxMembers).toBe(1);
  });

  it('pro plan has correct defaults', () => {
    const pro = getPlan('pro')!;
    expect(pro.vendorLimit).toBe(Infinity);
    expect(pro.rateLimitPerHour).toBe(1000);
    expect(pro.teamFeatures).toBe(true);
    expect(pro.logShipping).toBe(true);
    expect(pro.promptCapture).toBe(true);
    expect(pro.maxMembers).toBe(Infinity);
  });

  it('business plan has business-tier features enabled', () => {
    const business = getPlan('business')!;
    expect(business.vendorLimit).toBe(Infinity);
    expect(business.rateLimitPerHour).toBe(5000);
    expect(business.teamFeatures).toBe(true);
    expect(business.logShipping).toBe(true);
    expect(business.promptCapture).toBe(true);
    expect(business.auditLogExport).toBe(true);
    expect(business.sso).toBe(true);
    expect(business.serviceClients).toBe(true);
    expect(business.maxMembers).toBe(Infinity);
  });

  it('pro plan does not have business-tier features', () => {
    const pro = getPlan('pro')!;
    expect(pro.auditLogExport).toBe(false);
    expect(pro.sso).toBe(false);
    expect(pro.serviceClients).toBe(false);
  });

  it('getPlan returns undefined for unknown slug', () => {
    expect(getPlan('enterprise')).toBeUndefined();
  });

  it('getDefaultPlan returns free', () => {
    expect(getDefaultPlan().slug).toBe('free');
  });
});
