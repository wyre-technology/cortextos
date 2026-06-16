import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  FAQ_DATA,
  extractFaq,
  mdToPlain,
  escapeScriptContent,
  faqJsonLdFor,
  buildFaqJsonLd,
} from './faq.js';

const here = dirname(fileURLToPath(import.meta.url));
// faq.test.ts lives at docs/src/lib/ — content docs are at docs/src/content/docs.
const docsRoot = join(here, '..', 'content', 'docs');

/** Absolute MDX/MD path for a docs slug (a FAQ_DATA key). */
function mdxPathForSlug(slug: string): string {
  for (const ext of ['.mdx', '.md']) {
    const p = join(docsRoot, slug + ext);
    if (existsSync(p)) return p;
  }
  throw new Error(`no docs page found for FAQ slug "${slug}"`);
}

/** Every docs page as { slug, path }; slug is the path under docsRoot, no ext. */
function allPages(): { slug: string; path: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.mdx?$/.test(e.name) ? [full] : [];
    });
  return walk(docsRoot).map((path) => ({
    slug: relative(docsRoot, path).replace(/\.mdx?$/, '').split(/[\\/]/).join('/'),
    path,
  }));
}

/** The slug passed to `<FaqSchema slug="..."/>` on a page, or null. */
function faqSchemaSlug(src: string): string | null {
  const m = src.match(/<FaqSchema\s+slug=["']([^"']+)["']/);
  return m ? m[1] : null;
}

const PAGES = allPages();
const pagesWithFaqSection = PAGES.filter(
  (p) => extractFaq(readFileSync(p.path, 'utf8')).length > 0,
);

describe('FAQ schema-matches-visible drift-catch', () => {
  // The acceptance gate: FAQPage JSON-LD must mirror the visible Q/A. FAQ_DATA
  // is the build-time source; this asserts it stays byte-faithful to the MDX,
  // so editing a visible Q OR A without updating FAQ_DATA fails CI.
  for (const slug of Object.keys(FAQ_DATA)) {
    it(`FAQ_DATA[${slug}] exactly matches the page's visible FAQ (Q + A, raw)`, () => {
      const mdx = readFileSync(mdxPathForSlug(slug), 'utf8');
      const extracted = extractFaq(mdx);
      // deep-equals on BOTH question and answer text — not just count/questions.
      expect(extracted).toEqual(FAQ_DATA[slug].map((e) => ({ q: e.q, a: e.a })));
    });
  }

  it('extractFaq returns [] for a doc with no FAQ section', () => {
    expect(extractFaq('# Title\n\nSome prose.\n\n## Other\n\ntext')).toEqual([]);
  });
});

