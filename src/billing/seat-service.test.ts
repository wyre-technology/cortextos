import { describe, it, expect } from 'vitest';
import { computeSeatBilling, DefaultSeatService, type SeatCounts } from './seat-service.js';
import { INCLUDED_AGENT_SEATS, ORG_FEE_CENTS, PER_SEAT_PRICE_CENTS } from './prices.js';
import type { OrgDiscount } from './discounts.js';

const EAP_WAIVER: OrgDiscount = Object.freeze({
  reason: 'eap',
  appliesTo: 'org_fee',
  percent: 100,
  grantedBy: 'admin-x',
  grantedAt: '2026-06-18T00:00:00.000Z',
});

describe('computeSeatBilling — flat-pricing worked examples', () => {
  // FLAT model (Aaron 2026-05-26) + AGENTS-BILLABLE (Aaron 2026-06-17,
  // WYREAI-25): monthly = ORG_FEE + PER_SEAT × billableSeats.
  // billableSeats = humans + max(0, agents − INCLUDED_AGENT_SEATS). With
  // INCLUDED_AGENT_SEATS=0 this reduces to humans + agents. Every seat
  // bills from seat 1; agents and humans at the same per-seat rate.
  const cases: Array<{
    name: string;
    counts: SeatCounts;
    billableSeats: number;
    monthlyTotalCents: number;
    includedAgents: number;
    billedAgents: number;
  }> = [
    {
      name: 'new org (1 human, 0 agents)',
      counts: { humans: 1, agents: 0 },
      billableSeats: 1,
      monthlyTotalCents: 43_800, // $399 + $39×1
      includedAgents: 0,
      billedAgents: 0,
    },
    {
      name: 'solo MSP technician with 1 agent (1 human, 1 agent) — both billable',
      counts: { humans: 1, agents: 1 },
      billableSeats: 2,
      monthlyTotalCents: 47_700, // $399 + $39×2
      includedAgents: 0,
      billedAgents: 1,
    },
    {
      name: 'small team (5 humans, 2 agents) — all billable, no inclusion',
      counts: { humans: 5, agents: 2 },
      billableSeats: 7,
      monthlyTotalCents: 67_200, // $399 + $39×7
      includedAgents: 0,
      billedAgents: 2,
    },
    {
      name: 'agent-heavy (5 humans, 4 agents) — 9 billable seats',
      counts: { humans: 5, agents: 4 },
      billableSeats: 9,
      monthlyTotalCents: 75_000, // $399 + $39×9
      includedAgents: 0,
      billedAgents: 4,
    },
    {
      name: 'human-heavy (10 humans, 1 agent) — 11 billable seats',
      counts: { humans: 10, agents: 1 },
      billableSeats: 11,
      monthlyTotalCents: 82_800, // $399 + $39×11
      includedAgents: 0,
      billedAgents: 1,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const b = computeSeatBilling(c.counts);
      expect(b.counts).toEqual(c.counts);
      expect(b.billableSeats).toBe(c.billableSeats);
      expect(b.includedAgents).toBe(c.includedAgents);
      expect(b.billedAgents).toBe(c.billedAgents);
      expect(b.monthlyTotalCents).toBe(c.monthlyTotalCents);
    });
  }
});

