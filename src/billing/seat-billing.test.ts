import { describe, it, expect } from 'vitest';
import {
  mockSeatBilling,
  BASE_PRICE_CENTS,
  PER_SEAT_PRICE_CENTS,
  INCLUDED_AGENT_SEATS,
} from './seat-billing.js';

// Oracle: the four worked examples from the LOCKED decision-of-record §5.
// If mockSeatBilling's derivation drifts from the locked formulas, these
// rows go red.
describe('mockSeatBilling — decision-of-record §5 worked examples', () => {
  const rows = [
    { humans: 1, agents: 0, billableSeats: 1, creditSeats: 1 },
    { humans: 5, agents: 2, billableSeats: 5, creditSeats: 7 },
    { humans: 5, agents: 4, billableSeats: 7, creditSeats: 9 },
    { humans: 10, agents: 1, billableSeats: 10, creditSeats: 11 },
  ];
  for (const r of rows) {
    it(`${r.humans}h / ${r.agents}a → ${r.billableSeats} billable, ${r.creditSeats} credit`, () => {
      const sb = mockSeatBilling(r.humans, r.agents);
      expect(sb.billableSeats).toBe(r.billableSeats);
      expect(sb.creditSeats).toBe(r.creditSeats);
    });
  }
});

describe('mockSeatBilling — the 2-included-agent split', () => {
  it('0 agents — nothing included, nothing billed', () => {
    const sb = mockSeatBilling(3, 0);
    expect(sb.includedAgentCount).toBe(0);
    expect(sb.billedAgentCount).toBe(0);
  });
  it('1 agent — within the inclusion', () => {
    const sb = mockSeatBilling(3, 1);
    expect(sb.includedAgentCount).toBe(1);
    expect(sb.billedAgentCount).toBe(0);
    expect(sb.billableSeats).toBe(3); // agent adds no $20 line
  });
  it('2 agents — inclusion full, still nothing billed', () => {
    const sb = mockSeatBilling(3, 2);
    expect(sb.includedAgentCount).toBe(2);
    expect(sb.billedAgentCount).toBe(0);
    expect(sb.billableSeats).toBe(3);
  });
  it('3 agents — the 3rd agent is the first billed one', () => {
    const sb = mockSeatBilling(3, 3);
    expect(sb.includedAgentCount).toBe(2);
    expect(sb.billedAgentCount).toBe(1);
    expect(sb.billableSeats).toBe(4); // 3 humans + 1 billed agent
  });
  it('includedAgentCount never exceeds the 2-seat allowance', () => {
    expect(mockSeatBilling(1, 9).includedAgentCount).toBe(INCLUDED_AGENT_SEATS);
  });
});

describe('mockSeatBilling — price constants', () => {
  it('emits the locked $600 base / $20 per-seat in cents', () => {
    const sb = mockSeatBilling(1, 0);
    expect(sb.basePriceCents).toBe(BASE_PRICE_CENTS);
    expect(sb.perSeatPriceCents).toBe(PER_SEAT_PRICE_CENTS);
    expect(BASE_PRICE_CENTS).toBe(60_000);
    expect(PER_SEAT_PRICE_CENTS).toBe(2_000);
  });
});
