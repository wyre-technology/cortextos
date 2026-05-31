/**
 * Plan catalog — the single flat plan.
 *
 * Per Aaron's 2026-05-26 FLAT-PRICING decision: no tiers, no credits, no
 * call-gating, everything-included. There is exactly ONE plan, `conduit`
 * ($399/org + $39/billable-seat, Shape-A agent inclusion — see prices.ts).
 * The former free / pro / business tiers + their per-tier feature gates +
 * the credit allocation are removed.
 *
 * The per-feature booleans below are ALL TRUE and the limits ALL UNLIMITED
 * — kept as the "everything-included" surface that gate.ts reads, NOT as a
 * tier lever. They no longer differentiate plans (there is only one); they
 * exist so gate.ts's method signatures stay stable for their callers while
 * always answering "yes, included". Rate-limiting is NOT here: it is a flat
 * infra constant (ANTI_ABUSE_RATE_PER_HOUR in prices.ts), divorced from the
 * plan object so it can never drift back into a pricing tier.
 *
 * getPlan resolves ANY slug to the flat plan — existing org rows carrying a
 * legacy 'free'/'pro'/'business' value resolve cleanly even before the
 * data migration rewrites them to 'conduit'.
 */

export type PlanSlug = 'conduit';

export interface PlanDefinition {
  slug: string;
  name: string;
  vendorLimit: number;        // Infinity = unlimited (always, flat)
  teamFeatures: boolean;      // always true (everything-included)
  logShipping: boolean;       // always true
  promptCapture: boolean;     // always true
  maxMembers: number;         // Infinity = unlimited (always, flat)
  auditLogExport: boolean;    // always true
  sso: boolean;               // always true
  serviceClients: boolean;    // always true
}

export const CONDUIT_PLAN_SLUG = 'conduit' as const;

/** The single flat plan — everything-included, no tier differentiation. */
const FLAT_PLAN: PlanDefinition = {
  slug: CONDUIT_PLAN_SLUG,
  name: 'Conduit',
  vendorLimit: Infinity,
  teamFeatures: true,
  logShipping: true,
  promptCapture: true,
  maxMembers: Infinity,
  auditLogExport: true,
  sso: true,
  serviceClients: true,
};

export const planCatalog: PlanDefinition[] = [FLAT_PLAN];

/**
 * Resolve a plan slug. Flat-pricing has ONE plan, so any slug — including
 * a legacy 'free'/'pro'/'business' value on an un-migrated org row — maps
 * to the flat plan. Returns undefined only for the genuinely-empty input
 * so existing `if (!plan)` guards keep their shape.
 */
export function getPlan(slug: string | null | undefined): PlanDefinition | undefined {
  if (slug === null || slug === undefined || slug === '') return undefined;
  return FLAT_PLAN;
}

/**
 * Default plan for newly-created orgs — the single flat plan. Every new
 * org is created as a `trialing` Stripe subscription against it (no unpaid
 * `free` default). checkout.ts owns the trial_period_days wiring.
 */
export function getDefaultPlan(): PlanDefinition {
  return FLAT_PLAN;
}
