/**
 * Canonical serialization for the vendor-registry parity gates (Phase 1).
 *
 * TWO distinct canonical forms — do not conflate (forge integration seam):
 *
 *  - canonicalVendorBehavior(v): the CROSS-REPO form. The behaviour-determining
 *    DATA subset only — category + headerMapping (keys sorted) + field NAMES
 *    (sorted). Drops cosmetic data (name, labels, placeholders, docsUrl), the
 *    code-minority fns (buildHeaders/validate), and all formatting. Two repos
 *    can have harmless cosmetic drift (a different label) without behavioural
 *    drift; this form compares only what actually affects request behaviour, so
 *    the conduit-table-vs-gateway-table assert is apples-to-apples and is not
 *    tripped by key ordering or formatting. This is exactly the "data fields:
 *    category + headerMapping + field-names" level at which the batch-1 set is
 *    27-identical / 4-drift (avanan, connectwise-automate, datto-saas-protection,
 *    qbo) — the cross-repo assert is equal-on-27 + scoped-allow-4 over this form.
 *
 *  - The PER-REPO Mode-1 parity gate (analyst) is a FULL deep-equal of the
 *    hydrated VendorConfig vs its OWN compiled entry (all data fields, incl
 *    cosmetic) — the no-behaviour-change regression gate within one repo, where
 *    cosmetic matches own-compiled by definition. It does not use this module;
 *    it deep-equals the live accessor output. (Kept separate on purpose.)
 *
 * The gateway repo mirrors this exact module so both emit an identical canonical
 * form — byte-equality only means something when both sides serialize the same way.
 */
import type { VendorConfig } from './vendor-config.js';

/** Stable stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The behaviour-determining canonical form of a vendor, for the CROSS-REPO
 * assert. category + sorted headerMapping + sorted field names only.
 */
export function canonicalVendorBehavior(v: VendorConfig): string {
  return stableStringify({
    slug: v.slug,
    category: v.category,
    // containerUrl is the upstream MCP proxy TARGET — behaviour-determining
    // (where the gateway routes the request), so it is part of the behavioural
    // canonical and the cross-repo asserted-equal set (analyst: zero cross-repo
    // drift, all 31). The per-deploy VENDOR_URL_<SLUG> env override applies at
    // getVendor-time and is NOT a vendor-definition property, so the stored
    // containerUrl is the right field for the definition compare.
    containerUrl: v.containerUrl,
    headerMapping: v.headerMapping ?? {},
    fieldNames: (v.fields ?? []).map((f) => f.key).sort(),
    // OAuth is behaviour-determining (it changes the auth flow) — include the
    // shape, not the (env-keyed) secrets, which are not in the config anyway.
    oauth: v.oauthConfig
      ? { authorizeUrl: v.oauthConfig.authorizeUrl, tokenUrl: v.oauthConfig.tokenUrl, scopes: [...v.oauthConfig.scopes].sort() }
      : null,
    mcpPath: v.mcpPath ?? '/mcp',
  });
}

/**
 * The per-repo behavioural canonical for every vendor slug, sorted by slug —
 * the deterministic artifact the cross-repo assert consumes (one per repo).
 */
export function canonicalVendorBehaviorMap(
  vendors: Record<string, VendorConfig>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slug of Object.keys(vendors).sort()) {
    out[slug] = canonicalVendorBehavior(vendors[slug]);
  }
  return out;
}
