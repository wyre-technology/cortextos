// Layer 1 §8 — seat-billing presentation layer (Pearl-owned).
//
// The data layer (src/billing/seat-service.ts, SeatBilling) single-sources
// the seat MATH and emits cents + integers — Object.freeze snapshot,
// monthlyTotalCents pre-derived. This module single-sources the
// PRESENTATION — money formatting, the composed-bill line, the
// inclusion-explicit seat line, the agent-seat consent copy. Every §8
// surface (billing page, service-client create, member add) imports from
// here so the copy cannot drift between surfaces.
//
// Price constants come from `prices.js` (ORG_FEE_CENTS / PER_SEAT_PRICE_CENTS
// — the named SoT) rather than from the view object, so the price source-of-
// truth lives in exactly one place independent of any per-org snapshot.
//
// Flat-pricing (Aaron 2026-05-26) + AGENTS-BILLABLE (Aaron 2026-06-17, boss
// msg-1781747082415, WYREAI-25): $399 org fee + $39/billable-seat, no
// tiers, no credits. Every seat bills from seat 1 — humans and agents at
// the same per-seat rate. The Shape-A "first 2 agents free" inclusion is
// removed at INCLUDED_AGENT_SEATS = 0.
//
// Pure functions, no escaping — callers escapeHtml at the interpolation
// site. No surface here renders a number that can disagree with the real
// source: the bill total is read directly off `monthlyTotalCents`, never
// recomputed; proration is described in plain language (never a computed
// dollar figure that could disagree with Stripe's actual proration).

import type { SeatBilling } from '../../billing/seat-service.js';
import { ORG_FEE_CENTS, PER_SEAT_PRICE_CENTS } from '../../billing/prices.js';

/**
 * Terse money — whole-dollar cents → "$600", non-whole → "$6.50". For
 * prices in a breakdown (the composed-bill line, per-seat price) where the
 * decimals would be noise.
 */
export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return '$' + dollars.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Exact money — always 2 decimals: "$620.00". For an actual charge amount
 * (the trial first-charge line), where full currency precision is the
 * convention. Same underlying number as `formatUsd`, charge-formatted.
 */
export function formatUsdExact(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The composed bill, e.g. "$399 base + 5 seats × $39 = $594/mo".
 * `billableSeats` is the multiplied quantity; the total is read directly
 * off `sb.monthlyTotalCents` (the SoT field on the snapshot), never
 * recomputed here — so this line cannot disagree with the trial banner,
 * the invoice, or the Stripe subscription quantity.
 */
export function composedBillLine(sb: SeatBilling): string {
  return `${formatUsd(ORG_FEE_CENTS)} base + ${plural(sb.billableSeats, 'seat')}`
    + ` × ${formatUsd(PER_SEAT_PRICE_CENTS)} = ${formatUsd(sb.monthlyTotalCents)}/mo`;
}

/**
 * The seat breakdown line — the headline seat number (all functional seats
 * = humans + agents) composed from members + agents. Under AGENTS-BILLABLE
 * (no free-agent tier), there's no inclusion split to show; the breakdown
 * reads as a clean comma-list:
 *   "7 seats. 5 members, 2 agents."
 *   "9 seats. 5 members, 4 agents."
 *   "1 seat. 1 member."   (agents=0 → drop the agents suffix)
 */
export function seatBreakdownLine(sb: SeatBilling): string {
  const { humans, agents } = sb.counts;
  const totalSeats = humans + agents;
  const head = `${plural(totalSeats, 'seat')}. ${plural(humans, 'member')}`;
  if (agents === 0) return `${head}.`;
  return `${head}, ${plural(agents, 'agent')}.`;
}

/**
 * The billing consequence of adding ONE more agent (service client), shown
 * at the create-confirm. Under AGENTS-BILLABLE (no free-agent tier), every
 * agent seat adds a $39 line. During a trial the charge is framed as
 * starting when the trial ends; proration is plain-language only.
 */
export function agentSeatConsentCopy(
  _sb: SeatBilling,
  opts: { trialing: boolean },
): string {
  const price = formatUsd(PER_SEAT_PRICE_CENTS);
  return opts.trialing
    ? `Adds 1 agent seat. ${price}/mo, applied when your trial ends.`
    : `Adds 1 agent seat. ${price}/mo, prorated for the remainder of this cycle.`;
}

/**
 * The billing consequence of adding ONE more human member. A human seat is
 * always a $39 event (no inclusions). Trial-aware, plain-language proration.
 */
export function memberSeatConsentCopy(
  _sb: SeatBilling,
  opts: { trialing: boolean },
): string {
  const price = formatUsd(PER_SEAT_PRICE_CENTS);
  return opts.trialing
    ? `Adds 1 member seat. ${price}/mo, applied when your trial ends.`
    : `Adds 1 member seat. ${price}/mo, prorated for the remainder of this cycle.`;
}
