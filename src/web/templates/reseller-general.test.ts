import { describe, it, expect } from 'vitest';
import type { Organization } from '../../org/org-service.js';
import { renderResellerGeneral } from './reseller-general.js';

/**
 * Track C reseller-settings General — locks the v1 contract per boss
 * dispatch msg-1781452776703:
 *   - Org name editable (rendered as <input>)
 *   - Slug READ-ONLY, derived from name (locked behind a separate flow)
 *   - Form posts to PATCH /api/orgs/:id (no new backend endpoint)
 *   - Flash messages render when present
 */

function fakeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org_abc',
    name: 'Acme MSP',
    ownerId: 'user_owner',
    plan: 'conduit',
    defaultServerAccess: 'none',
    promptCaptureEnabled: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    type: 'reseller',
    parentOrgId: null,
    auth0OrgId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('renderResellerGeneral — v1 contract', () => {
  it('renders the org name as an editable input pre-filled with the current value', () => {
    const html = renderResellerGeneral({ org: fakeOrg() });
    expect(html).toContain('id="rgName"');
    expect(html).toContain('value="Acme MSP"');
    // No readonly attribute on the name input
    expect(html).toMatch(/<input id="rgName"[^>]*?(?<!readonly)>/);
  });

  it('derives the slug from the org name and renders it READ-ONLY', () => {
    const html = renderResellerGeneral({ org: fakeOrg({ name: 'Acme MSP Co.' }) });
    expect(html).toContain('id="rgSlug"');
    expect(html).toContain('value="acme-msp-co"');
    // The slug input MUST carry readonly + aria-readonly to lock the field.
    expect(html).toMatch(/<input id="rgSlug"[^>]*readonly/);
    expect(html).toMatch(/aria-readonly="true"/);
  });

  it('explains in copy that custom slugs require a separate flow (downstream-link-rot guard)', () => {
    const html = renderResellerGeneral({ org: fakeOrg() });
    expect(html).toContain("Custom slugs aren't supported yet");
    expect(html).toContain('break their saved MCP endpoints');
  });

  it('form POSTs to the existing PATCH /api/orgs/:id endpoint (no new backend route required)', () => {
    const html = renderResellerGeneral({ org: fakeOrg() });
    expect(html).toContain("/api/orgs/' + encodeURIComponent(orgId)");
    expect(html).toContain("method: 'PATCH'");
    expect(html).toContain('JSON.stringify({ name: newName })');
  });

  it('renders flash_ok / flash_err alerts when provided', () => {
    const ok = renderResellerGeneral({ org: fakeOrg(), flashOk: 'Saved.' });
    expect(ok).toContain('rg-flash-ok');
    expect(ok).toContain('Saved.');

    const err = renderResellerGeneral({ org: fakeOrg(), flashErr: 'Boom.' });
    expect(err).toContain('rg-flash-err');
    expect(err).toContain('Boom.');
  });

  it('escapes user-controllable strings (XSS regression-guard)', () => {
    const evil = fakeOrg({ name: '<script>alert(1)</script>' });
    const html = renderResellerGeneral({ org: evil });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
