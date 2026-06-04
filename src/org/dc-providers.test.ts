import { describe, it, expect } from 'vitest';
import {
  classifyProvider,
  buildDcApplyUrl,
  getProviderName,
  DC_SUPPORTED_SLUGS,
} from './dc-providers.js';

/**
 * Unit tests for the Domain Connect provider classification + apply-URL
 * construction (WYREAI-134 + WYREAI-135).
 *
 * Inject the NS resolver so these tests are fully hermetic — no live DNS
 * traffic. The injected resolver returns NS records in the same shape
 * node:dns/promises.resolveNs would (string[] of host names).
 */

describe('classifyProvider — WYREAI-134 NS-pattern classification', () => {
  it('classifies Cloudflare from ns.cloudflare.com NS pattern', async () => {
    const ns = async () => ['adel.ns.cloudflare.com', 'cleo.ns.cloudflare.com'];
    expect(await classifyProvider('example.com', ns)).toBe('cloudflare');
  });

  it('classifies GoDaddy from domaincontrol.com NS pattern', async () => {
    const ns = async () => ['ns07.domaincontrol.com', 'ns08.domaincontrol.com'];
    expect(await classifyProvider('example.com', ns)).toBe('godaddy');
  });

  it('classifies Vercel from vercel-dns.com NS pattern', async () => {
    const ns = async () => ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'];
    expect(await classifyProvider('example.com', ns)).toBe('vercel');
  });

  it('returns unsupported for AWS Route53 (long-tail per cohort research)', async () => {
    const ns = async () => [
      'ns-1026.awsdns-00.org',
      'ns-1712.awsdns-22.co.uk',
      'ns-484.awsdns-60.com',
    ];
    expect(await classifyProvider('example.com', ns)).toBe('unsupported');
  });

  it('returns unsupported for Gandi (long-tail)', async () => {
    const ns = async () => ['ns-128-c.gandi.net', 'ns-156-a.gandi.net'];
    expect(await classifyProvider('example.com', ns)).toBe('unsupported');
  });

  it('returns unsupported for Google Cloud DNS (Google Domains gone, long-tail)', async () => {
    const ns = async () => [
      'ns-cloud-b1.googledomains.com',
      'ns-cloud-b2.googledomains.com',
    ];
    expect(await classifyProvider('example.com', ns)).toBe('unsupported');
  });

  it('returns unsupported for self-hosted NS (matches the domain itself)', async () => {
    const ns = async () => ['kwns1.kw-corp.com', 'kwns2.kw-corp.com'];
    expect(await classifyProvider('kw-corp.com', ns)).toBe('unsupported');
  });

  it('handles case-insensitive NS patterns (e.g. SHOUTY-NS-records)', async () => {
    const ns = async () => ['ADEL.NS.CLOUDFLARE.COM', 'CLEO.NS.CLOUDFLARE.COM'];
    expect(await classifyProvider('example.com', ns)).toBe('cloudflare');
  });

  it('returns unsupported on empty NS array', async () => {
    const ns = async () => [];
    expect(await classifyProvider('example.com', ns)).toBe('unsupported');
  });

  it('returns unsupported (does not throw) on resolver error — defense in depth', async () => {
    const ns = async () => {
      throw new Error('ENOTFOUND example.com');
    };
    expect(await classifyProvider('example.com', ns)).toBe('unsupported');
  });

  it('matches trailing-dot NS records (dig +short shape)', async () => {
    // node:dns returns NS records WITHOUT trailing dots normally, but if a
    // resolver returns them WITH dots the substring match still works.
    const ns = async () => ['adel.ns.cloudflare.com.', 'cleo.ns.cloudflare.com.'];
    expect(await classifyProvider('example.com', ns)).toBe('cloudflare');
  });
});

describe('buildDcApplyUrl — WYREAI-135 apply-URL construction', () => {
  it('builds Cloudflare apply URL with domain + token + redirect_uri', () => {
    const url = buildDcApplyUrl({
      provider: 'cloudflare',
      domain: 'example.com',
      verificationToken: 'tok-abc-123',
      callbackUrl: 'https://conduit.wyre.ai/cb',
    });
    expect(url).toBeTruthy();
    expect(url).toContain('https://domainconnect.cloudflare.com/v2/domainTemplates/');
    expect(url).toContain('providers/conduit.wyre.ai');
    expect(url).toContain('services/domain-verify');
    expect(url).toContain('apply?');
    expect(url).toContain('domain=example.com');
    expect(url).toContain('verification_token=tok-abc-123');
    expect(url).toContain('redirect_uri=https');
  });

  it('builds GoDaddy apply URL with dcc.godaddy.com host', () => {
    const url = buildDcApplyUrl({
      provider: 'godaddy',
      domain: 'mspadvisor.com',
      verificationToken: 'tok-x',
      callbackUrl: 'https://conduit.wyre.ai/cb',
    });
    expect(url).toBeTruthy();
    expect(url).toContain('https://dcc.godaddy.com/');
  });

  it('builds Vercel apply URL with domainconnect.vercel.com host', () => {
    const url = buildDcApplyUrl({
      provider: 'vercel',
      domain: 'mspilot.io',
      verificationToken: 'tok-y',
      callbackUrl: 'https://conduit.wyre.ai/cb',
    });
    expect(url).toBeTruthy();
    expect(url).toContain('https://domainconnect.vercel.com/');
  });

  it('URL-encodes the callback URL parameters', () => {
    const url = buildDcApplyUrl({
      provider: 'cloudflare',
      domain: 'example.com',
      verificationToken: 'tok-abc',
      callbackUrl: 'https://conduit.wyre.ai/api/orgs/org_xyz/domains/dom_abc/dc-callback',
    });
    // The redirect_uri value must be percent-encoded so the slashes don't
    // terminate the query string.
    expect(url).toContain('redirect_uri=https%3A%2F%2Fconduit.wyre.ai%2F');
  });

  it('accepts custom providerId + serviceId overrides', () => {
    const url = buildDcApplyUrl({
      provider: 'cloudflare',
      domain: 'example.com',
      verificationToken: 'tok',
      callbackUrl: 'https://example.test/cb',
      providerId: 'staging.conduit.wyre.ai',
      serviceId: 'domain-verify-staging',
    });
    expect(url).toContain('providers/staging.conduit.wyre.ai');
    expect(url).toContain('services/domain-verify-staging');
  });
});

describe('DC_SUPPORTED_SLUGS + getProviderName — frontend helpers', () => {
  it('exports the canonical Tier-1 slug list', () => {
    expect(DC_SUPPORTED_SLUGS).toEqual(['cloudflare', 'godaddy', 'vercel']);
  });

  it('returns human-readable provider names for button labels', () => {
    expect(getProviderName('cloudflare')).toBe('Cloudflare');
    expect(getProviderName('godaddy')).toBe('GoDaddy');
    expect(getProviderName('vercel')).toBe('Vercel');
  });
});
