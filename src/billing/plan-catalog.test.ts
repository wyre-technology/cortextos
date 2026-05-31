import { describe, it, expect } from 'vitest';
import { planCatalog, getPlan, getDefaultPlan, CONDUIT_PLAN_SLUG } from './plan-catalog.js';
import { ORG_FEE_CENTS, PER_SEAT_PRICE_CENTS } from './prices.js';

describe('plan-catalog — single flat plan', () => {
  it('catalog holds exactly one plan: conduit (no tiers)', () => {
    // Aaron 2026-05-26 FLAT decision: free/pro/business tiers removed. One plan.
    expect(planCatalog).toHaveLength(1);
    expect(planCatalog.map((p) => p.slug)).toEqual([CONDUIT_PLAN_SLUG]);
  });

  it('conduit plan is everything-included (all features on, all limits unlimited)', () => {
    const conduit = getPlan('conduit')!;
    expect(conduit.vendorLimit).toBe(Infinity);
    expect(conduit.teamFeatures).toBe(true);
    expect(conduit.logShipping).toBe(true);
    expect(conduit.promptCapture).toBe(true);
    expect(conduit.auditLogExport).toBe(true);
    expect(conduit.sso).toBe(true);
    expect(conduit.serviceClients).toBe(true);
    expect(conduit.maxMembers).toBe(Infinity);
  });

  it('flat prices live in prices.ts (the single-source constants)', () => {
    expect(ORG_FEE_CENTS).toBe(39_900);
    expect(PER_SEAT_PRICE_CENTS).toBe(3_900);
  });

  it('getPlan resolves ANY non-empty slug to the flat plan (legacy rows included)', () => {
    // Un-migrated org rows may still carry 'free'/'pro'/'business'; they
    // resolve cleanly to the one plan before the data migration rewrites them.
    for (const legacy of ['free', 'pro', 'business', 'enterprise', 'conduit']) {
      expect(getPlan(legacy)!.slug).toBe(CONDUIT_PLAN_SLUG);
    }
  });

  it('getPlan returns undefined only for genuinely-empty input', () => {
    expect(getPlan('')).toBeUndefined();
    expect(getPlan(null)).toBeUndefined();
    expect(getPlan(undefined)).toBeUndefined();
  });

  it('getDefaultPlan returns conduit (new orgs are paid-with-trial, not free)', () => {
    // Org creation attaches a trialing conduit subscription (no unpaid free
    // default). The trial_period_days wiring lives in checkout.ts.
    expect(getDefaultPlan().slug).toBe(CONDUIT_PLAN_SLUG);
  });
});
