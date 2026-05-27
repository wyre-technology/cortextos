/**
 * Vendor-registry decoupling — Phase 1 (analyst design 2026-05-27, §3-§5).
 *
 * Hydrates the in-memory `VENDORS` map from the DB-backed `vendors` registry
 * (migration 035) so a pure-data vendor add/update is a DB row, not an image
 * rebuild. Governed by `config.features.vendorRegistry` (the flag governs
 * whether the registry is consulted at all; OFF = today's pure-compiled-map
 * behavior).
 *
 * HYDRATE CONTRACT (analyst-grounded — ESM live-binding + code-minority):
 *   - The 11/6 web templates `import { VENDORS }` and hold the ORIGINAL map
 *     object reference. So we MUST mutate that object IN PLACE — never reassign
 *     or rebuild it (it is `export const` anyway). In-place mutation is the only
 *     change visible to the direct importers AND the accessors.
 *   - EXISTING slug (the migrated batch-1, which HAS a compiled entry):
 *     Object.assign(VENDORS[slug], dataFields) merges the DATA fields OVER the
 *     compiled entry, PRESERVING the compiled `buildHeaders`/`validate` fns (the
 *     row carries no such keys — they stay code until the Phase-2 transform-DSL).
 *   - NEW registry-only slug (no compiled counterpart — Aaron's no-rebuild-add
 *     goal): VENDORS[slug] = {...dataFields} — a key-ADD on the SAME map object
 *     (binding-safe; the direct importers see the new key).
 *
 * HYDRATE-BEFORE-SERVE: `hydrateVendorsFromRegistry()` MUST complete at boot
 * before the server accepts requests. There are no top-level/module-eval VENDORS
 * reads (analyst-grounded: every direct read is request-time inside a render fn),
 * so a boot-time hydrate cannot race a stale read.
 *
 * WRITE-INVALIDATION: a registry write re-runs the FULL hydrate (re-materialise
 * the whole merged map), never a single-key bust — so the in-memory map can
 * never serve a stale merge.
 *
 * The `vendors` table is GLOBAL reference data → read on the system path
 * (no per-tenant RLS on `vendors`; per-tenant ON/OFF lives in `vendor_enablement`,
 * which the getVendor enablement read filters EXPLICITLY in query — the gateway
 * `gatewayadmin` role is BYPASSRLS, so RLS is defense-in-depth only there).
 */
import { config } from '../config.js';
import { systemPool } from '../db/context.js';
import { VENDORS, type VendorConfig, type VendorCategory } from './vendor-config.js';

/** A row of the `vendors` table (snake_case as returned by postgres.js). */
interface VendorRow {
  slug: string;
  name: string;
  category: string;
  container_url: string;
  fields: unknown;
  header_mapping: unknown;
  docs_url: string;
  oauth_config: unknown | null;
  preview: boolean;
  mcp_path: string | null;
}

/**
 * Map a DB row to the DATA fields of a VendorConfig. DATA only — never any
 * function (`buildHeaders`/`validate`): the registry carries config-as-data, the
 * code-minority stays compiled (Phase 1) / declarative-spec (Phase 2). For an
 * existing slug these fields are Object.assign'd OVER the compiled entry,
 * leaving its compiled fns intact; for a new slug they ARE the entry.
 */
function rowToVendorData(row: VendorRow): Partial<VendorConfig> {
  const data: Partial<VendorConfig> = {
    name: row.name,
    slug: row.slug,
    category: row.category as VendorCategory,
    containerUrl: row.container_url,
    fields: row.fields as VendorConfig['fields'],
    headerMapping: row.header_mapping as Record<string, string>,
    docsUrl: row.docs_url,
  };
  // Optional fields: only set when present so Object.assign over a compiled
  // entry does not clobber a compiled value with undefined OR introduce a key
  // the compiled entry lacks (which would break the Mode-1 deep-equal parity
  // gate). `preview` is the sharp one: the compiled map encodes "not preview"
  // as ABSENT (no entry has preview:false), and the column defaults to false —
  // so only carry preview when TRUE, matching the compiled shape exactly. A
  // false here is the no-preview default, not an explicit value to merge in.
  if (row.preview) data.preview = true;
  if (row.oauth_config != null) data.oauthConfig = row.oauth_config as VendorConfig['oauthConfig'];
  if (row.mcp_path != null) data.mcpPath = row.mcp_path;
  return data;
}

async function loadVendorRows(): Promise<VendorRow[]> {
  const sql = systemPool();
  return sql<VendorRow[]>`
    SELECT slug, name, category, container_url, fields, header_mapping,
           docs_url, oauth_config, preview, mcp_path
      FROM vendors
  `;
}

/**
 * Hydrate the in-memory VENDORS map from the registry. No-op unless the
 * `vendorRegistry` flag is on. Returns counts for boot logging + the
 * write-invalidation re-run. Idempotent: a re-run re-applies every row
 * (Object.assign for existing, key-add for new) — safe to call repeatedly.
 */
export async function hydrateVendorsFromRegistry(): Promise<{
  merged: number;
  inserted: number;
}> {
  if (!config.features.vendorRegistry) return { merged: 0, inserted: 0 };

  const rows = await loadVendorRows();
  let merged = 0;
  let inserted = 0;

  for (const row of rows) {
    const data = rowToVendorData(row);
    const existing = VENDORS[row.slug];
    if (existing) {
      // Migrated vendor: merge DATA over the compiled entry IN PLACE, preserving
      // the compiled buildHeaders/validate fns (the row has no such keys).
      Object.assign(existing, data);
      merged += 1;
    } else {
      // New registry-only vendor (the no-rebuild-add): key-add on the SAME map
      // object so the direct importers (web templates) see it. Pure-data only.
      VENDORS[row.slug] = data as VendorConfig;
      inserted += 1;
    }
  }

  return { merged, inserted };
}
