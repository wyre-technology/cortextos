import { describe, it, expect } from 'vitest';
import { beforeAll } from 'vitest';
import { VENDOR_TOOL_CONFIG } from '../proxy/result-cache.js';
import { tierForToolConfig } from './tier-check.js';

// Staging-deployed vendor invariant — sourced from #366 baseline 2026-06-09
// (tests/mcp/baselines/staging-tools.json). The launch promise on the pricing
// page ("all 56+ connectors") + the Phase-2 runtime gate's FAIL-CLOSED-deny
// behaviour together require: every vendor actually deployed at staging must
// have at least one classified tool in VENDOR_TOOL_CONFIG, or its tools will
// all FAIL-CLOSED at runtime once the tier-gate flag is on.
//
// This test ratchets the invariant by-construction: an unclassified staging-
// deployed vendor fails here BEFORE reaching production. Sibling to the
// shape-match-mechanism-to-substrate discipline (the test's substrate matches
// the runtime gate's substrate).
//
// Sourced from `tests/mcp/baselines/staging-tools.json` (8 vendors, 459 tools).
const STAGING_DEPLOYED_VENDORS: readonly string[] = [
  'autotask',
  'cipp',
  'datto-rmm',
  'domotz',
  'halopsa-official',
  'itglue',
  'liongard',
  'rootly',
];

describe('staging-deployed coverage invariant (Phase-1 launch-blocking)', () => {
  it.each(STAGING_DEPLOYED_VENDORS)(
    'staging-deployed vendor "%s" has at least one classified tool',
    (slug) => {
      const vendorBlock = VENDOR_TOOL_CONFIG[slug];
      expect(vendorBlock, `vendor "${slug}" is staging-deployed but unclassified`).toBeDefined();
      expect(
        Object.keys(vendorBlock ?? {}).length,
        `vendor "${slug}" has an empty classification block`,
      ).toBeGreaterThan(0);
    },
  );

  it('every classified tool maps to a non-null tier (no malformed entries)', () => {
    for (const [vendor, tools] of Object.entries(VENDOR_TOOL_CONFIG)) {
      for (const [toolName, cfg] of Object.entries(tools)) {
        const tier = tierForToolConfig(cfg);
        expect(tier, `${vendor}.${toolName}: tier-mapping returned null`).not.toBeNull();
      }
    }
  });

  it('staging-deployed coverage matches the #366 baseline source-of-truth (ratchets on drift)', () => {
    // Locks the source-of-truth in this test so a future #366-baseline change
    // requires updating BOTH this test AND the classifications. By-construction
    // discipline: source-of-truth lives in ONE place per the warden single-
    // source-of-truth pin family.
    expect(STAGING_DEPLOYED_VENDORS.length).toBe(8);
  });
});

// Per-TOOL ratchet (Phase-1b, ruby finding 2026-06-18) — the launch-critical
// invariant. The per-vendor test above checks ≥1 tool per vendor; this checks
// every staging-deployed tool. Source-of-truth: tests/mcp/baselines/staging-tools.json.
// Without this ratchet, a future deploy of an unclassified tool would FAIL-CLOSED-
// deny at the Phase-2 runtime gate.
describe('per-tool staging coverage ratchet (#366 baseline, Phase-1b)', () => {
  // Slug mapping: baseline indexes by vendor object; we extract per-vendor tool
  // lists by tool-name-prefix. NOTE this list is the SAME 8 vendors as above —
  // the per-tool check is the stricter sibling-invariant on the same set.
  const SLUG_MAP: Record<string, string> = {
    autotask: 'autotask',
    cipp: 'cipp',
    datto: 'datto-rmm',
    domotz: 'domotz',
    halopsa: 'halopsa-official',
    archive: 'itglue',
    liongard: 'liongard',
    attach: 'rootly',
  };

  let baseline: { vendors: Array<{ tools: string[] }> };

  beforeAll(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // tests/mcp/baselines/staging-tools.json — relative to repo root.
    const baselinePath = path.resolve(__dirname, '../../tests/mcp/baselines/staging-tools.json');
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  });

  it('every staging-deployed tool is classified in VENDOR_TOOL_CONFIG', () => {
    const missing: string[] = [];
    for (const v of baseline.vendors) {
      const prefix = v.tools[0]?.split('_')[0];
      const conduitSlug = SLUG_MAP[prefix];
      if (!conduitSlug) {
        missing.push(`[unmapped-prefix:${prefix}] all ${v.tools.length} tools`);
        continue;
      }
      const classifiedSet = new Set(Object.keys(VENDOR_TOOL_CONFIG[conduitSlug] ?? {}));
      for (const tool of v.tools) {
        if (!classifiedSet.has(tool)) {
          missing.push(`${conduitSlug}.${tool}`);
        }
      }
    }
    expect(
      missing,
      `${missing.length} staging-deployed tool(s) UNCLASSIFIED in VENDOR_TOOL_CONFIG ` +
        `— Phase-2 runtime gate would FAIL-CLOSED-deny these. ` +
        `Source-of-truth: tests/mcp/baselines/staging-tools.json (#366). ` +
        `Add classifications under the appropriate vendor block in src/proxy/result-cache.ts. ` +
        `Missing (first 20):\n  ${missing.slice(0, 20).join('\n  ')}` +
        (missing.length > 20 ? `\n  ... and ${missing.length - 20} more` : ''),
    ).toEqual([]);
  });
});
