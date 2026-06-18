import { describe, it, expect } from 'vitest';
import { VENDOR_TOOL_CONFIG } from '../proxy/result-cache.js';

// Arbitrary-execution-sweep — Tier-2 invariant per warden 6-class criterion
// (blast-radius-bounded-by-EXECUTION-SCOPE, banked 2026-06-18 via #453 re-push).
// Sibling to the #447 XSS-regression-guard discipline: forces explicit acknowledgment
// at each match. Makes the arbitrary-execution class closed-by-construction.
//
// If a future PR adds a tool whose NAME matches any of these execution-verb patterns
// and the tool is NOT classified isAdmin, this test FAILS LOUDLY — the only paths to
// resolve are (a) elevate to isAdmin (the common case), (b) add to ALLOWLIST below
// with a written justification (the rare-bounded-execution case).
//
// Pattern source — warden #453 sweep finding:
//  - executes operator CODE/SCRIPT on customer infra → ADMIN (run_*/execute/invoke patterns)
//  - triggers unbounded tenant-side-effect process → ADMIN (run_standards/inspections_run)
//  - destructive on customer-infra agents → ADMIN (agents_delete pattern)
//
// Pattern intentionally OVER-broad — false positives are fine (acknowledge by
// adding to ALLOWLIST), false negatives are launch-day security holes.

const EXECUTION_VERB_PATTERNS: RegExp[] = [
  /(^|_)run(_|$)/i,
  /(^|_)execute(_|$)/i,
  /(^|_)invoke(_|$)/i,
  /(^|_)dispatch(_|$)/i,
  /(^|_)trigger(_|$)/i,
  /(^|_)launch(_|$)/i,
  /(^|_)deploy(_|$)/i,
  /script_(run|execute)/i,
  /exec(_|$)/i,
];

/**
 * Tools that MATCH the execution-verb pattern but are NOT arbitrary-execution
 * blast-radius. Each entry MUST carry a one-line written justification (the
 * by-construction acknowledgment that this is bounded-execution, not arbitrary).
 *
 * NOTE: scripts_list / inspections_launchpoints / inspections_create_launchpoint /
 * inspections_inspectors are CONFIG/METADATA reads or definition-creates, not
 * executions — they don't fire scripts; the *_run sibling does (which IS admin).
 */
const EXECUTION_VERB_ALLOWLIST: Readonly<Record<string, string>> = {
  // ConnectWise Automate scripts catalog read (does NOT execute) — sibling of
  // scripts_run/_execute which would be admin if they existed in conduit's catalog.
  'connectwise-automate.cwautomate_scripts_list': 'reads script catalog, does not execute',
  // Liongard launchpoint metadata — config-not-execution per warden #453 verify.
  'liongard.liongard_inspections_launchpoints': 'reads launchpoint metadata, does not execute',
  'liongard.liongard_inspections_inspectors': 'reads inspector catalog metadata, does not execute',
  'liongard.liongard_inspections_create_launchpoint': 'creates inspection-config definition, does not execute',
};

describe('arbitrary-execution-sweep — Tier-2 invariant (warden 6-class criterion)', () => {
  it('every tool name matching execution-verb patterns is isAdmin (or in the written-allowlist)', () => {
    const offenders: string[] = [];
    for (const [vendor, tools] of Object.entries(VENDOR_TOOL_CONFIG)) {
      for (const [toolName, cfg] of Object.entries(tools)) {
        const matchedPattern = EXECUTION_VERB_PATTERNS.find((rx) => rx.test(toolName));
        if (!matchedPattern) continue;
        const key = `${vendor}.${toolName}`;
        if (EXECUTION_VERB_ALLOWLIST[key]) continue; // explicitly acknowledged
        if (!cfg.isAdmin) {
          offenders.push(`${key} matches pattern ${matchedPattern} but is NOT isAdmin (or in allowlist)`);
        }
      }
    }
    expect(
      offenders,
      `Arbitrary-execution-sweep: ${offenders.length} tool(s) match execution-verb patterns ` +
        `but are not isAdmin. Either (a) elevate to isAdmin (the common case — arbitrary-RCE class) ` +
        `or (b) add to EXECUTION_VERB_ALLOWLIST with a written justification (rare bounded-execution case). ` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the ALLOWLIST is non-empty and each entry has a written justification (forces explicit acknowledgment)', () => {
    expect(Object.keys(EXECUTION_VERB_ALLOWLIST).length).toBeGreaterThan(0);
    for (const [key, reason] of Object.entries(EXECUTION_VERB_ALLOWLIST)) {
      expect(reason.length, `ALLOWLIST entry ${key} must have a non-empty justification`).toBeGreaterThan(10);
    }
  });
});
