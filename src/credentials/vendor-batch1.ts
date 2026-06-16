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

/**
 * Deferred-from-batch-1 horizon — vendors NOT in BATCH_1_SLUGS, classified
 * by the REASON each is excluded from the cross-repo parity assert.
 *
 * Closes analyst's ALL-DEFERRED-INVISIBLE-AT-CATALOG NIT
 * (boss msg-1781589739906): without this artifact, the "31 batch-1
 * vendors get parity-checked + N others silently don't" gap was implicit.
 * The list below + the fail-by-design test in
 * `vendor-canonical-parity.test.ts` make it explicit + ratcheted:
 * adding a new vendor to VENDORS without classifying it here fails the
 * gate, forcing a deliberate choice (extend BATCH_1 with fixtures OR
 * add to this deferred list with a stated reason).
 *
 * Reason vocabulary — fixed set, sibling to the canonicalVendorBehavior
 * field-name vocabulary used by CROSS_REPO_DRIFT_ALLOWLIST:
 *   - 'oauth-config-not-headerMapping' — vendor uses `oauthConfig`
 *     instead of a static `headerMapping`; parity-batch assumes a
 *     header-pure-data shape that doesn't fit OAuth flows.
 *   - 'build-headers-not-headerMapping' — vendor uses `buildHeaders`
 *     (e.g. base64-encoding, multi-field combination, Bearer-prefix
 *     construction). Parity-batch assumes static header mapping.
 *   - 'factory-emitted-do-slug' — emitted by `digitalOceanMcpEntries()`
 *     factory in vendor-config.ts (PR #401 WYREAI-165). Sibling slugs
 *     share buildHeaders + a tuple-list source-of-truth; adding to
 *     parity would require a per-slug fixture set.
 *   - 'post-batch1-add' — added to conduit after the analyst
 *     classification 2026-05-27 freeze; not yet evaluated for batch
 *     promotion. Default reason for header-pure-data vendors landed
 *     post-freeze.
 *
 * Source-citation (ruby's set-boundary-via-external-source discipline,
 * sibling to PR #405/#422 AUVIK_VALID_REGIONS):
 *   - Initial classification: analyst 2026-05-27 freeze (BATCH_1_SLUGS).
 *   - Per-vendor reason: programmatically derived 2026-06-16 from
 *     `VENDORS[slug].oauthConfig` / `.buildHeaders` / slug-prefix
 *     `digitalocean-` introspection. Manual entries flagged with
 *     'post-batch1-add' where introspection found no static structural
 *     signal — these are candidates for future BATCH_1 promotion when
 *     analyst re-classifies.
 *   - Re-classification policy: when a deferred vendor gains parity
 *     fixtures on the gateway-side, MOVE its slug to BATCH_1_SLUGS and
 *     REMOVE from this list. The fail-by-design test enforces the
 *     completeness invariant either way.
 */
export const DEFERRED_FROM_BATCH_1_SLUGS: Readonly<Record<string, string>> = {
  'abnormal-security': 'build-headers-not-headerMapping',
  'action1': 'post-batch1-add',
  'alternative-payments': 'post-batch1-add',
  'auvik': 'post-batch1-add',
  'azure-mcp': 'post-batch1-add',
  'betterstack': 'build-headers-not-headerMapping',
  'blumira': 'build-headers-not-headerMapping',
  'connectwise-psa': 'post-batch1-add',
  'digitalocean-apps': 'factory-emitted-do-slug',
  'digitalocean-databases': 'factory-emitted-do-slug',
  'digitalocean-docs': 'factory-emitted-do-slug',
  'digitalocean-doks': 'factory-emitted-do-slug',
  'digitalocean-droplets': 'factory-emitted-do-slug',
  'digitalocean-functions': 'factory-emitted-do-slug',
  'digitalocean-gradient-ai': 'factory-emitted-do-slug',
  'digitalocean-inference': 'factory-emitted-do-slug',
  'digitalocean-networking': 'factory-emitted-do-slug',
  'digitalocean-spaces': 'factory-emitted-do-slug',
  'halopsa-official': 'post-batch1-add',
  'hubspot': 'oauth-config-not-headerMapping',
  'huntress': 'build-headers-not-headerMapping',
  'ironscales': 'post-batch1-add',
  'kaseya-quote-manager': 'post-batch1-add',
  'liongard': 'build-headers-not-headerMapping',
  'm365': 'oauth-config-not-headerMapping',
  'microsoft-graph': 'oauth-config-not-headerMapping',
  'mimecast': 'post-batch1-add',
  'pagerduty': 'build-headers-not-headerMapping',
  'pandadoc': 'build-headers-not-headerMapping',
  'rootly': 'build-headers-not-headerMapping',
  'runzero': 'build-headers-not-headerMapping',
  'sentinelone': 'post-batch1-add',
  'spamtitan': 'post-batch1-add',
  'xero': 'oauth-config-not-headerMapping',
};

/** Fixed vocabulary of valid deferral reasons. Test asserts every entry
 * in `DEFERRED_FROM_BATCH_1_SLUGS` carries one of these. */
export const DEFERRED_REASONS = [
  'oauth-config-not-headerMapping',
  'build-headers-not-headerMapping',
  'factory-emitted-do-slug',
  'post-batch1-add',
] as const;
export type DeferredReason = typeof DEFERRED_REASONS[number];
