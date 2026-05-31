import { describe, it, expect } from 'vitest';
import { computeSeatBilling, DefaultSeatService, type SeatCounts } from './seat-service.js';
import { INCLUDED_AGENT_SEATS, ORG_FEE_CENTS, PER_SEAT_PRICE_CENTS } from './prices.js';

describe('computeSeatBilling — flat-pricing worked examples', () => {
  // FLAT model (Aaron 2026-05-26): monthly = ORG_FEE + PER_SEAT × billableSeats.
  // billableSeats = humans + max(0, agents − INCLUDED_AGENT_SEATS). The first
  // two agents are included (Shape-A); humans always bill. No credits, no tiers.
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
      name: 'small team (5 humans, 2 agents — both agents included)',
      counts: { humans: 5, agents: 2 },
      billableSeats: 5,
      monthlyTotalCents: 59_400, // $399 + $39×5
      includedAgents: 2,
      billedAgents: 0,
    },
    {
      name: 'agent-heavy (5 humans, 4 agents — 2 included, 2 billed)',
      counts: { humans: 5, agents: 4 },
      billableSeats: 7,
      monthlyTotalCents: 67_200, // $399 + $39×7
      includedAgents: 2,
      billedAgents: 2,
    },
    {
      name: 'human-heavy (10 humans, 1 agent — agent included)',
      counts: { humans: 10, agents: 1 },
      billableSeats: 10,
      monthlyTotalCents: 78_900, // $399 + $39×10
      includedAgents: 1,
      billedAgents: 0,
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

describe('computeSeatBilling — included-agent boundary', () => {
  it('agent #1 added (1h/0a → 1h/1a): bill unchanged (agent included)', () => {
    const before = computeSeatBilling({ humans: 1, agents: 0 });
    const after = computeSeatBilling({ humans: 1, agents: 1 });
    expect(after.monthlyTotalCents).toBe(before.monthlyTotalCents);
    expect(after.includedAgents).toBe(1);
    expect(after.billedAgents).toBe(0);
  });

  it('agent #2 added (1h/1a → 1h/2a): bill unchanged (agent included)', () => {
    const before = computeSeatBilling({ humans: 1, agents: 1 });
    const after = computeSeatBilling({ humans: 1, agents: 2 });
    expect(after.monthlyTotalCents).toBe(before.monthlyTotalCents);
    expect(after.includedAgents).toBe(2);
    expect(after.billedAgents).toBe(0);
  });

  it('agent #3 added (1h/2a → 1h/3a): bill +$39, billedAgents 0→1', () => {
    const before = computeSeatBilling({ humans: 1, agents: 2 });
    const after = computeSeatBilling({ humans: 1, agents: 3 });
    expect(after.monthlyTotalCents - before.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS);
    expect(after.includedAgents).toBe(2);
    expect(after.billedAgents).toBe(1);
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

describe('DefaultSeatService — wires OrgService into the same arithmetic', () => {
  function makeStubOrgService(humans: number, agents: number) {
    return {
      getMembers: async () =>
        Array.from({ length: humans }, (_, i) => ({ user_id: `u${i}` })),
      listServiceClients: async () =>
        Array.from({ length: agents }, (_, i) => ({ client_id: `c${i}` })),
    } as unknown as ConstructorParameters<typeof DefaultSeatService>[0];
  }

  it('getSeatCounts returns membership lengths verbatim', async () => {
    const svc = new DefaultSeatService(makeStubOrgService(5, 4));
    const counts = await svc.getSeatCounts('org-x');
    expect(counts).toEqual({ humans: 5, agents: 4 });
  });

  it('getSeatBilling returns the same snapshot as computeSeatBilling on raw counts', async () => {
    const svc = new DefaultSeatService(makeStubOrgService(5, 4));
    const fromService = await svc.getSeatBilling('org-x');
    const fromPure = computeSeatBilling({ humans: 5, agents: 4 });
    expect(fromService).toEqual(fromPure);
  });

  it('INCLUDED_AGENT_SEATS constant is the single knob for inclusion changes', () => {
    // Sanity: tests pin to the constant, not a literal 2. If Aaron ever
    // moves the term, this test file does not need updating beyond the
    // worked-example numbers.
    expect(INCLUDED_AGENT_SEATS).toBe(2);
  });
});