describe('computeSeatBilling — agent-add boundary (no free-agent tier)', () => {
  it('agent #1 added (1h/0a → 1h/1a): bill +$39, billedAgents 0→1', () => {
    const before = computeSeatBilling({ humans: 1, agents: 0 });
    const after = computeSeatBilling({ humans: 1, agents: 1 });
    expect(after.monthlyTotalCents - before.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS);
    expect(after.includedAgents).toBe(0);
    expect(after.billedAgents).toBe(1);
  });

  it('agent #2 added (1h/1a → 1h/2a): bill +$39, billedAgents 1→2', () => {
    const before = computeSeatBilling({ humans: 1, agents: 1 });
    const after = computeSeatBilling({ humans: 1, agents: 2 });
    expect(after.monthlyTotalCents - before.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS);
    expect(after.includedAgents).toBe(0);
    expect(after.billedAgents).toBe(2);
  });

  it('agent #3 added (1h/2a → 1h/3a): bill +$39, billedAgents 2→3', () => {
    const before = computeSeatBilling({ humans: 1, agents: 2 });
    const after = computeSeatBilling({ humans: 1, agents: 3 });
    expect(after.monthlyTotalCents - before.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS);
    expect(after.includedAgents).toBe(0);
    expect(after.billedAgents).toBe(3);
  });

  it('reconciliation identity holds for every plausible (h,a) up to (20,10)', () => {
    // includedAgents + billedAgents === agents (by construction).
    // billableSeats === humans + billedAgents.
    // monthlyTotalCents === ORG_FEE + PER_SEAT × billableSeats.
    for (let h = 0; h <= 20; h++) {
      for (let a = 0; a <= 10; a++) {
        const b = computeSeatBilling({ humans: h, agents: a });
        expect(b.includedAgents + b.billedAgents).toBe(a);
        expect(b.billableSeats).toBe(h + b.billedAgents);
        expect(b.monthlyTotalCents).toBe(
          ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS * b.billableSeats,
        );
      }
    }
  });
});

describe('computeSeatBilling — determinism and immutability', () => {
  it('same input ⇒ same output (structural equality)', () => {
    const a = computeSeatBilling({ humans: 3, agents: 4 });
    const b = computeSeatBilling({ humans: 3, agents: 4 });
    expect(a).toEqual(b);
  });

  it('returned snapshot is frozen — trial-end charge contract is type-enforced', () => {
    const b = computeSeatBilling({ humans: 5, agents: 2 });
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.counts)).toBe(true);
    expect(() => {
      (b as unknown as { billableSeats: number }).billableSeats = 999;
    }).toThrow();
  });
});

describe('computeSeatBilling — defensive input handling', () => {
  it('clamps negative counts to zero rather than producing a negative bill', () => {
    const b = computeSeatBilling({ humans: -5, agents: -2 });
    expect(b.counts.humans).toBe(0);
    expect(b.counts.agents).toBe(0);
    expect(b.billableSeats).toBe(0);
    expect(b.monthlyTotalCents).toBe(ORG_FEE_CENTS);
  });

  it('truncates non-integer counts (defensive — call sites should pass integers)', () => {
    const b = computeSeatBilling({ humans: 2.9, agents: 1.5 });
    expect(b.counts.humans).toBe(2);
    expect(b.counts.agents).toBe(1);
  });

  it('empty org (0 humans, 0 agents) → org fee only — degenerate but well-defined', () => {
    const b = computeSeatBilling({ humans: 0, agents: 0 });
    expect(b.monthlyTotalCents).toBe(ORG_FEE_CENTS);
    expect(b.includedAgents).toBe(0);
  });
});

