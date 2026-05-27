/**
 * Thin CLI wrapper for the cross-repo parity assert. The logic + its tests live
 * in src/credentials/vendor-canonical-parity.ts (so the assert is covered by the
 * normal src/ test suite); this is just the entry point forge's CI job invokes:
 * it fetches the OTHER repo's committed canonical-map.json (read-only, pinned
 * ref) to a local path and runs this against both maps.
 *
 * Run: tsx scripts/assert-cross-repo-parity.ts <this-map.json> <other-map.json>
 */
import { readFileSync } from 'node:fs';
import { assertCrossRepoParity } from '../src/credentials/vendor-canonical-parity.js';
import { BATCH_1_SLUGS } from '../src/credentials/vendor-batch1.js';

function loadMap(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  // eslint-disable-next-line no-console
  console.error('Usage: tsx scripts/assert-cross-repo-parity.ts <this-map.json> <other-map.json>');
  process.exit(2);
}
try {
  const r = assertCrossRepoParity(loadMap(pathA), loadMap(pathB));
  // eslint-disable-next-line no-console
  console.log(
    `Cross-repo parity GREEN — ${r.matched.length} equal + ${r.allowed.length} allow-listed = ${BATCH_1_SLUGS.length}.\n` +
      `  allow-listed (expected-drift): ${r.allowed.join(', ') || '(none)'}\n` +
      `  shrink candidates (allow-listed but now equal): ${r.shrinkCandidates.join(', ') || '(none)'}`,
  );
} catch (err) {
  // eslint-disable-next-line no-console
  console.error((err as Error).message);
  process.exit(1);
}
