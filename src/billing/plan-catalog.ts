/**
 * Plan catalog — configurable plan definitions loaded from env or defaults.
 *
 * Plans are loaded from PLAN_CATALOG env var (JSON array) or fall back to
 * the default catalog. Layer 1 (LOCKED DOR 2026-05-20) collapses to a
 * single paid plan `conduit` — $600 base + $20/seat, 2500 credits/seat,
 * 2 agent seats included in base. Free / pro / business remain in the
 * default catalog through the migration window (WI-8, groups B–E); they
 * are vestigial post-migration. New orgs default to `conduit` with a
 * 14-day trial (see TRIAL_PERIOD_DAYS in prices.ts; subscription wiring
 * lives in checkout.ts).
 */

import {
  BASE_PRICE_CENTS,
  CREDITS_PER_SEAT,
  PER_SEAT_PRICE_CENTS,
} from './prices.js';

export type PlanSlug = 'free' | 'pro' | 'business' | 'conduit';

export interface PlanDefinition {
  slug: string;
  name: string;
  vendorLimit: number;        // Infinity = unlimited
  rateLimitPerHour: number;
  teamFeatures: boolean;
  logShipping: boolean;
  promptCapture: boolean;
  maxMembers: number;         // Infinity = unlimited
  /**
   * Monthly credit allocation. Interpreted as:
   *   - free: flat allocation (creditAllocation total credits/month)
   *   - pro/business: per-seat allocation (creditAllocation × member count)
   * Pooled across all org members in either case.
   */
  creditAllocation: number;
  // Business-tier features (mcp-gateway parity). All false on free/pro.
  auditLogExport: boolean;
  sso: boolean;
  serviceClients: boolean;
}

const DEFAULT_CATALOG: PlanDefinition[] = [
  {
    slug: 'free',
    name: 'Free',
    vendorLimit: 3,
    rateLimitPerHour: 100,
    teamFeatures: false,
    logShipping: false,
    promptCapture: false,
    maxMembers: 1,
    creditAllocation: 500,
    auditLogExport: false,
    sso: false,
    serviceClients: false,
  },
  {
    slug: 'pro',
    name: 'Pro',
    vendorLimit: Infinity,
    rateLimitPerHour: 1000,
    teamFeatures: true,
    logShipping: true,
    promptCapture: true,
    maxMembers: Infinity,
    creditAllocation: 1500,
    auditLogExport: false,
    sso: false,
    serviceClients: false,
  },
  {
    slug: 'business',
    name: 'Business',
    vendorLimit: Infinity,
    rateLimitPerHour: 5000,
    teamFeatures: true,
    logShipping: true,
    promptCapture: true,
    maxMembers: Infinity,
    creditAllocation: 4000,
    auditLogExport: true,
    sso: true,
    serviceClients: true,
  },
  {
    // Layer 1 paid plan. Per the LOCKED DOR, every Conduit org runs on
    // this plan — $600 base + $20/billable-seat, 2 agent seats included.
    // creditAllocation is retained as documentation of the per-seat rate;
    // gate.getCreditAllocation reads CREDITS_PER_SEAT (prices.ts) so the
    // margin lever lives in one constant, not in this catalog entry.
    slug: 'conduit',
    name: 'Conduit',
    vendorLimit: Infinity,
    rateLimitPerHour: 5000,
    teamFeatures: true,
    logShipping: true,
    promptCapture: true,
    maxMembers: Infinity,
    creditAllocation: CREDITS_PER_SEAT,
    auditLogExport: true,
    sso: true,
    serviceClients: true,
  },
];

export const CONDUIT_PLAN_SLUG = 'conduit' as const;
export const CONDUIT_BASE_PRICE_CENTS = BASE_PRICE_CENTS;
export const CONDUIT_PER_SEAT_PRICE_CENTS = PER_SEAT_PRICE_CENTS;

function parseCatalog(json: string): PlanDefinition[] {
  const raw = JSON.parse(json) as Array<Record<string, unknown>>;
  return raw.map((p) => ({
    slug: String(p.slug),
    name: String(p.name),
    vendorLimit: p.vendorLimit === 'Infinity' ? Infinity : Number(p.vendorLimit),
    rateLimitPerHour: Number(p.rateLimitPerHour),
    teamFeatures: Boolean(p.teamFeatures),
    logShipping: Boolean(p.logShipping),
    promptCapture: Boolean(p.promptCapture),
    maxMembers: p.maxMembers === 'Infinity' ? Infinity : Number(p.maxMembers),
    creditAllocation: Number(p.creditAllocation ?? 0),
    auditLogExport: Boolean(p.auditLogExport),
    sso: Boolean(p.sso),
    serviceClients: Boolean(p.serviceClients),
  }));
}

function loadCatalog(): PlanDefinition[] {
  const envJson = process.env.PLAN_CATALOG;
  if (!envJson) return DEFAULT_CATALOG;

  try {
    return parseCatalog(envJson);
  } catch {
    console.warn('WARNING: Invalid PLAN_CATALOG JSON — using defaults');
    return DEFAULT_CATALOG;
  }
}

export const planCatalog = loadCatalog();

const planMap = new Map(planCatalog.map((p) => [p.slug, p]));

export function getPlan(slug: string): PlanDefinition | undefined {
  return planMap.get(slug);
}

/**
 * Default plan for newly-created orgs. Per DOR §9.1, every new org is
 * created as a `trialing` Stripe subscription against the conduit plan —
 * no more unpaid `free` default. checkout.ts owns the trial_period_days
 * wiring; this function names the plan that org-creation attaches.
 */
export function getDefaultPlan(): PlanDefinition {
  return planMap.get(CONDUIT_PLAN_SLUG) ?? planCatalog[0];
}
