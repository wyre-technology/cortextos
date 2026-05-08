// ---------------------------------------------------------------------------
// Feature registry — single source of truth for tier-gated features
// ---------------------------------------------------------------------------
//
// Every feature that depends on the org's plan goes here. Adding a new feature
// is a one-line change in this file. Moving a feature to a different tier is
// the same. Per-org overrides live in the `org_feature_overrides` table and
// are checked by the gate before the registry default.
//
// Pricing-page copy and dashboard upsell prompts read `label` and `desc`
// from this map so we don't drift between code and marketing.

export type Plan = 'free' | 'pro' | 'business';

export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  business: 2,
};

export interface FeatureDef {
  /** Minimum plan required by default. */
  minPlan: Plan;
  /** Human-readable label, used in upsell prompts and admin UI. */
  label: string;
  /** Short description shown next to the upsell. */
  desc: string;
}

export const FEATURES = {
  'team-management':    { minPlan: 'pro',      label: 'Team management',      desc: 'Invite members, assign roles, manage org-wide settings.' },
  'shared-connections': { minPlan: 'pro',      label: 'Shared connections',   desc: 'Org-level vendor connections every member can use.' },
  'tool-allowlists':    { minPlan: 'pro',      label: 'Tool allowlists',      desc: 'Restrict which vendor tools each role can call.' },
  'audit-log':          { minPlan: 'business', label: 'Audit log',            desc: 'Per-org log of every tool call, exportable to CSV.' },
  'log-shipping':       { minPlan: 'business', label: 'Log shipping',         desc: 'Stream the audit log to Splunk, Datadog, or any HTTP endpoint.' },
  'service-clients':    { minPlan: 'business', label: 'Service accounts',     desc: 'Headless API clients with their own credentials and rate limits.' },
  'sso':                { minPlan: 'business', label: 'Single sign-on (SSO)', desc: 'Sign in with your Microsoft/Entra tenant.' },
} as const satisfies Record<string, FeatureDef>;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureKey(value: string): value is FeatureKey {
  return value in FEATURES;
}

/**
 * True if `plan` meets `minPlan` according to the rank order. Used by the
 * gate to decide whether a feature is enabled by tier alone (overrides are
 * checked separately).
 */
export function planSatisfies(plan: Plan, minPlan: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}
