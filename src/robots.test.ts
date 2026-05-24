import { describe, it, expect } from 'vitest';
import { computeDocsNoindex, buildRobotsTxt, AI_CRAWLER_UAS, PROD_DOCS_HOST } from './robots.js';

describe('computeDocsNoindex — fail-safe env gate', () => {
  it('INDEXES only the prod apex docs host (conduit.wyre.ai)', () => {
    expect(computeDocsNoindex('https://conduit.wyre.ai', undefined)).toBe(false);
  });

  it('NOINDEXES staging', () => {
    expect(computeDocsNoindex('https://staging.conduit.wyre.ai', undefined)).toBe(true);
  });

  it('NOINDEXES the pre-cutover kinddesert FQDN (fail-safe default)', () => {
    expect(
      computeDocsNoindex('https://conduit-prod-gateway.kinddesert-88f38e67.eastus2.azurecontainerapps.io', undefined),
    ).toBe(true);
  });

  it('NOINDEXES localhost + the legacy mcp host (anything-not-prod-apex)', () => {
    expect(computeDocsNoindex('http://localhost:8080', undefined)).toBe(true);
    expect(computeDocsNoindex('https://mcp.wyre.ai', undefined)).toBe(true);
  });

  it('NOINDEXES a malformed BASE_URL (fail-safe on parse failure)', () => {
    expect(computeDocsNoindex('not-a-url', undefined)).toBe(true);
  });

  it('DOCS_NOINDEX override wins when set — forces noindex even on prod apex', () => {
    expect(computeDocsNoindex('https://conduit.wyre.ai', 'true')).toBe(true);
  });

  it('DOCS_NOINDEX override wins when set — forces index even on staging', () => {
    expect(computeDocsNoindex('https://staging.conduit.wyre.ai', 'false')).toBe(false);
  });

  it('DOCS_NOINDEX override hardening — only exact "false" indexes; typos default-DENY (noindex)', () => {
    // warden Finding B: a typo on the override must NOT invert the fail-safe.
    for (const typo of ['1', 'yes', 'TRUE', 'False', 'no', '', '0']) {
      expect(computeDocsNoindex('https://conduit.wyre.ai', typo)).toBe(true);
    }
    expect(computeDocsNoindex('https://conduit.wyre.ai', 'false')).toBe(false);
  });
});

describe('buildRobotsTxt', () => {
  it('noindex mode disallows all + names every AI-crawler UA', () => {
    const txt = buildRobotsTxt(true, 'https://staging.conduit.wyre.ai');
    expect(txt).toMatch(/User-agent: \*\nDisallow: \//);
    for (const ua of AI_CRAWLER_UAS) {
      expect(txt).toContain(`User-agent: ${ua}\nDisallow: /`);
    }
    // noindex variant must NOT advertise a sitemap
    expect(txt).not.toContain('Sitemap:');
  });

  it('index mode allows all + points at the docs sitemap', () => {
    const txt = buildRobotsTxt(false, 'https://conduit.wyre.ai');
    expect(txt).toContain('User-agent: *\nDisallow:\n');
    expect(txt).toContain('Sitemap: https://conduit.wyre.ai/docs/sitemap-index.xml');
    // index variant must NOT disallow-all
    expect(txt).not.toMatch(/Disallow: \//);
  });

  it('index-mode sitemap strips a trailing slash from BASE_URL', () => {
    const txt = buildRobotsTxt(false, 'https://conduit.wyre.ai/');
    expect(txt).toContain('Sitemap: https://conduit.wyre.ai/docs/sitemap-index.xml');
  });

  it('PROD_DOCS_HOST is the apex (guards against an accidental host rename)', () => {
    expect(PROD_DOCS_HOST).toBe('conduit.wyre.ai');
  });
});
