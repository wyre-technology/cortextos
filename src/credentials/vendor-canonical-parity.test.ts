import { describe, it, expect } from 'vitest';
import { assertCrossRepoParity } from './vendor-canonical-parity.js';
import {
  BATCH_1_SLUGS,
  DEFERRED_FROM_BATCH_1_SLUGS,
  DEFERRED_REASONS,
} from './vendor-batch1.js';
import { VENDORS } from './vendor-config.js';

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

// Fail-by-design SET-COMPLETENESS guard at the deferred-parity horizon.
// Closes analyst's ALL-DEFERRED-INVISIBLE-AT-CATALOG NIT (boss
// msg-1781589739906): a new vendor added to `VENDORS` MUST be
// classified as either BATCH_1 (parity-asserted) OR
// DEFERRED_FROM_BATCH_1 (explicitly deferred with a stated reason).
// Silent-growth catches the analyst-NIT-class issue before it ships.
//
// Sub-pin under the by-construction-lock-in family — at the
// set-completeness axis (sibling shape to the dropdown-options /
// validate-allowlist single-source-of-truth pattern that #402 + #405
// + #422 share, but applied to a CLASSIFICATION partition).
describe('deferred-parity horizon — SET-COMPLETENESS by-construction', () => {
  it('every vendor in VENDORS is either BATCH_1 or DEFERRED_FROM_BATCH_1 (no orphans)', () => {
    const batch1 = new Set(BATCH_1_SLUGS);
    const deferred = new Set(Object.keys(DEFERRED_FROM_BATCH_1_SLUGS));
    const orphans: string[] = [];
    for (const slug of Object.keys(VENDORS)) {
      if (!batch1.has(slug) && !deferred.has(slug)) {
        orphans.push(slug);
      }
    }
    expect(
      orphans,
      `Unclassified vendor(s) — add to BATCH_1_SLUGS (and supply parity ` +
        `fixtures) OR to DEFERRED_FROM_BATCH_1_SLUGS (with a stated ` +
        `reason). Orphans: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('no slug is in BOTH BATCH_1 and DEFERRED (partition is disjoint)', () => {
    const batch1 = new Set(BATCH_1_SLUGS);
    const overlap = Object.keys(DEFERRED_FROM_BATCH_1_SLUGS).filter((s) => batch1.has(s));
    expect(
      overlap,
      `Slug(s) in BOTH BATCH_1 and DEFERRED — remove from DEFERRED ` +
        `(BATCH_1 is the parity-asserted side). Overlap: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('every DEFERRED entry carries a reason from the fixed vocabulary', () => {
    const validReasons = new Set<string>(DEFERRED_REASONS);
    const badReasons: Array<[string, string]> = [];
    for (const [slug, reason] of Object.entries(DEFERRED_FROM_BATCH_1_SLUGS)) {
      if (!validReasons.has(reason)) {
        badReasons.push([slug, reason]);
      }
    }
    expect(
      badReasons,
      `Deferred entry with unknown reason — vocabulary is fixed at ` +
        `DEFERRED_REASONS: ${DEFERRED_REASONS.join(' | ')}. ` +
        `Offenders: ${badReasons.map(([s, r]) => `${s}=${r}`).join(', ')}`,
    ).toEqual([]);
  });

  it('every DEFERRED entry references a slug that actually exists in VENDORS (no ghost classifications)', () => {
    const existing = new Set(Object.keys(VENDORS));
    const ghosts = Object.keys(DEFERRED_FROM_BATCH_1_SLUGS).filter((s) => !existing.has(s));
    expect(
      ghosts,
      `DEFERRED slug(s) not present in VENDORS — remove from DEFERRED ` +
        `(probably renamed or removed upstream). Ghosts: ${ghosts.join(', ')}`,
    ).toEqual([]);
  });
});
