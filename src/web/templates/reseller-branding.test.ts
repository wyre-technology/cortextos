import { describe, it, expect } from 'vitest';
import {
  renderResellerBranding,
  type ResellerBranding,
  type ResellerBrandingData,
} from './reseller-branding.js';
import type { Organization } from '../../org/org-service.js';

const org: Organization = {
  id: 'org_reseller',
  name: 'WYRE Technology',
  ownerId: 'auth0|1',
  plan: 'business',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'reseller',
  parentOrgId: null,
  auth0OrgId: null,
  suspendedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-16T00:00:00Z',
};

const branding = (over: Partial<ResellerBranding> = {}): ResellerBranding => ({
  defaultUrl: 'conduit.wyre.ai/v1/mcp/wyre-technology/am3-technology',
  brandAlias: 'mcp.wyretechnology.com',
  aliasVerified: true,
  logoUrl: null,
  colors: { accent: '#D93232', textOnDark: '#F2F2F5', textOnLight: '#212126' },
  emailFromName: 'WYRE Technology',
  emailFromAddress: 'notifications@conduit.wyre.ai',
  emailAuthStatus: 'SPF + DKIM verified · DMARC pending',
  emailAuthVerified: false,
  directBillingEnabled: false,
  ...over,
});

function data(over: Partial<ResellerBranding> = {}): ResellerBrandingData {
  return { org, branding: branding(over), sampleCustomerName: 'AM3 Technology' };
}

describe('renderResellerBranding', () => {
  it('renders the header with the sample customer in the subtitle', () => {
    const html = renderResellerBranding(data());
    expect(html).toContain('Branding');
    expect(html).toContain('How AM3 Technology and your other customers see Conduit');
  });

  it('renders the default URL as a read-only field', () => {
    const html = renderResellerBranding(data());
    expect(html).toContain('conduit.wyre.ai/v1/mcp/wyre-technology/am3-technology');
    expect(html).toMatch(/rb-input-readonly[^>]*value="conduit\.wyre\.ai/);
  });

  it('shows the verified badge and DNS link when the alias is verified', () => {
    const html = renderResellerBranding(data({ brandAlias: 'mcp.foo.com', aliasVerified: true }));
    expect(html).toContain('Verified');
    expect(html).toContain('Edit DNS');
  });

  it('shows a DNS-pending badge for an unverified alias', () => {
    const html = renderResellerBranding(data({ brandAlias: 'mcp.foo.com', aliasVerified: false }));
    expect(html).toContain('DNS pending');
    expect(html).not.toContain('&#10003; Verified');
  });

  it('omits the alias badge entirely when no alias is set', () => {
    const html = renderResellerBranding(data({ brandAlias: null }));
    expect(html).not.toContain('Verified');
    expect(html).not.toContain('DNS pending');
    expect(html).not.toContain('Edit DNS');
  });

  it('renders the three brand-color swatches with uppercased hex', () => {
    const html = renderResellerBranding(data());
    expect(html).toContain('#D93232');
    expect(html).toContain('#F2F2F5');
    expect(html).toContain('#212126');
    expect(html).toContain('Accent');
    expect(html).toContain('Text on dark');
  });

  it('renders the From address read-only (v1 fixed platform address)', () => {
    const html = renderResellerBranding(data());
    expect(html).toMatch(/rb-input-readonly[^>]*value="notifications@conduit\.wyre\.ai"/);
    expect(html).toContain('Fixed platform address in v1');
  });

  it('renders the From name as an editable (non-readonly) input', () => {
    const html = renderResellerBranding(data());
    const fromName = html.match(/<input[^>]*value="WYRE Technology"[^>]*>/)?.[0] ?? '';
    expect(fromName).not.toContain('readonly');
  });

  it('renders the email auth status amber when DMARC is unverified', () => {
    const html = renderResellerBranding(data({ emailAuthVerified: false }));
    expect(html).toContain('rb-email-warn');
    expect(html).not.toContain('rb-email-ok');
  });

  it('renders the email auth status green when verified', () => {
    const html = renderResellerBranding(data({ emailAuthVerified: true }));
    expect(html).toContain('rb-email-ok');
  });

  it('renders the Stripe Connect toggle disabled and unchecked by default', () => {
    const html = renderResellerBranding(data({ directBillingEnabled: false }));
    const toggle = html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('disabled');
    expect(toggle).not.toContain('checked');
  });

  it('ships the Save button disabled (no persistence route in v1)', () => {
    const html = renderResellerBranding(data());
    expect(html).toMatch(/rb-save[^>]*disabled/);
  });

  it('renders the empty upload zone when no logo is set', () => {
    const html = renderResellerBranding(data({ logoUrl: null }));
    expect(html).toContain('Drop SVG/PNG or click to upload');
    expect(html).not.toContain('rb-logo-preview');
  });

  it('renders a logo preview when a logo URL is present', () => {
    const html = renderResellerBranding(data({ logoUrl: 'https://cdn.example.com/logo.svg' }));
    expect(html).toContain('rb-logo-preview');
    expect(html).toContain('https://cdn.example.com/logo.svg');
  });

  it('escapes the sample customer name (no HTML injection)', () => {
    const html = renderResellerBranding({
      org,
      branding: branding(),
      sampleCustomerName: '<script>x</script>',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rejects a CSS-injection payload in a brand color (no style breakout)', () => {
    const html = renderResellerBranding(data({
      colors: {
        accent: 'red;background:url(https://evil/x)',
        textOnDark: '#fff} body{display:none',
        textOnLight: '#212126',
      },
    }));
    // The malicious values never reach the style attribute…
    expect(html).not.toContain('url(https://evil/x)');
    expect(html).not.toContain('body{display:none');
    // …a bad swatch falls back to the accent token and shows an em-dash hex.
    expect(html).toContain('style="background:var(--accent)"');
    // The one valid hex still renders.
    expect(html).toContain('#212126');
  });

  it('drops a non-https logo URL rather than rendering it', () => {
    const html = renderResellerBranding(data({ logoUrl: 'javascript:alert(1)' }));
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('rb-logo-preview');
    expect(html).toContain('Drop SVG/PNG or click to upload');
  });
});
