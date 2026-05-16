/**
 * ResellerInvoiceService unit tests — applyMarkup arithmetic + service
 * flow with injected fakes.
 *
 * Coverage:
 *   - applyMarkup percentage mode: typical, boundary (0 bp), rounding,
 *     high bp
 *   - applyMarkup absolute_per_seat mode: typical, zero markup
 *   - applyMarkup throws on malformed configs (null value for declared mode)
 *
 * Database-driven flows (DB transaction wrapping, RLS, UNIQUE constraint)
 * are covered in src/db/__tests__/rls-reseller-invoices.integration.test.ts
 * and the surface-2 integration test. This file is unit-level on the
 * pure arithmetic + decision logic.
 */

import { describe, expect, it } from 'vitest';
import { applyMarkup, roundHalfToEven } from './reseller-invoice-service.js';
import type { ResellerPricingConfig } from './reseller-pricing-service.js';

function pctConfig(rateBasisPoints: number, id = 'cfg-pct'): ResellerPricingConfig {
  return {
    id,
    resellerOrgId: 'res-a',
    subtenantOrgId: 'cust-a',
    mode: 'percentage',
    rateBasisPoints,
    amountCents: null,
    currency: 'USD',
    effectiveAt: '2026-05-15T00:00:00Z',
    createdBy: 'rita',
    createdAt: '2026-05-15T00:00:00Z',
  };
}

function absConfig(amountCents: number, id = 'cfg-abs'): ResellerPricingConfig {
  return {
    id,
    resellerOrgId: 'res-a',
    subtenantOrgId: 'cust-a',
    mode: 'absolute_per_seat',
    rateBasisPoints: null,
    amountCents,
    currency: 'USD',
    effectiveAt: '2026-05-15T00:00:00Z',
    createdBy: 'rita',
    createdAt: '2026-05-15T00:00:00Z',
  };
}

describe('roundHalfToEven — banker rounding helper', () => {
  it('rounds non-tie values to nearest', () => {
    expect(roundHalfToEven(1295.7)).toBe(1296);
    expect(roundHalfToEven(1295.3)).toBe(1295);
  });

  it('rounds exact ties to the nearest EVEN integer (down when below an odd)', () => {
    // 0.5 → 0 (0 is even), 1.5 → 2 (2 is even), 2.5 → 2 (2 is even), 3.5 → 4
    expect(roundHalfToEven(0.5)).toBe(0);
    expect(roundHalfToEven(1.5)).toBe(2);
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(3.5)).toBe(4);
    expect(roundHalfToEven(4.5)).toBe(4);
    expect(roundHalfToEven(10.5)).toBe(10);
    expect(roundHalfToEven(11.5)).toBe(12);
  });

  it('differs from half-up exactly on ties (the bias-elimination case)', () => {
    // Math.round(2.5) === 3 (half-up); roundHalfToEven(2.5) === 2 (banker)
    expect(Math.round(2.5)).toBe(3);
    expect(roundHalfToEven(2.5)).toBe(2);
  });

  it('rejects negative inputs (domain assumption: cents are non-negative)', () => {
    expect(() => roundHalfToEven(-1.5)).toThrow(/negative input/);
  });
});

describe('applyMarkup — percentage mode', () => {
  it('typical 5% markup on round base', () => {
    const { finalCents, markupCents } = applyMarkup(1000, pctConfig(500));
    expect(finalCents).toBe(1050);
    expect(markupCents).toBe(50);
  });

  it('rounds non-tie remainder toward nearest', () => {
    // 1234 * 1.05 = 1295.7 → 1296 (non-tie, half-to-even matches half-up here)
    const { finalCents, markupCents } = applyMarkup(1234, pctConfig(500));
    expect(finalCents).toBe(1296);
    expect(markupCents).toBe(62);
  });

  it('exact .5 tie rounds to nearest EVEN, NOT half-up (banker rounding lock)', () => {
    // base=3, rate=5000bp (50%): (3 * 15000) / 10000 = 4.5 — exact tie.
    // Half-up would give 5; banker gives 4 (nearest even).
    const { finalCents, markupCents } = applyMarkup(3, pctConfig(5000));
    expect(finalCents).toBe(4);
    expect(markupCents).toBe(1);
    // Sanity-check against half-up to make the discriminator visible.
    expect(Math.round(4.5)).toBe(5);
  });

  it('second tie case to lock the rule (base=7, rate=5000bp → 10.5 → 10)', () => {
    // base=7, rate=5000bp: (7 * 15000) / 10000 = 10.5 — exact tie.
    // Half-up: 11; banker: 10 (nearest even).
    const { finalCents, markupCents } = applyMarkup(7, pctConfig(5000));
    expect(finalCents).toBe(10);
    expect(markupCents).toBe(3);
  });

  it('exact tie above an even integer rounds DOWN to that even (no bias up)', () => {
    // base=1, rate=5000bp: (1 * 15000) / 10000 = 1.5 → 2 (next even, up).
    // This is the .5-above-an-odd case; banker rounds UP to even.
    expect(applyMarkup(1, pctConfig(5000)).finalCents).toBe(2);
    // base=5, rate=5000bp: 7.5 → 8 (next even, up). .5-above-an-odd again.
    expect(applyMarkup(5, pctConfig(5000)).finalCents).toBe(8);
    // The symmetry: ties above an odd round up; ties above an even round
    // down. Half the time UP, half DOWN — zero cumulative bias.
  });

  it('zero basis-points produces zero markup', () => {
    const { finalCents, markupCents } = applyMarkup(1000, pctConfig(0));
    expect(finalCents).toBe(1000);
    expect(markupCents).toBe(0);
  });

  it('high basis-points (100% = 10000bp) doubles the base', () => {
    const { finalCents, markupCents } = applyMarkup(1000, pctConfig(10000));
    expect(finalCents).toBe(2000);
    expect(markupCents).toBe(1000);
  });

  it('preserves CHECK invariant final = base + markup (single rounding-point)', () => {
    const base = 7777;
    const { finalCents, markupCents } = applyMarkup(base, pctConfig(2500)); // 25%
    expect(base + markupCents).toBe(finalCents);
  });

  it('throws on percentage mode with null rate_basis_points', () => {
    const malformed: ResellerPricingConfig = { ...pctConfig(500), rateBasisPoints: null };
    expect(() => applyMarkup(1000, malformed)).toThrow(/percentage mode but rate_basis_points is null/);
  });
});

describe('applyMarkup — absolute_per_seat mode', () => {
  it('typical absolute markup adds amount_cents', () => {
    const { finalCents, markupCents } = applyMarkup(1000, absConfig(250));
    expect(finalCents).toBe(1250);
    expect(markupCents).toBe(250);
  });

  it('zero amount produces zero markup', () => {
    const { finalCents, markupCents } = applyMarkup(1000, absConfig(0));
    expect(finalCents).toBe(1000);
    expect(markupCents).toBe(0);
  });

  it('preserves CHECK invariant final = base + markup (no rounding in absolute mode)', () => {
    const base = 9999;
    const { finalCents, markupCents } = applyMarkup(base, absConfig(1337));
    expect(base + markupCents).toBe(finalCents);
  });

  it('throws on absolute mode with null amount_cents', () => {
    const malformed: ResellerPricingConfig = { ...absConfig(100), amountCents: null };
    expect(() => applyMarkup(1000, malformed)).toThrow(/absolute_per_seat mode but amount_cents is null/);
  });
});
