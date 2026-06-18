import { describe, it, expect } from 'vitest';
import { makeSeatBilling } from './test-helpers/seat-billing-fixture.js';
import {
  formatUsd,
  formatUsdExact,
  composedBillLine,
  seatBreakdownLine,
  agentSeatConsentCopy,
  memberSeatConsentCopy,
} from './seat-billing-copy.js';

describe('formatUsd', () => {
  it('renders whole dollars with no decimals', () => {
    expect(formatUsd(60_000)).toBe('$600');
    expect(formatUsd(2_000)).toBe('$20');
    expect(formatUsd(0)).toBe('$0');
  });
  it('groups thousands', () => {
    expect(formatUsd(740_00)).toBe('$740');
    expect(formatUsd(1_240_00)).toBe('$1,240');
  });
  it('shows cents only when not whole', () => {
    expect(formatUsd(650)).toBe('$6.50');
  });
});

describe('formatUsdExact', () => {
  it('always renders 2 decimals — charge-amount convention', () => {
    expect(formatUsdExact(62_000)).toBe('$620.00');
    expect(formatUsdExact(74_000)).toBe('$740.00');
    expect(formatUsdExact(650)).toBe('$6.50');
  });
  it('groups thousands', () => {
    expect(formatUsdExact(1_240_00)).toBe('$1,240.00');
  });
});

describe('composedBillLine reads monthlyTotalCents off the snapshot', () => {
  // AGENTS-BILLABLE (Aaron 2026-06-17, WYREAI-25, boss msg-1781747082415):
  // INCLUDED_AGENT_SEATS=0 → billableSeats = humans + agents. Every seat bills.
  it('reconciles base + perSeat × billableSeats (5h/2a → $672)', () => {
    const sb = makeSeatBilling(5, 2);
    expect(sb.monthlyTotalCents).toBe(67_200);
    expect(composedBillLine(sb)).toBe('$399 base + 7 seats × $39 = $672/mo');
  });
  it('agent-heavy org — every agent adds to the line (5h/4a → $750)', () => {
    expect(composedBillLine(makeSeatBilling(5, 4)))
      .toBe('$399 base + 9 seats × $39 = $750/mo');
  });
  it('smallest paid org — 1 human, 0 agents → $438', () => {
    expect(composedBillLine(makeSeatBilling(1, 0)))
      .toBe('$399 base + 1 seat × $39 = $438/mo');
  });
});

describe('seatBreakdownLine — the seat breakdown line', () => {
  // No free-agent tier — the breakdown is a clean comma-list, no inclusion split.
  it('humans + agents — period-comma format (5h/2a)', () => {
    expect(seatBreakdownLine(makeSeatBilling(5, 2)))
      .toBe('7 seats. 5 members, 2 agents.');
  });
  it('agent-heavy (5h/4a)', () => {
    expect(seatBreakdownLine(makeSeatBilling(5, 4)))
      .toBe('9 seats. 5 members, 4 agents.');
  });
  it('one agent — singular agent noun', () => {
    expect(seatBreakdownLine(makeSeatBilling(5, 1)))
      .toBe('6 seats. 5 members, 1 agent.');
  });
  it('zero agents — drop the agents clause for a cleaner read', () => {
    expect(seatBreakdownLine(makeSeatBilling(5, 0))).toBe('5 seats. 5 members.');
  });
  it('singular member', () => {
    expect(seatBreakdownLine(makeSeatBilling(1, 0))).toBe('1 seat. 1 member.');
  });
});

describe('agentSeatConsentCopy — every agent is a billable $39 line', () => {
  it('adding agent #1 (0 agents now) — $39, plain proration', () => {
    expect(agentSeatConsentCopy(makeSeatBilling(5, 0), { trialing: false }))
      .toBe('Adds 1 agent seat. $39/mo, prorated for the remainder of this cycle.');
  });
  it('adding agent #2 (1 agent now) — still $39 (no inclusion tier)', () => {
    expect(agentSeatConsentCopy(makeSeatBilling(5, 1), { trialing: false }))
      .toBe('Adds 1 agent seat. $39/mo, prorated for the remainder of this cycle.');
  });
  it('adding agent #3 (2 agents now) — unchanged copy, all agents bill identically', () => {
    expect(agentSeatConsentCopy(makeSeatBilling(5, 2), { trialing: false }))
      .toBe('Adds 1 agent seat. $39/mo, prorated for the remainder of this cycle.');
  });
  it('adding a billed agent during a trial — charge framed at trial end', () => {
    expect(agentSeatConsentCopy(makeSeatBilling(5, 2), { trialing: true }))
      .toBe('Adds 1 agent seat. $39/mo, applied when your trial ends.');
  });
  it('never shows a computed dollar proration figure', () => {
    const copy = agentSeatConsentCopy(makeSeatBilling(5, 5), { trialing: false });
    expect(copy).not.toMatch(/\$\d+\.\d/); // no "$X.XX this cycle"
  });
});

describe('memberSeatConsentCopy — a human seat is always $39', () => {
  it('plain proration off-trial', () => {
    expect(memberSeatConsentCopy(makeSeatBilling(5, 0), { trialing: false }))
      .toBe('Adds 1 member seat. $39/mo, prorated for the remainder of this cycle.');
  });
  it('trial framing on-trial', () => {
    expect(memberSeatConsentCopy(makeSeatBilling(5, 0), { trialing: true }))
      .toBe('Adds 1 member seat. $39/mo, applied when your trial ends.');
  });
});