describe('FAQ wiring invariant (no silently-missing or orphaned schema)', () => {
  // Locks the triangle: a visible FAQ section, a FAQ_DATA entry, and a
  // <FaqSchema slug=…/> render must ALL be present together (keyed on the
  // page's own slug). Any one missing means the FAQPage structured data
  // silently doesn't ship — or ships pointing at nothing — which a plain
  // text-drift test can't see. This walks every page, so a new FAQ page is
  // covered automatically (no hand-maintained slug list).
  const faqDataSlugs = new Set(Object.keys(FAQ_DATA));
  const sectionSlugs = new Set(pagesWithFaqSection.map((p) => p.slug));

  it('finds the known FAQ pages (non-vacuous)', () => {
    expect(sectionSlugs.size).toBeGreaterThanOrEqual(2);
  });

  it('every page with a visible FAQ section is registered in FAQ_DATA', () => {
    const unregistered = [...sectionSlugs].filter((s) => !faqDataSlugs.has(s));
    expect(
      unregistered,
      `pages have a "## Frequently asked questions" section but no FAQ_DATA entry (FAQPage schema would silently not ship): ${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('every FAQ_DATA slug resolves to a page with a visible FAQ section', () => {
    const orphaned = [...faqDataSlugs].filter((s) => !sectionSlugs.has(s));
    expect(
      orphaned,
      `FAQ_DATA entries with no matching visible FAQ section (dead schema): ${orphaned.join(', ')}`,
    ).toEqual([]);
  });

  it('every page renders <FaqSchema> iff it has a FAQ section, with its own slug', () => {
    const problems: string[] = [];
    for (const p of PAGES) {
      const invoked = faqSchemaSlug(readFileSync(p.path, 'utf8'));
      const hasSection = sectionSlugs.has(p.slug);
      if (hasSection && invoked === null) {
        problems.push(`${p.slug}: FAQ section but no <FaqSchema> (schema not emitted)`);
      }
      if (!hasSection && invoked !== null) {
        problems.push(`${p.slug}: renders <FaqSchema> but has no visible FAQ section`);
      }
      if (invoked !== null && invoked !== p.slug) {
        problems.push(`${p.slug}: <FaqSchema slug="${invoked}"> does not match the page slug`);
      }
      if (invoked !== null && !faqDataSlugs.has(invoked)) {
        problems.push(`${p.slug}: <FaqSchema slug="${invoked}"> has no FAQ_DATA entry`);
      }
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });
});

describe('escapeScriptContent — </script> breakout defense', () => {
  it('neutralizes a CASE-VARIANT </ScRiPt> (rejects a naive lowercase replace)', () => {
    const obj = { a: 'danger </ScRiPt><script>alert(1)</script>' };
    const out = escapeScriptContent(JSON.stringify(obj));
    // no raw `<` survives -> no `</script>` in ANY case can form in the HTML
    expect(out).not.toContain('<');
    expect(out.toLowerCase()).not.toContain('</script>');
  });

  it('neutralizes a comment-opener <!--', () => {
    const out = escapeScriptContent(JSON.stringify({ a: 'x <!-- y' }));
    expect(out).not.toContain('<');
  });

  it('round-trips: JSON.parse(escaped) deep-equals the source (still valid JSON)', () => {
    const obj = { a: 'has </ScRiPt> and <!-- and <tag>', b: ['x </script> y'] };
    expect(JSON.parse(escapeScriptContent(JSON.stringify(obj)))).toEqual(obj);
  });
});

describe('faqJsonLdFor / buildFaqJsonLd', () => {
  it('escapes an authored </script> in answer text end-to-end', () => {
    const json = faqJsonLdFor([{ q: 'Q?', a: 'answer with </ScRiPt> in it' }]);
    expect(json).not.toContain('<');
    const parsed = JSON.parse(json);
    expect(parsed['@type']).toBe('FAQPage');
    expect(parsed.mainEntity[0].acceptedAnswer.text).toContain('</ScRiPt>');
  });

  it('builds a valid FAQPage for each real slug with the rendered (normalized) text', () => {
    for (const slug of Object.keys(FAQ_DATA)) {
      const parsed = JSON.parse(buildFaqJsonLd(slug));
      expect(parsed['@type']).toBe('FAQPage');
      expect(parsed.mainEntity).toHaveLength(FAQ_DATA[slug].length);
      for (const q of parsed.mainEntity) {
        expect(q['@type']).toBe('Question');
        expect(q.acceptedAnswer['@type']).toBe('Answer');
      }
    }
  });

  it('throws on an unknown slug', () => {
    expect(() => buildFaqJsonLd('nope')).toThrow(/no FAQ_DATA/);
  });
});

describe('mdToPlain — markdown -> rendered text for acceptedAnswer', () => {
  it('strips bold, code, and link markup to the display text', () => {
    expect(mdToPlain('you **connect** an AI client')).toBe('you connect an AI client');
    expect(mdToPlain('Do I need `mcp-remote`?')).toBe('Do I need mcp-remote?');
    expect(mdToPlain('See [Supported clients](/docs/reference/supported-clients/).')).toBe(
      'See Supported clients.',
    );
  });

  it('leaves em-dashes / parens / slashes intact (they render literally)', () => {
    expect(mdToPlain('20–40 minutes (first time) — yes')).toBe('20–40 minutes (first time) — yes');
  });
});
