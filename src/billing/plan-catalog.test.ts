import { describe, it, expect } from 'vitest';
import { planCatalog, getPlan, getDefaultPlan } from './plan-catalog.js';
import { BASE_PRICE_CENTS, CREDITS_PER_SEAT, PER_SEAT_PRICE_CENTS } from './prices.js';

describe('plan-catalog', () => {
  it('loads default catalog with free, pro, business, and conduit plans', () => {
    // Layer 1 transition: conduit is THE paid plan; free/pro/business are
    // retained through WI-8 migration (groups B–E) and removed after.
    expect(planCatalog).toHaveLength(4);
    expect(planCatalog.map((p) => p.slug)).toEqual(['free', 'pro', 'business', 'conduit']);
  });

  it('conduit plan has Layer 1 paid-feature defaults and seat-credit allocation', () => {
    const conduit = getPlan('conduit')!;
    expect(conduit.vendorLimit).toBe(Infinity);
    expect(conduit.teamFeatures).toBe(true);
    expect(conduit.logShipping).toBe(true);
    expect(conduit.promptCapture).toBe(true);
    expect(conduit.auditLogExport).toBe(true);
    expect(conduit.sso).toBe(true);
    expect(conduit.serviceClients).toBe(true);
    expect(conduit.maxMembers).toBe(Infinity);
    // creditAllocation is the per-seat rate; gate.getCreditAllocation reads
    // CREDITS_PER_SEAT (prices.ts) — keep the catalog field in sync with
    // the constant so the lever is single-sourced.
    expect(conduit.creditAllocation).toBe(CREDITS_PER_SEAT);
  });

  it('Layer 1 prices live in prices.ts (the WI-1 single-source constants)', () => {
    expect(BASE_PRICE_CENTS).toBe(60_000);
    expect(PER_SEAT_PRICE_CENTS).toBe(2_000);
    expect(CREDITS_PER_SEAT).toBe(2_500);
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

  it('getDefaultPlan returns conduit (Layer 1 — new orgs are paid-with-trial, not free)', () => {
    // DOR §9.1: org creation creates a trialing conduit subscription, not
    // an unpaid free default. The trial_period_days wiring lives in
    // checkout.ts; this function names the plan org-creation attaches.
    expect(getDefaultPlan().slug).toBe('conduit');
  });
});
