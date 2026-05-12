import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAV_HREFS } from './layout.js';

// ---------------------------------------------------------------------------
// Lock-step regression guard: every sidebar nav href (top-level + sub-nav)
// MUST have a registered route handler in src/. Originally a PR #70 invariant
// for top-level items; PR #73 extends to the new Organization sub-nav items.
//
// Sub-pattern #10 (presentation-enforcement parity / gate-consistency) shape:
// the rendered nav presents an affordance to the user; the server must agree
// that the affordance points to something. Without this test the invariant
// is comment-only — a future contributor adding a nav item with no handler
// reproduces the exact bug PR #70 caught (Aaron's "logged in but cannot hit
// pages" symptom from clicking dead-link nav items).
//
// Source-level check (greps src/ for `app.get('<href>',`) is chosen over
// runtime injection because:
//   (a) zero new test infrastructure — the existing route registrations are
//       the source of truth
//   (b) catches the bug at build time, before any deploy or runtime probe
//   (c) registering webRoutes() in a test requires constructing the entire
//       deps object (orgService, billingGate, sql, etc.) — heavy for what
//       is a string-existence check at heart
// ---------------------------------------------------------------------------

const SRC_DIR = join(__dirname, '..');

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

function hasRouteHandlerFor(href: string): { found: boolean; matchedIn?: string } {
  // Matches `app.get('<href>',`, `app.get<...>('<href>',`, and the
  // multi-line variant where the `(` and the quoted href are on
  // different lines (typed generics often produce that shape). Generic
  // body can also span lines so we accept any chars between `<` and
  // `>`. Anchored to the literal href so /settings does NOT match
  // /org/billing.
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patternStr = `app\\.(get|post)(<[\\s\\S]*?>)?\\(\\s*['"\`]${escapedHref}['"\`]`;
  const pattern = new RegExp(patternStr);
  for (const file of walkSourceFiles(SRC_DIR)) {
    const content = readFileSync(file, 'utf8');
    if (pattern.test(content)) {
      return { found: true, matchedIn: file.replace(SRC_DIR + '/', '') };
    }
  }
  return { found: false };
}

describe('sidebar nav <-> route handler lock-step invariant', () => {
  it('exposes ALL_NAV_HREFS', () => {
    expect(ALL_NAV_HREFS.length).toBeGreaterThan(0);
  });

  for (const href of ALL_NAV_HREFS) {
    it(`href ${href} has a registered route handler`, () => {
      const { found, matchedIn } = hasRouteHandlerFor(href);
      expect(found, `no registered handler for sidebar nav href "${href}". ` +
        `Either remove it from PERSONAL_NAV/TEAM_NAV/ORGANIZATION_SUBNAV ` +
        `in src/web/layout.ts, or add the matching route handler in the ` +
        `same PR (lock-step invariant). Empirical origin: PR #70 ` +
        `removed 3 dead nav items that 404'd; PR #73 extends invariant ` +
        `to the new Organization sub-nav.`).toBe(true);
      // matchedIn is informational — surfaces in test output for grep-debug.
      expect(matchedIn).toBeDefined();
    });
  }
});
