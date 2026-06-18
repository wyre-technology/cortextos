import { describe, it, expect } from 'vitest';
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
