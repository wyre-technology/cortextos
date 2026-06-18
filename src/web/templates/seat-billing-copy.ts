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
import { isOrgFeeFullyWaived, type OrgDiscount } from '../../billing/discounts.js';

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
 *
 * EAP slice (WYREAI-25, boss msg-1781749682091 — A* + shared-helper GO):
 * when the org_fee is fully waived (EAP grant via mig 054's org_discounts),
 * the prefix collapses to the pure-math form, e.g. "7 seats × $39 = $273/mo".
 * The EAP indicator chip directly above the math line in renderPlanCard
 * provides the context, so the math reads as a complete-thought standalone
 * (ruby msg-1781750560957 voice-call #3, MSP-owner-read judgment confirmed
 * for top-of-card-body chip placement).
 */
export function composedBillLine(sb: SeatBilling): string {
  if (isOrgFeeFullyWaived(sb.discounts)) {
    return `${plural(sb.billableSeats, 'seat')} × ${formatUsd(PER_SEAT_PRICE_CENTS)}`
      + ` = ${formatUsd(sb.monthlyTotalCents)}/mo`;
  }
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

// ---------------------------------------------------------------------------
// EAP slice — copy for the discount-applied surfaces (WYREAI-25)
// ---------------------------------------------------------------------------
//
// Ruby voice-batch (msg-1781750560957, approved verbatim under (b)):
//   - Chip:   "Early Adopter Program · $0 org fee"
//             middot (·) separator beats em-dash, spelled-out first-mention
//   - Pedigree tooltip: "Granted by {admin} on {Mon DD, YYYY}"
//             short-format date for tooltip density; admin already has
//             year context on the page (ruby msg-1781750608088)
//   - Reconcile-note: "Your invoice shows the seat charge only. Your org
//             fee is waived under the Early Adopter Program."
//   - Section-desc (un-waived): em-dash → period (pre-existing ICP fix
//             folded in per ruby's call, msg-1781750560957)
//
// Axis-rules adopted from ruby's msg-1781750560957 §A-C:
//   - First mention spells out "Early Adopter Program"; subsequent
//     mentions in the same card may abbreviate EAP.
//   - "Waived" = consequence-frame (customer-read).
//   - "Granted" = pedigree-frame (admin-action).

/**
 * Find the EAP grant in a SeatBilling snapshot's discount array, if any.
 * Pearl-internal helper for the render branches. Returns the first
 * eap/org_fee row — there is at most one by mig 054's PK(org_id, reason).
 */
export function findEapGrant(sb: SeatBilling): OrgDiscount | null {
  for (const d of sb.discounts) {
    if (d.reason === 'eap') return d;
  }
  return null;
}

/**
 * The chip copy shown at the top of the billing-card body for an
 * EAP-waived org. Spelled-out program name at first-mention; consequence-
 * framed ("$0 org fee") as the customer-facing readout.
 */
export function eapWaiverChipLine(): string {
  return 'Early Adopter Program · $0 org fee';
}

/**
 * Short-format date for the pedigree tooltip: "Jun 18, 2026". Implicit-
 * year is fine for short-term display; forensic audit-log surfaces use
 * full-format with timezone separately.
 */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The pedigree tooltip shown on hover over the EAP chip. Pulled from the
 * grant's granted_by + granted_at — the audit-housed-in-primitive payoff
 * (ruby msg-1781749672262, audit pattern #2): one row, three consumers
 * (customer-facing tooltip + admin-trail-viewer chronological log + the
 * adminAuditService.log emit at grant time).
 *
 * `grantedByDisplayName` is the admin's display name resolved at the
 * route layer (the row stores user_id only — call sites enrich). If the
 * resolver returns null, falls back to the raw granted_by id.
 */
export function eapPedigreeTooltip(
  grant: OrgDiscount,
  grantedByDisplayName: string | null,
): string {
  const who = grantedByDisplayName ?? grant.grantedBy;
  return `Granted by ${who} on ${shortDate(grant.grantedAt)}`;
}

/**
 * The italic invoice-reconcile-note that sits at the bottom of the plan
 * card. Two variants:
 *   - Un-waived: the existing two-line itemization sentence (with the
 *     pre-existing em-dash replaced by a colon per ruby's voice-batch
 *     fold-in).
 *   - Waived: the single-seat-line variant explaining the org-fee absence.
 */
export function invoiceReconcileNote(sb: SeatBilling): string {
  if (isOrgFeeFullyWaived(sb.discounts)) {
    return 'Your invoice shows the seat charge only. Your org fee'
      + ' is waived under the Early Adopter Program.';
  }
  return `Your invoice itemizes this as two lines: the ${formatUsd(ORG_FEE_CENTS)}`
    + ' base and the per-seat charge. Both reconcile exactly with the'
    + ' breakdown above.';
}

/**
 * The section-desc one-liner above the plan summary. Two variants:
 *   - Un-waived: the existing "$399 base + $39/seat" copy (with the
 *     pre-existing em-dash replaced by a period per ruby's voice-batch
 *     fold-in).
 *   - Waived: "$39 per seat. Your org fee is waived under the Early
 *     Adopter Program."
 */
export function planSectionDesc(sb: SeatBilling): string {
  const perSeat = formatUsd(PER_SEAT_PRICE_CENTS);
  if (isOrgFeeFullyWaived(sb.discounts)) {
    return `Everything included. ${perSeat} per seat. Your org fee is`
      + ' waived under the Early Adopter Program.';
  }
  const base = formatUsd(ORG_FEE_CENTS);
  return `Everything included. ${base} base plus ${perSeat} per seat. No`
    + ' tiers, no usage limits.';
}
