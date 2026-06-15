import { describe, it, expect, vi, afterEach } from 'vitest';
import { getVendor, getVendorSlugs, getVendorsByCategory, VENDORS, VENDOR_CATEGORIES } from './vendor-config.js';

describe('vendor-config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns all vendor slugs', () => {
    const slugs = getVendorSlugs();
    expect(slugs).toHaveLength(Object.keys(VENDORS).length);
    expect(slugs).toContain('datto-rmm');
    expect(slugs).toContain('itglue');
    expect(slugs).toContain('autotask');
    expect(slugs).toContain('liongard');
    expect(slugs).toContain('ninjaone');
    expect(slugs).toContain('connectwise-psa');
    expect(slugs).toContain('connectwise-automate');
    expect(slugs).toContain('salesbuildr');
    expect(slugs).toContain('hudu');
    expect(slugs).toContain('rocketcyber');
    expect(slugs).toContain('huntress');
    expect(slugs).toContain('blumira');
    expect(slugs).toContain('m365');
  });

  it('returns undefined for unknown vendor', () => {
    expect(getVendor('nonexistent')).toBeUndefined();
  });

  it('returns vendor config for known slug', () => {
    const vendor = getVendor('datto-rmm');
    expect(vendor).toBeDefined();
    expect(vendor!.name).toBe('Datto RMM');
    expect(vendor!.fields).toHaveLength(3);
    expect(vendor!.headerMapping).toHaveProperty('apiKey', 'X-Datto-API-Key');
  });

  it('overrides containerUrl via VENDOR_URL_ env var', () => {
    vi.stubEnv('VENDOR_URL_DATTO_RMM', 'http://custom:9999');

    const vendor = getVendor('datto-rmm');
    expect(vendor!.containerUrl).toBe('http://custom:9999');
  });

  it('uses default containerUrl when env var is not set', () => {
    const vendor = getVendor('datto-rmm');
    expect(vendor!.containerUrl).toBe('http://datto-rmm-mcp');
  });

  it('every vendor has a header mapping or buildHeaders for each required field', () => {
    for (const [slug, vendor] of Object.entries(VENDORS)) {
      if (vendor.buildHeaders) {
        // Vendors with buildHeaders handle their own header construction
        expect(typeof vendor.buildHeaders).toBe('function');
        continue;
      }
      for (const field of vendor.fields) {
        if (field.required) {
          expect(
            vendor.headerMapping[field.key],
            `${slug}: missing headerMapping for required field "${field.key}"`,
          ).toBeDefined();
        }
      }
    }
  });

  it('every vendor has a valid category', () => {
    const validCategories = new Set(VENDOR_CATEGORIES.map((c) => c.slug));
    for (const [slug, vendor] of Object.entries(VENDORS)) {
      expect(
        validCategories.has(vendor.category),
        `${slug}: invalid category "${vendor.category}"`,
      ).toBe(true);
    }
  });

  it('getVendorsByCategory returns all vendors grouped correctly', () => {
    const grouped = getVendorsByCategory();
    const allGroupedSlugs = grouped.flatMap((cat) => cat.vendors.map((v) => v.slug));
    const allVendorSlugs = Object.keys(VENDORS);
    expect(allGroupedSlugs.sort()).toEqual(allVendorSlugs.sort());
  });

  it('every vendor has a docsUrl', () => {
    for (const [slug, vendor] of Object.entries(VENDORS)) {
      expect(vendor.docsUrl, `${slug}: missing docsUrl`).toBeTruthy();
      expect(
        () => new URL(vendor.docsUrl),
        `${slug}: invalid docsUrl`,
      ).not.toThrow();
    }
  });

  describe('microsoft-graph vendor', () => {
    it('is registered as a preview hosted vendor', () => {
      const vendor = getVendor('microsoft-graph');
      expect(vendor).toBeDefined();
      expect(vendor!.preview).toBe(true);
      // Conduit's VendorConfig has no `isStateful` field (the gateway's
      // stateless-server finding is irrelevant to Conduit's type).
      expect(vendor!.containerUrl).toBe('https://mcp.svc.cloud.microsoft');
      expect(vendor!.mcpPath).toBe('/enterprise');
      expect(vendor!.oauthConfig).toBeDefined();
    });

    it('validate() rejects an empty access token', async () => {
      const vendor = getVendor('microsoft-graph')!;
      const result = await vendor.validate!({});
      expect(result.valid).toBe(false);
    });
  });

  it('preview, when set, is a boolean', () => {
    for (const [slug, vendor] of Object.entries(VENDORS)) {
      if (vendor.preview !== undefined) {
        expect(typeof vendor.preview, `${slug}: preview must be boolean`).toBe('boolean');
      }
    }
  });

  describe('azure-mcp vendor', () => {
    it('is registered as a sidecar vendor with three credential fields', () => {
      const vendor = getVendor('azure-mcp');
      expect(vendor).toBeDefined();
      expect(vendor!.containerUrl).toBe('http://azure-mcp');
      const fieldKeys = vendor!.fields.map((f) => f.key).sort();
      expect(fieldKeys).toEqual(['clientId', 'clientSecret', 'tenantId']);
      const secret = vendor!.fields.find((f) => f.key === 'clientSecret');
      expect(secret!.secret).toBe(true);
    });

    it('validate() rejects all-empty credentials', async () => {
      const vendor = getVendor('azure-mcp')!;
      const result = await vendor.validate!({});
      expect(result.valid).toBe(false);
    });
  });

  // #73 — connectwise-automate and hudu validate() fetch a base URL the user
  // typed into the credentials form. Without rejectIfUnsafeBaseUrl they are
  // an SSRF primitive: an authenticated user can probe 169.254.169.254 (cloud
  // IMDS), loopback, RFC1918 hosts. These two were the connectors PR #73
  // named that conduit had not yet wired the guard into.
  describe('SSRF guard on validate() — #73', () => {
    // An IP literal, so validateVendorBaseUrl rejects it synchronously on the
    // non-public-IP check — no DNS, no network, deterministic.
    const IMDS = 'https://169.254.169.254';

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // fetch is spied AND mocked-rejecting: with the guard in place fetch is
    // never reached; if the guard is reverted, fetch IS called — the spy
    // records it and the `not.toHaveBeenCalled()` assertion goes red. The
    // mock keeps the reverted-code path from doing real network I/O.
    it('connectwise-automate rejects a non-public server URL before fetch', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network disabled in test'));
      const vendor = getVendor('connectwise-automate')!;
      const result = await vendor.validate!({
        serverUrl: IMDS,
        clientId: 'c',
        username: 'u',
        password: 'p',
      });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('rejected');
      // The guard must short-circuit — the SSRF fetch never happens.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('hudu rejects a non-public base URL before fetch', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network disabled in test'));
      const vendor = getVendor('hudu')!;
      const result = await vendor.validate!({ baseUrl: IMDS, apiKey: 'k' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('rejected');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // WYREAI-164 — alternative-payments wire-in (LAUNCH-CRITICAL).
  // 1:1 mirror of gateway-side entry with warden discipline (sibling
  // lesson from #402): client-side dropdown is render-substrate;
  // validate() allowlists creds.environment before host selection so a
  // future refactor that switches the ternary to URL interpolation
  // inherits SSRF protection by-construction.
  describe('alternative-payments wire-in', () => {
    it('registers alternative-payments in the accounting category', () => {
      expect(getVendorSlugs()).toContain('alternative-payments');
      const v = getVendor('alternative-payments')!;
      expect(v.name).toBe('Alternative Payments');
      expect(v.category).toBe('accounting');
      expect(v.containerUrl).toBe('http://alternative-payments-mcp:8080');
      expect(v.headerMapping).toEqual({
        clientId: 'X-Alternative-Payments-Client-Id',
        clientSecret: 'X-Alternative-Payments-Client-Secret',
        environment: 'X-Alternative-Payments-Environment',
      });
    });

    it('environment field options[] are exactly [production, demo] (no extra slop)', () => {
      const v = getVendor('alternative-payments')!;
      const envField = v.fields.find((f) => f.key === 'environment');
      expect(envField).toBeDefined();
      expect(envField!.required).toBe(false);
      expect(envField!.options).toEqual(['production', 'demo']);
    });

    it('clientId + clientSecret are both required + secret-flagged', () => {
      const v = getVendor('alternative-payments')!;
      expect(v.fields.find((f) => f.key === 'clientId')).toMatchObject({
        required: true, secret: true,
      });
      expect(v.fields.find((f) => f.key === 'clientSecret')).toMatchObject({
        required: true, secret: true,
      });
    });

    it('validate() production happy-path: Basic auth + client-credentials grant', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"access_token":"tok"}', { status: 200 }));
      const v = getVendor('alternative-payments')!;
      const result = await v.validate!({
        clientId: 'cid_abc', clientSecret: 'sek_xyz', environment: 'production',
      });
      expect(result).toEqual({ valid: true });
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://public-api.alternativepayments.io/oauth/token');
      expect((init as RequestInit).method).toBe('POST');
      const headers = (init as RequestInit).headers as Record<string, string>;
      const expectedAuth = `Basic ${Buffer.from('cid_abc:sek_xyz').toString('base64')}`;
      expect(headers.Authorization).toBe(expectedAuth);
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect((init as RequestInit).body).toBe('grant_type=client_credentials');
    });

    it('validate() demo environment routes to demo base URL', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('alternative-payments')!;
      await v.validate!({
        clientId: 'c', clientSecret: 's', environment: 'demo',
      });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://public-api.demo.alternativepayments.io/oauth/token');
    });

    it('validate() defaults to production when environment omitted', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('alternative-payments')!;
      await v.validate!({ clientId: 'c', clientSecret: 's' });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://public-api.alternativepayments.io/oauth/token');
    });

    it('validate() 401 -> invalid-creds error (no upstream body leak)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('upstream-body-with-PII', { status: 401 }),
      );
      const v = getVendor('alternative-payments')!;
      const result = await v.validate!({ clientId: 'c', clientSecret: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toBe(
        'Invalid Alternative Payments client credentials.',
      );
      expect(result.valid === false && result.error).not.toContain('upstream-body');
    });

    it('validate() non-401 -> raw HTTP status surfaced', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('upstream down', { status: 503 }),
      );
      const v = getVendor('alternative-payments')!;
      const result = await v.validate!({ clientId: 'c', clientSecret: 's' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('HTTP 503');
    });

    // SSRF allowlist-fallback (warden discipline pre-applied — sibling
    // lesson from #402). The current ternary is already SSRF-safe by
    // equality-compare, but the allowlist gate fires FIRST and forces a
    // sanitised environment value into the ternary so any future refactor
    // to URL interpolation inherits the protection by-construction.
    //
    // 5 rows (one less than auvik's 6 — path-injection is not applicable
    // to equality-compare). Each row pins (1) fetch URL is exactly the
    // production base, (2) the malicious value never appears in URL.
    it.each([
      ['fragment injection', 'demo#evil'],
      ['unknown environment', 'staging'],
      ['empty string', ''],
      ['whitespace-padded demo', 'demo '],
      ['casing mismatch (case-sensitive allowlist)', 'DEMO'],
    ])('validate() SSRF guard: rejects %s and falls back to production', async (_label, badEnv) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('alternative-payments')!;
      await v.validate!({ clientId: 'c', clientSecret: 's', environment: badEnv });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://public-api.alternativepayments.io/oauth/token');
      if (badEnv !== '') {
        expect(String(url)).not.toContain(badEnv);
      }
    });
  });
});
