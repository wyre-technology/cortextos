/**
 * Emit the per-repo CANONICAL MAP artifact for the cross-repo parity gate.
 *
 * Writes `canonical-map.json` at the repo root: the behavioral-canonical form
 * (canonicalVendorBehavior) of each of the 31 batch-1 vendors, from THIS repo's
 * compiled VENDORS map, sorted by slug + deterministically serialized. This is a
 * COMMITTED generated artifact — the standing source the cross-repo assert
 * consumes (forge's design), so the 27/4 parity is an ENFORCED gate, not a
 * one-time manual grounding.
 *
 * Two CI checks consume this:
 *   1. PER-REPO freshness: re-run this script + assert no git diff vs the
 *      committed canonical-map.json — catches "the map drifted from the code"
 *      (a code change to a batch-1 vendor that wasn't re-emitted).
 *   2. CROSS-REPO (scripts/assert-cross-repo-parity.ts): load both repos'
 *      committed canonical-map.json + assert equal-on-27 + scoped-allow-4.
 *
 * Determinism: canonicalVendorBehaviorMap sorts slugs + recursively sorts keys,
 * and we JSON.stringify with 2-space indent + trailing newline, so the file is
 * byte-stable across runs (a re-emit with no code change produces no diff).
 *
 * Run: tsx scripts/emit-canonical-map.ts
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORS } from '../src/credentials/vendor-config.js';
import { canonicalVendorBehaviorMap } from '../src/credentials/vendor-canonical.js';
import { BATCH_1_SLUGS } from '../src/credentials/vendor-batch1.js';

function main(): void {
  const missing = BATCH_1_SLUGS.filter((s) => !VENDORS[s]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Cannot emit canonical map — compiled VENDORS is missing batch-1 slugs: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Canonical map over EXACTLY the 31 batch-1 vendors (the migrated/asserted set).
  const subset: Record<string, (typeof VENDORS)[string]> = {};
  for (const slug of BATCH_1_SLUGS) subset[slug] = VENDORS[slug];

  const map = canonicalVendorBehaviorMap(subset);
  const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'canonical-map.json');
  writeFileSync(outPath, `${JSON.stringify(map, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(`Wrote canonical-map.json — ${Object.keys(map).length} batch-1 vendors.`);
}

main();
