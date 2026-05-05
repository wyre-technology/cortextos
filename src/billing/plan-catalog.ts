/**
 * Plan catalog — configurable plan definitions loaded from env or defaults.
 *
 * Plans are loaded from PLAN_CATALOG env var (JSON array) or fall back to
 * the default free + pro plans that match current hardcoded behavior.
 */

export type PlanSlug = 'free' | 'pro' | 'business';

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
];

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

export function getDefaultPlan(): PlanDefinition {
  return planMap.get('free') ?? planCatalog[0];
}
