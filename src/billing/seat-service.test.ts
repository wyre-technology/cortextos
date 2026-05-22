import { describe, it, expect } from 'vitest';
import { computeSeatBilling, DefaultSeatService, type SeatCounts } from './seat-service.js';
import {
  BASE_PRICE_CENTS,
  CREDITS_PER_SEAT,
  INCLUDED_AGENT_SEATS,
  PER_SEAT_PRICE_CENTS,
} from './prices.js';

describe('computeSeatBilling — DOR §5 worked examples', () => {
  // The DOR §5 table is the contract. These rows are the authoritative
  // shape of the model — if any row diverges from the spec doc, the
  // implementation is wrong, not the test.
  const cases: Array<{
    name: string;
    counts: SeatCounts;
    billableSeats: number;
    creditSeats: number;
    monthlyTotalCents: number;
    monthlyCreditAllocation: number;
    includedAgents: number;
    billedAgents: number;
  }> = [
    {
      name: 'new org (1 human, 0 agents)',
      counts: { humans: 1, agents: 0 },
      billableSeats: 1,
      creditSeats: 1,
      monthlyTotalCents: 62_000, // $620.00
      monthlyCreditAllocation: 2_500,
      includedAgents: 0,
      billedAgents: 0,
    },
    {
      name: 'small team (5 humans, 2 agents — both agents included)',
      counts: { humans: 5, agents: 2 },
      billableSeats: 5,
      creditSeats: 7,
      monthlyTotalCents: 70_000, // $700.00
      monthlyCreditAllocation: 17_500,
      includedAgents: 2,
      billedAgents: 0,
    },
    {
      name: 'agent-heavy (5 humans, 4 agents — 2 included, 2 billed)',
      counts: { humans: 5, agents: 4 },
      billableSeats: 7,
      creditSeats: 9,
      monthlyTotalCents: 74_000, // $740.00
      monthlyCreditAllocation: 22_500,
      includedAgents: 2,
      billedAgents: 2,
    },
    {
      name: 'human-heavy (10 humans, 1 agent — agent included)',
      counts: { humans: 10, agents: 1 },
      billableSeats: 10,
      creditSeats: 11,
      monthlyTotalCents: 80_000, // $800.00
      monthlyCreditAllocation: 27_500,
      includedAgents: 1,
      billedAgents: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const b = computeSeatBilling(c.counts);
      expect(b.counts).toEqual(c.counts);
      expect(b.billableSeats).toBe(c.billableSeats);
      expect(b.creditSeats).toBe(c.creditSeats);
      expect(b.includedAgents).toBe(c.includedAgents);
      expect(b.billedAgents).toBe(c.billedAgents);
      expect(b.monthlyTotalCents).toBe(c.monthlyTotalCents);
      expect(b.monthlyCreditAllocation).toBe(c.monthlyCreditAllocation);
    });
  }
});

describe('computeSeatBilling — included-agent boundary', () => {
  it('agent #1 added (1h/0a → 1h/1a): bill unchanged, credits +2500', () => {
    const before = computeSeatBilling({ humans: 1, agents: 0 });
    const after = computeSeatBilling({ humans: 1, agents: 1 });
    expect(after.monthlyTotalCents).toBe(before.monthlyTotalCents);
    expect(after.monthlyCreditAllocation - before.monthlyCreditAllocation).toBe(CREDITS_PER_SEAT);
    expect(after.includedAgents).toBe(1);
    expect(after.billedAgents).toBe(0);
  });

  it('agent #2 added (1h/1a → 1h/2a): bill unchanged, credits +2500', () => {
    const before = computeSeatBilling({ humans: 1, agents: 1 });
    const after = computeSeatBilling({ humans: 1, agents: 2 });
    expect(after.monthlyTotalCents).toBe(before.monthlyTotalCents);
    expect(after.monthlyCreditAllocation - before.monthlyCreditAllocation).toBe(CREDITS_PER_SEAT);
    expect(after.includedAgents).toBe(2);
    expect(after.billedAgents).toBe(0);
  });

  it('agent #3 added (1h/2a → 1h/3a): bill +$20, credits +2500, billedAgents 0→1', () => {
    const before = computeSeatBilling({ humans: 1, agents: 2 });
    const after = computeSeatBilling({ humans: 1, agents: 3 });
    expect(after.monthlyTotalCents - before.monthlyTotalCents).toBe(PER_SEAT_PRICE_CENTS);
    expect(after.monthlyCreditAllocation - before.monthlyCreditAllocation).toBe(CREDITS_PER_SEAT);
    expect(after.includedAgents).toBe(2);
    expect(after.billedAgents).toBe(1);
  });

  it('reconciliation identity holds for every plausible (h,a) up to (20,10)', () => {
    // DOR §3: includedAgents + billedAgents === agents (by construction).
    // PR-A §2 reconciliation: includedAgents + (billableSeats − humans) === agents.
    // Both must hold for every input.
    for (let h = 0; h <= 20; h++) {
      for (let a = 0; a <= 10; a++) {
        const b = computeSeatBilling({ humans: h, agents: a });
        expect(b.includedAgents + b.billedAgents).toBe(a);
        expect(b.creditSeats).toBe(h + a);
        expect(b.billableSeats).toBe(h + b.billedAgents);
        expect(b.monthlyTotalCents).toBe(
          BASE_PRICE_CENTS + PER_SEAT_PRICE_CENTS * b.billableSeats,
        );
        expect(b.monthlyCreditAllocation).toBe(CREDITS_PER_SEAT * b.creditSeats);
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
  it('clamps negative counts to zero rather than producing negative bill or credits', () => {
    const b = computeSeatBilling({ humans: -5, agents: -2 });
    expect(b.counts.humans).toBe(0);
    expect(b.counts.agents).toBe(0);
    expect(b.billableSeats).toBe(0);
    expect(b.creditSeats).toBe(0);
    expect(b.monthlyTotalCents).toBe(BASE_PRICE_CENTS);
    expect(b.monthlyCreditAllocation).toBe(0);
  });

  it('truncates non-integer counts (defensive — call sites should pass integers)', () => {
    const b = computeSeatBilling({ humans: 2.9, agents: 1.5 });
    expect(b.counts.humans).toBe(2);
    expect(b.counts.agents).toBe(1);
  });

  it('empty org (0 humans, 0 agents) → base only, no credits — degenerate but well-defined', () => {
    const b = computeSeatBilling({ humans: 0, agents: 0 });
    expect(b.monthlyTotalCents).toBe(BASE_PRICE_CENTS);
    expect(b.monthlyCreditAllocation).toBe(0);
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
    // worked-example numbers in the DOR §5 table.
    expect(INCLUDED_AGENT_SEATS).toBe(2);
  });
});
