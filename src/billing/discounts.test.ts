import { describe, it, expect } from 'vitest';
import {
  applyDiscounts,
  hasAnyDiscount,
  isOrgFeeFullyWaived,
  type OrgDiscount,
} from './discounts.js';

const EAP: OrgDiscount = Object.freeze({
  reason: 'eap',
  appliesTo: 'org_fee',
  percent: 100,
  grantedBy: 'admin-x',
  grantedAt: '2026-06-18T00:00:00.000Z',
});

const ANNUAL_15: OrgDiscount = Object.freeze({
  reason: 'annual_prepay',
  appliesTo: 'invoice_total',
  percent: 15,
  grantedBy: 'admin-x',
  grantedAt: '2026-06-18T00:00:00.000Z',
});

const HALF_OFF_ORG_FEE: OrgDiscount = Object.freeze({
  reason: 'eap',
  appliesTo: 'org_fee',
  percent: 50,
  grantedBy: 'admin-x',
  grantedAt: '2026-06-18T00:00:00.000Z',
});

describe('applyDiscounts — no discounts (the identity case)', () => {
  it('preserves base + seatTotal verbatim, monthlyTotal = base + seatTotal', () => {
    const bill = applyDiscounts(39_900, 19_500, []);
    expect(bill.baseCents).toBe(39_900);
    expect(bill.seatTotalCents).toBe(19_500);
    expect(bill.monthlyTotalCents).toBe(59_400);
    expect(bill.appliedDiscounts).toEqual([]);
  });
});

describe('applyDiscounts — EAP (100% org_fee)', () => {
  it('drops baseCents to 0; seatTotal untouched; monthlyTotal = seatTotal', () => {
    // 5 humans + 2 agents = 7 seats × $39 = $273 seat total. Base waived.
    const bill = applyDiscounts(39_900, 27_300, [EAP]);
    expect(bill.baseCents).toBe(0);
    expect(bill.seatTotalCents).toBe(27_300);
    expect(bill.monthlyTotalCents).toBe(27_300);
    expect(bill.appliedDiscounts).toEqual([EAP]);
  });

  it('makes isOrgFeeFullyWaived true — the subscription-factory item-omission signal', () => {
    expect(isOrgFeeFullyWaived([EAP])).toBe(true);
    expect(isOrgFeeFullyWaived([])).toBe(false);
  });

  it('survives smallest-paid-org (1h, 0a, $39 seat total) — base waived → $39/mo', () => {
    const bill = applyDiscounts(39_900, 3_900, [EAP]);
    expect(bill.monthlyTotalCents).toBe(3_900);
  });

  it('agent-heavy waived org (5h, 4a, 9×$39=$351 seats) → $351/mo, no base', () => {
    const bill = applyDiscounts(39_900, 35_100, [EAP]);
    expect(bill.baseCents).toBe(0);
    expect(bill.monthlyTotalCents).toBe(35_100);
  });
});

describe('applyDiscounts — partial org_fee discount', () => {
  it('50% off org_fee → base $399 → $199 (floor), seat untouched', () => {
    const bill = applyDiscounts(39_900, 27_300, [HALF_OFF_ORG_FEE]);
    expect(bill.baseCents).toBe(19_950);
    expect(bill.seatTotalCents).toBe(27_300);
    expect(bill.monthlyTotalCents).toBe(47_250);
    expect(isOrgFeeFullyWaived([HALF_OFF_ORG_FEE])).toBe(false);
  });
});

describe('applyDiscounts — invoice_total (annual-prepay (c) preview)', () => {
  it('15% off the invoice total after base+seat are summed', () => {
    // base=$399, seat=$273 → pre=$672 → 15% off = $571.20 → floor = $571
    const bill = applyDiscounts(39_900, 27_300, [ANNUAL_15]);
    expect(bill.baseCents).toBe(39_900); // org_fee untouched
    expect(bill.seatTotalCents).toBe(27_300);
    expect(bill.monthlyTotalCents).toBe(Math.floor(67_200 * 0.85));
  });
});

describe('applyDiscounts — composition: EAP + annual together', () => {
  it('org_fee waived first, then invoice_total 15% applied on (0 + seatTotal)', () => {
    // base=$0 (waived), seat=$273 → pre=$273 → 15% off = $232.05 → floor = $232
    const bill = applyDiscounts(39_900, 27_300, [EAP, ANNUAL_15]);
    expect(bill.baseCents).toBe(0);
    expect(bill.seatTotalCents).toBe(27_300);
    expect(bill.monthlyTotalCents).toBe(Math.floor(27_300 * 0.85));
  });
});

describe('applyDiscounts — defensive input clamping', () => {
  it('clamps negative cents to zero', () => {
    const bill = applyDiscounts(-1000, -500, []);
    expect(bill.baseCents).toBe(0);
    expect(bill.seatTotalCents).toBe(0);
    expect(bill.monthlyTotalCents).toBe(0);
  });

  it('clamps over-100% percent to 100 (waiver shape) — never negative bill', () => {
    const dodgy: OrgDiscount = { ...EAP, percent: 500 };
    const bill = applyDiscounts(39_900, 27_300, [dodgy]);
    expect(bill.baseCents).toBe(0);
    expect(bill.monthlyTotalCents).toBe(27_300);
  });

  it('clamps negative percent to 0 (no-op) — never inflates bill', () => {
    const dodgy: OrgDiscount = { ...EAP, percent: -25 };
    const bill = applyDiscounts(39_900, 27_300, [dodgy]);
    expect(bill.baseCents).toBe(39_900);
    expect(bill.monthlyTotalCents).toBe(67_200);
  });

  it('returns a frozen result — defense-in-depth against accidental mutation', () => {
    const bill = applyDiscounts(39_900, 27_300, [EAP]);
    expect(Object.isFrozen(bill)).toBe(true);
    expect(Object.isFrozen(bill.appliedDiscounts)).toBe(true);
    expect(() => {
      (bill as unknown as { baseCents: number }).baseCents = 999;
    }).toThrow();
  });
});

describe('hasAnyDiscount', () => {
  it('false for empty, true for any non-empty', () => {
    expect(hasAnyDiscount([])).toBe(false);
    expect(hasAnyDiscount([EAP])).toBe(true);
    expect(hasAnyDiscount([ANNUAL_15])).toBe(true);
    expect(hasAnyDiscount([EAP, ANNUAL_15])).toBe(true);
  });
});

describe('isOrgFeeFullyWaived — drives subscription-factory item-omission', () => {
  it('one 100% org_fee discount → true', () => {
    expect(isOrgFeeFullyWaived([EAP])).toBe(true);
  });
  it('two 50% org_fee discounts stack multiplicatively → 75% off, NOT waived', () => {
    expect(isOrgFeeFullyWaived([HALF_OFF_ORG_FEE, HALF_OFF_ORG_FEE])).toBe(false);
  });
  it('invoice_total discount alone → org_fee NOT waived (the item stays)', () => {
    expect(isOrgFeeFullyWaived([ANNUAL_15])).toBe(false);
  });
  it('empty → false', () => {
    expect(isOrgFeeFullyWaived([])).toBe(false);
  });
});
