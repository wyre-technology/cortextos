import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isPaidPlan } from './gate.js';

// ---------------------------------------------------------------------------
// Regression guard for sub-pattern #10 (presentation-enforcement parity).
//
// Empirical origin: 2026-05-11 found business-plan-owner Aaron stuck because
// gates throughout src/ inconsistently used `plan === 'pro'` (strict equality)
// instead of `isPaidPlan(plan)`. Each site treated the gate as tier-specific
// when the intent was paid-vs-free. New plan tiers added above `pro` then
// silently fail the gate everywhere strict equality lives. The PR-#71/#72/#86
// pattern: route every gate through the single-source-of-truth helper.
//
// This test fails CI if any file in src/ uses literal plan equality against
// 'pro' outside the allowlist below. The allowlist covers:
//   (1) gate.ts itself — defines the helper, may reference 'pro' freely
//   (2) admin badge-CSS lookups — map known plan slugs to CSS class names,
//       which legitimately need to enumerate every tier (not a gate)
// ---------------------------------------------------------------------------

const SRC_DIR = join(__dirname, '..');

const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'billing/gate.ts', reason: 'defines isPaidPlan helper' },
  { file: 'admin/routes.ts', reason: 'badge-CSS class lookup, enumerates every tier' },
  { file: 'admin/org-routes.ts', reason: 'badge-CSS class lookup, enumerates every tier' },
];

function walkSourceFiles(dir: string, accumulator: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, accumulator);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

const PLAN_EQ_PRO = /\bplan\s*(?:===|!==|==|!=)\s*['"]pro['"]/;

describe('plan-gate regression guard (sub-pattern #10)', () => {
  it('no src/ file outside allowlist references `plan === "pro"` or `plan !== "pro"`', () => {
    const files = walkSourceFiles(SRC_DIR);
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const path of files) {
      const rel = relative(SRC_DIR, path);
      if (ALLOWLIST.some((a) => rel === a.file)) continue;
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (!PLAN_EQ_PRO.test(line)) return;
        // Skip comment lines (JSDoc continuations, line comments) — they may
        // legitimately describe the pattern in prose without instantiating it.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        offenders.push({ file: rel, line: idx + 1, text: trimmed });
      });
    }

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}\n    ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} plan-equality drift site(s). Route gates through isPaidPlan(plan) from src/billing/gate.ts:\n${detail}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it('isPaidPlan returns true for any resolvable slug, false only for absent input', () => {
    // Flat-pricing: one plan, no free tier. Any resolvable slug — including a
    // legacy 'free'/'pro'/'business' value on an un-migrated row — is "on the
    // plan". Only genuinely-absent input (null/undefined/'') is not paid.
    expect(isPaidPlan('conduit')).toBe(true);
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('business')).toBe(true);
    expect(isPaidPlan('free')).toBe(true);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });
});
