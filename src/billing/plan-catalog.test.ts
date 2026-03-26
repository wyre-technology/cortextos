import { describe, it, expect } from 'vitest';
import { planCatalog, getPlan, getDefaultPlan } from './plan-catalog.js';

describe('plan-catalog', () => {
  it('loads default catalog with free and pro plans', () => {
    expect(planCatalog).toHaveLength(2);
    expect(planCatalog[0].slug).toBe('free');
    expect(planCatalog[1].slug).toBe('pro');
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

  it('getPlan returns undefined for unknown slug', () => {
    expect(getPlan('enterprise')).toBeUndefined();
  });

  it('getDefaultPlan returns free', () => {
    expect(getDefaultPlan().slug).toBe('free');
  });
});
