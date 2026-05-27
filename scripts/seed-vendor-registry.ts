/**
 * Seed the `vendors` registry (migration 035) from the compiled VENDORS map —
 * Phase 1 batch-1: the 31 HEADER-PURE-DATA vendors (analyst classification
 * 2026-05-27). This is the PER-REPO seed: it serializes THIS repo's own
 * compiled map, so the seeded rows match the compiled behavior exactly (zero
 * behavior change) — including the 4 cross-repo-drift vendors (avanan,
 * connectwise-automate, datto-saas-protection, qbo), which the CI cross-repo
 * assert allow-lists. The parity-gate then asserts the hydrated map deep-equals
 * the compiled map for these 31 across all accessors before the flag flips.
 *
 * DATA fields only (slug/name/category/container_url/fields/header_mapping/
 * docs_url/oauth_config/preview/mcp_path) — the code-minority (buildHeaders/
 * validate) is intentionally NOT seeded; it stays compiled (Phase 2 = the
 * declarative transform-DSL). A seeded vendor's compiled fns are preserved by
 * the entry-level hydrate.
 *
 * Idempotent: INSERT ... ON CONFLICT (slug) DO UPDATE — safe to re-run; the seed
 * is the canonical content, re-applying it re-materialises the rows from the map.
 *
 * Run: tsx scripts/seed-vendor-registry.ts   (after migration 035 is applied)
 */
import { config } from '../src/config.js';
import { initPools, systemPool } from '../src/db/context.js';
import { VENDORS } from '../src/credentials/vendor-config.js';
import { BATCH_1_SLUGS } from '../src/credentials/vendor-batch1.js';

async function main(): Promise<void> {
  initPools({ systemUrl: config.databaseUrl, requestUrl: config.databaseUrlRequest });
  const sql = systemPool();

  let seeded = 0;
  const missing: string[] = [];

  for (const slug of BATCH_1_SLUGS) {
    const v = VENDORS[slug];
    if (!v) {
      // This repo's compiled map lacks a batch-1 slug — surface it loudly; the
      // seed must mirror the compiled map exactly (per-repo). Do not silently skip.
      missing.push(slug);
      continue;
    }

    await sql`
      INSERT INTO vendors (
        slug, name, category, container_url, fields, header_mapping,
        docs_url, oauth_config, preview, mcp_path
      ) VALUES (
        ${v.slug},
        ${v.name},
        ${v.category},
        ${v.containerUrl},
        ${sql.json(v.fields as object)},
        ${sql.json(v.headerMapping as object)},
        ${v.docsUrl},
        ${v.oauthConfig ? sql.json(v.oauthConfig as object) : null},
        ${v.preview ?? false},
        ${v.mcpPath ?? null}
      )
      ON CONFLICT (slug) DO UPDATE SET
        name           = EXCLUDED.name,
        category       = EXCLUDED.category,
        container_url  = EXCLUDED.container_url,
        fields         = EXCLUDED.fields,
        header_mapping = EXCLUDED.header_mapping,
        docs_url       = EXCLUDED.docs_url,
        oauth_config   = EXCLUDED.oauth_config,
        preview        = EXCLUDED.preview,
        mcp_path       = EXCLUDED.mcp_path,
        updated_at     = NOW()
    `;
    seeded += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${seeded}/${BATCH_1_SLUGS.length} batch-1 vendors into the registry.`);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`MISSING from this repo's compiled VENDORS map: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('seed-vendor-registry failed:', err);
    process.exit(1);
  });
