// Layer 1 §8 — seat-billing presentation layer (Pearl-owned).
//
// The data layer (src/billing/seat-billing.ts, SeatBilling) single-sources
// the seat MATH and emits cents + integers. This module single-sources the
// PRESENTATION — money formatting, the composed-bill line, the
// inclusion-explicit seat line, the agent-seat consent copy. Every §8
// surface (billing page, service-client create, member add) imports from
// here so the copy cannot drift between surfaces.
//
// Pure functions, no escaping — callers escapeHtml at the interpolation
// site. No surface here renders a number that can disagree with the real
// source: the bill total is derived from the same SeatBilling the data
// layer emits, proration is described in plain language (never a computed
// dollar figure that could disagree with Stripe's actual proration).

import type { SeatBilling } from '../../billing/seat-billing.js';

/** Whole-dollar cents → "$600"; non-whole → "$6.50". Thousands grouped. */
export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return '$' + dollars.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** Total monthly charge in cents: base + perSeat × billableSeats. */
export function monthlyTotalCents(sb: SeatBilling): number {
  return sb.basePriceCents + sb.perSeatPriceCents * sb.billableSeats;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The composed bill, e.g. "$600 base + 5 seats × $20 = $700/mo".
 * `billableSeats` is the multiplied quantity; the total reconciles exactly
 * with the Stripe two-item subscription (base item + seat item).
 */
export function composedBillLine(sb: SeatBilling): string {
  return `${formatUsd(sb.basePriceCents)} base + ${plural(sb.billableSeats, 'seat')}`
    + ` × ${formatUsd(sb.perSeatPriceCents)} = ${formatUsd(monthlyTotalCents(sb))}/mo`;
}

/**
 * The inclusion-explicit seat line — the headline seat number (all
 * functional seats = creditSeats) composed from members + agents, with the
 * agent inclusion split made legible. Decision-of-record §8:
 *   "7 seats — 5 members + 2 agents (2 of 2 agent seats included)"
 *   "9 seats — 5 members + 4 agents (2 included, 2 billed)"
 */
export function seatBreakdownLine(sb: SeatBilling): string {
  const head = `${plural(sb.creditSeats, 'seat')} — ${plural(sb.humans, 'member')}`;
  if (sb.agents === 0) return head;
  const agentPart = `${plural(sb.agents, 'agent')}`;
  const split = sb.billedAgentCount === 0
    ? `(${sb.includedAgentCount} of ${sb.includedAgentCount} agent seat`
      + `${sb.includedAgentCount === 1 ? '' : 's'} included)`
    : `(${sb.includedAgentCount} included, ${sb.billedAgentCount} billed)`;
  return `${head} + ${agentPart} ${split}`;
}

/**
 * The billing consequence of adding ONE more agent (service client), shown
 * at the create-confirm. Truthful per the inclusion: agent #1/#2 is $0,
 * agent #3+ adds a $20 line. During a trial the charge is framed as
 * starting when the trial ends; proration is plain-language only.
 */
export function agentSeatConsentCopy(
  sb: SeatBilling,
  opts: { trialing: boolean },
): string {
  // The agent being added is the (agents + 1)-th. It is included while the
  // current agent count is still below the 2-seat allowance.
  const willBeIncluded = sb.agents < 2;
  if (willBeIncluded) {
    return 'Adds 1 agent seat — included in your plan, $0.';
  }
  const price = formatUsd(sb.perSeatPriceCents);
  return opts.trialing
    ? `Adds 1 agent seat — ${price}/mo, applied when your trial ends.`
    : `Adds 1 agent seat — ${price}/mo, prorated for the remainder of this cycle.`;
}

/**
 * The billing consequence of adding ONE more human member. A human seat is
 * always a $20 event (no inclusions). Trial-aware, plain-language proration.
 */
export function memberSeatConsentCopy(
  sb: SeatBilling,
  opts: { trialing: boolean },
): string {
  const price = formatUsd(sb.perSeatPriceCents);
  return opts.trialing
    ? `Adds 1 member seat — ${price}/mo, applied when your trial ends.`
    : `Adds 1 member seat — ${price}/mo, prorated for the remainder of this cycle.`;
}