describe('computeSeatBilling — discount integration (WYREAI-25 EAP slice)', () => {
  // The page-and-billing-agree contract from PR (a) extends to discounts
  // via the shared applyDiscounts helper. computeSeatBilling, the team-
  // billing page, AND subscription-factory all read the same SeatBilling
  // snapshot — no parallel arithmetic.

  it('un-discounted org is byte-identical to omitting the discounts arg', () => {
    const without = computeSeatBilling({ humans: 5, agents: 2 });
    const withEmpty = computeSeatBilling({ humans: 5, agents: 2 }, []);
    expect(without).toEqual(withEmpty);
    expect(without.discounts).toEqual([]);
    expect(without.baseCents).toBe(ORG_FEE_CENTS);
  });

  it('EAP waiver → baseCents=0, monthlyTotalCents = seatTotal, discounts surfaces row', () => {
    const sb = computeSeatBilling({ humans: 5, agents: 2 }, [EAP_WAIVER]);
    expect(sb.baseCents).toBe(0);
    expect(sb.seatTotalCents).toBe(PER_SEAT_PRICE_CENTS * 7); // 5h + 2a = 7 billable
    expect(sb.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS * 7); // base waived
    expect(sb.discounts).toEqual([EAP_WAIVER]);
  });

  it('EAP waiver preserves billableSeats — only the BASE is dropped, seat math untouched', () => {
    const sb = computeSeatBilling({ humans: 5, agents: 4 }, [EAP_WAIVER]);
    expect(sb.billableSeats).toBe(9); // 5h + 4a, AGENTS-BILLABLE math
    expect(sb.baseCents).toBe(0);
    expect(sb.seatTotalCents).toBe(PER_SEAT_PRICE_CENTS * 9);
    expect(sb.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS * 9);
  });

  it('EAP-waived snapshot is still frozen — trial-end contract is type-enforced', () => {
    const sb = computeSeatBilling({ humans: 5, agents: 2 }, [EAP_WAIVER]);
    expect(Object.isFrozen(sb)).toBe(true);
    expect(Object.isFrozen(sb.discounts)).toBe(true);
  });
});

describe('DefaultSeatService — wires OrgService into the same arithmetic', () => {
  function makeStubOrgService(humans: number, agents: number) {
    return {
      getMembers: async () =>
        Array.from({ length: humans }, (_, i) => ({ user_id: `u${i}` })),
      listServiceClients: async () =>
        Array.from({ length: agents }, (_, i) => ({ client_id: `c${i}` })),
    } as unknown as ConstructorParameters<typeof DefaultSeatService>[0];
  }

  function makeStubDiscountService(discounts: ReadonlyArray<OrgDiscount>) {
    return {
      getDiscounts: async () => discounts,
    };
  }

  it('getSeatCounts returns membership lengths verbatim', async () => {
    const svc = new DefaultSeatService(makeStubOrgService(5, 4));
    const counts = await svc.getSeatCounts('org-x');
    expect(counts).toEqual({ humans: 5, agents: 4 });
  });

  it('getSeatBilling returns the same snapshot as computeSeatBilling on raw counts (no discount service)', async () => {
    const svc = new DefaultSeatService(makeStubOrgService(5, 4));
    const fromService = await svc.getSeatBilling('org-x');
    const fromPure = computeSeatBilling({ humans: 5, agents: 4 });
    expect(fromService).toEqual(fromPure);
  });

  it('getSeatBilling honors EAP discount when the discount service returns one', async () => {
    const svc = new DefaultSeatService(
      makeStubOrgService(5, 4),
      makeStubDiscountService([EAP_WAIVER]),
    );
    const sb = await svc.getSeatBilling('org-x');
    expect(sb.baseCents).toBe(0);
    expect(sb.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS * 9);
    expect(sb.discounts).toEqual([EAP_WAIVER]);
  });

  it('getSeatBilling on an un-discounted org with the service present returns no-discount snapshot', async () => {
    const svc = new DefaultSeatService(
      makeStubOrgService(5, 4),
      makeStubDiscountService([]),
    );
    const sb = await svc.getSeatBilling('org-x');
    expect(sb.baseCents).toBe(ORG_FEE_CENTS);
    expect(sb.discounts).toEqual([]);
  });

  it('INCLUDED_AGENT_SEATS constant is the single knob for inclusion changes', () => {
    // Sanity: tests pin to the constant, not a literal value. Aaron's
    // 2026-06-17 AGENTS-BILLABLE decision (WYREAI-25, boss msg-1781747082415)
    // set this to 0 — every agent bills from seat 1, identical to a human.
    // If a future Shape-A or promotional inclusion lands, this test catches
    // the change without rewriting the worked-example arithmetic.
    expect(INCLUDED_AGENT_SEATS).toBe(0);
  });
});
