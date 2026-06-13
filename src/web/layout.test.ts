import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAV_HREFS, renderLayout } from './layout.js';
import type { Organization } from '../org/org-service.js';
import type { Auth0User } from '../auth/auth0.js';

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

// ---------------------------------------------------------------------------
// Reseller-console shell (Track C foundation)
// ---------------------------------------------------------------------------

const mockUser: Auth0User = {
  sub: 'auth0|test',
  email: 'admin@example.com',
  name: 'Test Admin',
  emailVerified: true,
};

function orgOfType(type: Organization['type']): Organization {
  return {
    id: 'org_1',
    name: 'Acme MSP',
    ownerId: 'auth0|test',
    plan: 'pro',
    defaultServerAccess: 'none',
    promptCaptureEnabled: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    type,
    parentOrgId: null,
    auth0OrgId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-16T00:00:00Z',
  };
}

describe('reseller-console nav', () => {
  it('shows the Customers item + RESELLER badge for reseller orgs', () => {
    const html = renderLayout(
      { user: mockUser, org: orgOfType('reseller'), activePath: '/org', title: 'T' },
      '<p>body</p>',
    );
    expect(html).toContain('href="/org/customers"');
    expect(html).toContain('RESELLER');
  });

  it('omits the Customers item for non-reseller orgs', () => {
    const html = renderLayout(
      { user: mockUser, org: orgOfType('standalone'), activePath: '/org', title: 'T' },
      '<p>body</p>',
    );
    expect(html).not.toContain('href="/org/customers"');
  });
});

describe('reseller-settings nav mode', () => {
  it('renders the reseller-settings section and omits Personal/Team', () => {
    const html = renderLayout(
      {
        user: mockUser,
        org: orgOfType('reseller'),
        activePath: '/org/reseller/branding',
        title: 'Branding',
        navMode: 'reseller-settings',
      },
      '<p>body</p>',
    );
    expect(html).toContain('href="/org/reseller/general"');
    expect(html).toContain('href="/org/reseller/branding"');
    expect(html).toContain('RESELLER · SETTINGS');
    // Personal/Team sections are replaced, not appended.
    expect(html).not.toContain('>Personal<');
    expect(html).not.toContain('href="/org/dashboard"');
  });

  it('default navMode keeps the standard Personal + Team shell', () => {
    const html = renderLayout(
      { user: mockUser, org: orgOfType('reseller'), activePath: '/org', title: 'T' },
      '<p>body</p>',
    );
    expect(html).toContain('>Personal<');
    expect(html).not.toContain('RESELLER · SETTINGS');
  });
});

describe('customer-detail nav mode + tenant switcher (Track C Area 3)', () => {
  const customerDetail = (siblings?: Array<{ id: string; name: string }>) =>
    renderLayout(
      {
        user: mockUser,
        org: orgOfType('reseller'),
        activePath: '/org/customers/c1',
        title: 'Customer',
        navMode: 'customer-detail',
        customerContext: { id: 'c1', name: 'AM3 Technology', siblings },
      },
      '<p>body</p>',
    );

  it('renders the customer-context sidebar with the VIEWING AS RESELLER banner', () => {
    const html = customerDetail();
    expect(html).toContain('VIEWING AS RESELLER');
    expect(html).toContain('AM3 Technology');
    expect(html).toContain('href="/org/customers"'); // back link
  });

  it('renders a tenant switcher when there are siblings to switch to', () => {
    const html = customerDetail([
      { id: 'c1', name: 'AM3 Technology' },
      { id: 'c2', name: 'Team DNS Solutions' },
    ]);
    expect(html).toContain('<details class="ts-switcher"');
    expect(html).toContain('href="/org/customers/c2"'); // a switch target
    expect(html).toContain('href="/org"');              // up to the reseller
  });

  it('marks the current customer as a non-link option in the switcher', () => {
    const html = customerDetail([
      { id: 'c1', name: 'AM3 Technology' },
      { id: 'c2', name: 'Team DNS Solutions' },
    ]);
    // Current tenant renders as a span, not an anchor.
    expect(html).toContain('ts-option-current" aria-current="true">AM3 Technology</span>');
  });

  it('degrades to a plain label when there is nowhere to switch (omit, not blank)', () => {
    const html = customerDetail([{ id: 'c1', name: 'AM3 Technology' }]);
    expect(html).not.toContain('<details class="ts-switcher"');
    expect(html).toContain('AM3 Technology');
  });
});
