import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Search-index exclusion invariant (Finding A, search channel).
 *
 * Pagefind (Starlight's built-in search) indexes EVERY built page by default.
 * The internal/ docs carry per-agent system-prompt contents and must stay out
 * of every crawler/discovery channel — page-serve (noindex header), sitemap
 * (build filter), llms.txt (curation), robots — and search is one of those
 * channels. A page is excluded from Pagefind by `pagefind: false` in its
 * front-matter.
 *
 * This test locks the exclusion set EXACTLY to the internal/ subtree, so:
 *  - a new internal/ page that forgets `pagefind: false` fails the build's
 *    test gate (the durable guard, not a one-time fix), and
 *  - a customer-facing page accidentally given `pagefind: false` (silently
 *    dropping it from search) also fails.
 *
 * Lives under docs/src/lib/ so it runs in the root vitest runner
 * (`docs/src/**\/*.test.ts`); docs/ has no runner of its own.
 */

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

/** True if the page's front-matter sets `pagefind: false`. */
function isSearchExcluded(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  const fm = src.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  return /^pagefind:\s*false\s*$/m.test(fm[1]);
}

/** Page is under the internal/ subtree (POSIX or Windows separators). */
function isInternal(file: string): boolean {
  const rel = relative(DOCS_ROOT, file).split(sep).join('/');
  return rel === 'internal' || rel.startsWith('internal/');
}

const pages = walk(DOCS_ROOT);

describe('docs search-index exclusion (Pagefind)', () => {
  it('finds docs pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it('excludes every internal/ page from search (pagefind: false)', () => {
    const leaking = pages
      .filter(isInternal)
      .filter((f) => !isSearchExcluded(f))
      .map((f) => relative(DOCS_ROOT, f));
    expect(
      leaking,
      `internal/ pages missing "pagefind: false" (searchable on the public site): ${leaking.join(', ')}`,
    ).toEqual([]);
  });

  it('does not exclude any customer-facing page from search', () => {
    const wronglyExcluded = pages
      .filter((f) => !isInternal(f))
      .filter(isSearchExcluded)
      .map((f) => relative(DOCS_ROOT, f));
    expect(
      wronglyExcluded,
      `non-internal pages set "pagefind: false" (dropped from search unexpectedly): ${wronglyExcluded.join(', ')}`,
    ).toEqual([]);
  });
});
