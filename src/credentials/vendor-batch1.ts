/**
 * Phase-1 batch-1: the 31 header-pure-data vendors (headerMapping only, no
 * buildHeaders) — the migrated set the registry seeds + the parity gates assert.
 * Source of truth = analyst classification 2026-05-27. ONE definition, imported
 * by both the seed (scripts/seed-vendor-registry.ts) and the canonical-map emit
 * (scripts/emit-canonical-map.ts) so the seeded set and the asserted set cannot
 * drift apart.
 *
 * Cross-repo: this list is identical in conduit and the gateway (both repos'
 * compiled maps verified to contain all 31). The cross-repo parity assert is
 * equal-on-27 + scoped-allow-4 over the canonical form of exactly these 31.
 */
export const BATCH_1_SLUGS: readonly string[] = [
  'atera', 'autotask', 'avanan', 'blackpoint', 'cipp', 'connectwise-automate',
  'crewhu', 'datto-bcdr', 'datto-rmm', 'datto-saas-protection', 'domotz',
  'halopsa', 'hudu', 'immybot', 'itglue', 'kaseya-bms', 'kaseya-vsa', 'knowbe4',
  'ninjaone', 'pax8', 'proofpoint', 'qbo', 'rocketcyber', 'salesbuildr',
  'sherweb', 'spanning', 'superops', 'syncro', 'threatlocker', 'timezest',
  'unitrends',
];

/**
 * The KNOWN cross-repo data-drift vendors — FIELD-SCOPED (forge discipline): each
 * entry maps a slug to the EXACT canonical fields allowed to differ between
 * conduit and the gateway. The cross-repo assert exempts ONLY those fields and
 * still asserts every OTHER field equal — so a slug drifting on a NEW field (e.g.
 * avanan suddenly on `category`) is RED, not silently swallowed by a vendor-
 * blanket allow. equal-on-26 + field-scoped-allow-5 == 31.
 *
 * The set is reviewer-visible (full membership + per-member scope) and shrinks
 * toward zero as drift is reconciled. No-silent-grow: a 6th drift vendor, or an
 * existing entry drifting on an unlisted field, fails the gate until deliberately
 * resolved (reconcile preferred) or expanded with sign-off.
 *
 * Canonical-field names (from canonicalVendorBehavior): category, containerUrl,
 * fieldNames, headerMapping, mcpPath, oauth, slug.
 *
 * Provenance (analyst 2026-05-27, grounded on the PR-branch maps):
 *  - avanan / connectwise-automate / qbo: headerMapping drift (header NAMES/values).
 *  - datto-saas-protection: fieldNames + headerMapping (field-set) drift.
 *  - itglue: fieldNames + headerMapping — the gateway has a real `region` field +
 *    X-ITGlue-Region header (ITGlue has US/EU/AU regional endpoints); conduit
 *    LACKS it (a pre-existing conduit bug: cannot serve EU/AU ITGlue). Allow-
 *    listed here for THIS zero-behavior-change PR (per-repo parity holds); the
 *    FIX = add region to conduit, tracked as a SEPARATE functional change.
 */
export const CROSS_REPO_DRIFT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'avanan': ['headerMapping'],
  'connectwise-automate': ['headerMapping'],
  'datto-saas-protection': ['fieldNames', 'headerMapping'],
  'qbo': ['headerMapping'],
  'itglue': ['fieldNames', 'headerMapping'],
};
