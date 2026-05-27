import { describe, it, expect } from 'vitest';
import { assertCrossRepoParity } from './vendor-canonical-parity.js';
import { BATCH_1_SLUGS } from './vendor-batch1.js';

/**
 * Field-scoped cross-repo parity assert. The CANONICALIZER is pinned by
 * vendor-canonical.test.ts; this pins the ASSERT LOGIC — equal-on-N +
 * field-scoped-allow, fail-closed on unlisted-field drift / missing slug /
 * non-batch-1 allow entry.
 */
function makeMap(over: Record<string, Record<string, unknown>> = {}): Record<string, string> {
  // A baseline IDENTICAL map for all 31 batch-1 slugs, then apply per-slug overrides.
  const out: Record<string, string> = {};
  for (const slug of BATCH_1_SLUGS) {
    const base: Record<string, unknown> = {
      slug, category: 'rmm', containerUrl: `http://${slug}-mcp:8080`,
      fieldNames: ['apiKey'], headerMapping: { apiKey: 'X-Key' }, mcpPath: '/mcp', oauth: null,
    };
    out[slug] = JSON.stringify({ ...base, ...(over[slug] ?? {}) });
  }
  return out;
}

describe('assertCrossRepoParity — field-scoped', () => {
  it('passes when the two maps are identical (no allow-list needed)', () => {
    const r = assertCrossRepoParity(makeMap(), makeMap(), {});
    expect(r.matched).toHaveLength(BATCH_1_SLUGS.length);
    expect(r.allowed).toHaveLength(0);
  });

  it('passes when a slug drifts ONLY on its allow-listed field', () => {
    const b = makeMap({ avanan: { headerMapping: { apiKey: 'X-Different' } } });
    const r = assertCrossRepoParity(makeMap(), b, { avanan: ['headerMapping'] });
    expect(r.allowed).toEqual(['avanan']);
    expect(r.matched).toHaveLength(BATCH_1_SLUGS.length - 1);
  });

  it('FAILS (fail-closed) when an allow-listed slug drifts on an UNLISTED field', () => {
    // avanan allow-listed for headerMapping, but here it drifts on category.
    const b = makeMap({ avanan: { category: 'psa' } });
    expect(() => assertCrossRepoParity(makeMap(), b, { avanan: ['headerMapping'] })).toThrow(/UNLISTED field/);
  });

  it('FAILS when a NON-allow-listed slug drifts', () => {
    const b = makeMap({ atera: { containerUrl: 'http://elsewhere:9090' } });
    expect(() => assertCrossRepoParity(makeMap(), b, {})).toThrow(/UNLISTED field.*atera/);
  });

  it('FAILS when a batch-1 slug is missing from a map', () => {
    const a = makeMap();
    delete a.atera;
    expect(() => assertCrossRepoParity(a, makeMap(), {})).toThrow(/missing/);
  });

  it('FAILS when the allow-list names a non-batch-1 slug (no-silent-grow)', () => {
    expect(() => assertCrossRepoParity(makeMap(), makeMap(), { 'not-a-vendor': ['headerMapping'] })).toThrow(
      /non-batch-1 slug/,
    );
  });

  it('reports a shrink candidate when an allow-listed slug no longer drifts', () => {
    // qbo is allow-listed but the maps are identical → the entry can be removed.
    const r = assertCrossRepoParity(makeMap(), makeMap(), { qbo: ['headerMapping'] });
    expect(r.shrinkCandidates).toContain('qbo');
  });
});
