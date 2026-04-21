import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('brand config', () => {
  const envBackup: Record<string, string | undefined> = {};
  const BRAND_VARS = [
    'BRAND_NAME', 'BRAND_TAGLINE', 'BRAND_LOGO_URL', 'BRAND_SUPPORT_URL',
    'BRAND_DOCS_URL', 'BRAND_ISSUES_URL', 'BRAND_PRIMARY_COLOR', 'BRAND_DOMAIN',
    'BASE_URL',
  ];

  beforeEach(() => {
    for (const key of BRAND_VARS) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of BRAND_VARS) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key];
      } else {
        delete process.env[key];
      }
    }
  });

  async function loadBrand() {
    // Dynamic import to pick up env changes (module cache is per-import in vitest)
    const mod = await import('./index.js');
    return mod.brand;
  }

  it('uses default values when no env vars set', async () => {
    const b = await loadBrand();
    expect(b.name).toBe('Wyre Technology');
    expect(b.tagline).toBe('Customer MCP Gateway');
    expect(b.logoUrl).toBe('https://wyretechnology.com/wp-content/uploads/2018/02/WYRE-Square-web.webp');
    expect(b.supportUrl).toBe('');
    expect(b.docsUrl).toBe('/');
    expect(b.issuesUrl).toContain('github.com/wyre-technology');
    expect(b.primaryColor).toBe('#EDE947');
  });

  it('exports BrandConfig type', async () => {
    const mod = await import('./types.js');
    // Type-only test — just ensure the module loads
    expect(mod).toBeDefined();
  });
});
