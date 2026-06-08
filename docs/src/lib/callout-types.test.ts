import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * Callout (Starlight aside) type invariant.
 *
 * Starlight defines exactly four aside types: note, tip, caution, danger.
 * A callout written with any other name (`:::warning`, `:::info`,
 * `:::important` — common when migrating from Docusaurus/VitePress/MkDocs)
 * is NOT recognized: Starlight renders the `:::warning` line as literal text
 * instead of a styled callout, so the page ships a broken-looking block and
 * nobody notices until a reader does.
 *
 * This test scans every docs page for aside openers and fails on any
 * unrecognized type, so a bad callout type is caught at the test gate rather
 * than in production.
 *
 * Lives under docs/src/lib/ so it runs in the root vitest runner
 * (`docs/src/**\/*.test.ts`); docs/ has no runner of its own.
 */

const VALID_ASIDE_TYPES = ['note', 'tip', 'caution', 'danger'] as const;

const here = dirname(fileURLToPath(import.meta.url));
// docs/src/lib -> docs/src/content/docs
const DOCS_ROOT = join(here, '..', 'content', 'docs');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.mdx?$/.test(entry.name) ? [full] : [];
  });
}

interface Aside {
  file: string;
  line: number;
  type: string;
}

/**
 * Aside openers in a file. An opener is a line starting with `:::` followed by
 * a type word (optionally `[Title]`): `:::note`, `:::caution[Internal]`. The
 * bare closing `:::` has no type word and is ignored.
 */
function asideOpeners(file: string): Aside[] {
  const rel = relative(DOCS_ROOT, file);
  const out: Aside[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(/^:::([A-Za-z]+)/);
      if (m) out.push({ file: rel, line: i + 1, type: m[1] });
    });
  return out;
}

const asides = walk(DOCS_ROOT).flatMap(asideOpeners);

describe('docs callout (aside) types', () => {
  it('finds callouts to check', () => {
    expect(asides.length).toBeGreaterThan(0);
  });

  it('every callout uses a valid Starlight aside type', () => {
    const invalid = asides
      .filter((a) => !VALID_ASIDE_TYPES.includes(a.type as (typeof VALID_ASIDE_TYPES)[number]))
      .map((a) => `${a.file}:${a.line} :::${a.type}`);
    expect(
      invalid,
      `unrecognized callout types (valid: ${VALID_ASIDE_TYPES.join(', ')}): ${invalid.join('; ')}`,
    ).toEqual([]);
  });
});
