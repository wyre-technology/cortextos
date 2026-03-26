import { describe, it, expect } from 'vitest';
import { renderConnectPage } from './connect.js';
import type { VendorConfig } from '../../credentials/vendor-config.js';

const testVendor: VendorConfig = {
  name: 'Test Vendor',
  slug: 'test-vendor',
  category: 'rmm',
  containerUrl: 'http://test:8080',
  fields: [
    { key: 'apiKey', label: 'API Key', required: true },
    { key: 'secret', label: 'Secret', required: true, secret: true },
    { key: 'region', label: 'Region', required: true, options: ['us', 'eu'] },
    { key: 'note', label: 'Note', required: false, placeholder: 'Optional note' },
  ],
  headerMapping: { apiKey: 'X-Test-Key', secret: 'X-Test-Secret', region: 'X-Test-Region' },
  docsUrl: 'https://example.com/docs',
};

describe('renderConnectPage', () => {
  it('renders all required fields with required attribute', () => {
    const html = renderConnectPage(testVendor);
    expect(html).toContain('name="apiKey"');
    expect(html).toContain('name="secret"');
    expect(html).toContain('name="region"');
    expect(html).toContain('required');
  });

  it('renders secret fields as password inputs', () => {
    const html = renderConnectPage(testVendor);
    expect(html).toContain('type="password" id="secret"');
  });

  it('renders select fields with options', () => {
    const html = renderConnectPage(testVendor);
    expect(html).toContain('<select');
    expect(html).toContain('<option value="us">us</option>');
    expect(html).toContain('<option value="eu">eu</option>');
  });

  it('renders placeholder text', () => {
    const html = renderConnectPage(testVendor);
    expect(html).toContain('placeholder="Optional note"');
  });

  it('includes oauth_session as hidden field when provided', () => {
    const html = renderConnectPage(testVendor, 'session-abc-123');
    expect(html).toContain('name="oauth_session"');
    expect(html).toContain('value="session-abc-123"');
  });

  it('does not include oauth_session when not provided', () => {
    const html = renderConnectPage(testVendor);
    expect(html).not.toContain('oauth_session');
  });

  it('renders error banner when error is provided', () => {
    const html = renderConnectPage(testVendor, undefined, 'Something went wrong');
    expect(html).toContain('error-banner');
    expect(html).toContain('Something went wrong');
  });

  it('escapes HTML in vendor name to prevent XSS', () => {
    const xssVendor = {
      ...testVendor,
      name: '<script>alert("xss")</script>',
    };
    const html = renderConnectPage(xssVendor);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML in error messages to prevent XSS', () => {
    const html = renderConnectPage(testVendor, undefined, '<img onerror=alert(1)>');
    expect(html).not.toContain('<img onerror=alert(1)>');
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
  });

  it('escapes oauth_session value in hidden field', () => {
    const html = renderConnectPage(testVendor, '"><script>alert(1)</script>');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('links to vendor documentation', () => {
    const html = renderConnectPage(testVendor);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
