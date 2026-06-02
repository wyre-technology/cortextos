import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
// here = docs/src/lib → ../content/docs reaches the MDX source.
const docsRoot = join(here, '..', 'content', 'docs');
const MDX_FOR_SLUG: Record<string, string> = {
  'getting-started': join(docsRoot, 'getting-started.mdx'),
  'guides/connecting-a-client': join(docsRoot, 'guides', 'connecting-a-client.mdx'),
  'guides/connecting-copilot-studio': join(docsRoot, 'guides', 'connecting-copilot-studio.mdx'),
};

describe('FAQ schema-matches-visible drift-catch', () => {
  // The acceptance gate: FAQPage JSON-LD must mirror the visible Q/A. FAQ_DATA
  // is the build-time source; this asserts it stays byte-faithful to the MDX,
  // so editing a visible Q OR A without updating FAQ_DATA fails CI.
  for (const slug of Object.keys(FAQ_DATA)) {
    it(`FAQ_DATA[${slug}] exactly matches the page's visible FAQ (Q + A, raw)`, () => {
      const mdx = readFileSync(MDX_FOR_SLUG[slug], 'utf8');
      const extracted = extractFaq(mdx);
      // deep-equals on BOTH question and answer text — not just count/questions.
      expect(extracted).toEqual(FAQ_DATA[slug].map((e) => ({ q: e.q, a: e.a })));
    });
  }

  it('extractFaq returns [] for a doc with no FAQ section', () => {
    expect(extractFaq('# Title\n\nSome prose.\n\n## Other\n\ntext')).toEqual([]);
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
