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

  // WYREAI-165 — 10 DigitalOcean MCP slugs are emitted from one factory
  // (DIGITAL_OCEAN_MCP_SLUGS tuple list). These checks pin the by-construction
  // shape so a future refactor cannot silently drop a slug, flip the auth
  // header, or skew a subdomain mapping.
  describe('digitalocean MCP slugs', () => {
    const DO_EXPECTED: Array<[string, string, string]> = [
      ['digitalocean-apps', 'DigitalOcean Apps', 'apps'],
      ['digitalocean-databases', 'DigitalOcean Databases', 'databases'],
      ['digitalocean-docs', 'DigitalOcean Docs', 'docs'],
      ['digitalocean-doks', 'DigitalOcean Kubernetes (DOKS)', 'doks'],
      ['digitalocean-droplets', 'DigitalOcean Droplets', 'droplets'],
      ['digitalocean-functions', 'DigitalOcean Functions', 'functions'],
      ['digitalocean-gradient-ai', 'DigitalOcean Gradient AI', 'gradient-ai'],
      ['digitalocean-inference', 'DigitalOcean Inference Model Catalog', 'inference-modelcatalog'],
      ['digitalocean-networking', 'DigitalOcean Networking', 'networking'],
      ['digitalocean-spaces', 'DigitalOcean Spaces', 'spaces'],
    ];

    it('registers all 10 DO slugs in the infrastructure category', () => {
      const slugs = getVendorSlugs();
      for (const [slug] of DO_EXPECTED) {
        expect(slugs, `missing ${slug}`).toContain(slug);
        expect(getVendor(slug)!.category).toBe('infrastructure');
      }
    });

    it.each(DO_EXPECTED)('%s: name=%s, containerUrl=https://%s.mcp.digitalocean.com', (slug, name, subdomain) => {
      const v = getVendor(slug)!;
      expect(v.name).toBe(name);
      expect(v.containerUrl).toBe(`https://${subdomain}.mcp.digitalocean.com`);
      expect(v.docsUrl).toBe('https://docs.digitalocean.com/reference/mcp/configure-mcp/');
      expect(v.fields).toHaveLength(1);
      expect(v.fields[0]).toMatchObject({ key: 'apiToken', required: true, secret: true });
      expect(v.buildHeaders!({ apiToken: 'pat_abc' })).toEqual({
        Authorization: 'Bearer pat_abc',
      });
    });

    it('droplets validate() maps 401 to invalid-PAT error (no leak of upstream body)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('missing or invalid bearer token', { status: 401 }),
      );
      const v = getVendor('digitalocean-droplets')!;
      const result = await v.validate!({ apiToken: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('Invalid DigitalOcean Personal Access Token');
      expect(result.valid === false && result.error).toContain('DigitalOcean Droplets');
    });

    it('docs validate() maps 401 to invalid-PAT error (uniform shape, not a no-auth special case)', async () => {
      // Ground-check 2026-06-15: the docs subdomain also enforces Bearer-PAT
      // per RFC 9728 oauth-protected-resource. This locks the uniform shape
      // so future code cannot regress to skipping auth on docs.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('missing or invalid bearer token', { status: 401 }),
      );
      const v = getVendor('digitalocean-docs')!;
      const result = await v.validate!({ apiToken: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('Invalid DigitalOcean Personal Access Token');
      expect(result.valid === false && result.error).toContain('DigitalOcean Docs');
    });

    it('non-401 HTTP errors surface the raw status (gradient-ai 503)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('upstream down', { status: 503 }),
      );
      const v = getVendor('digitalocean-gradient-ai')!;
      const result = await v.validate!({ apiToken: 'p' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('HTTP 503');
      expect(result.valid === false && result.error).toContain('Gradient AI');
    });

    it('validate() targets <subdomain>.mcp.digitalocean.com/mcp with Authorization: Bearer header', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 }));
      const v = getVendor('digitalocean-spaces')!;
      const result = await v.validate!({ apiToken: 'pat_xyz' });
      expect(result).toEqual({ valid: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://spaces.mcp.digitalocean.com/mcp');
      expect((init as RequestInit).method).toBe('POST');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer pat_xyz');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Accept).toContain('text/event-stream');
    });
  });

  // WYREAI-151 — auvik wire-in. Mirrors the gateway-side entry (gateway PR
  // #258 added us5 to the region options); these checks pin the load-bearing
  // axes so a future region-add or auth-flip can't silently regress us5
  // routing or leak upstream body on 401.
  describe('auvik wire-in', () => {
    it('registers auvik in the network category', () => {
      expect(getVendorSlugs()).toContain('auvik');
      const v = getVendor('auvik')!;
      expect(v.name).toBe('Auvik');
      expect(v.category).toBe('network');
      expect(v.containerUrl).toBe('http://auvik-mcp');
      expect(v.headerMapping).toEqual({
        username: 'x-auvik-username',
        apiKey: 'x-auvik-api-key',
        region: 'x-auvik-region',
      });
    });

    it('region field includes us5 (gateway #258), lnx (PR #405), and us6 (gateway #260 / this PR fold-in)', () => {
      const v = getVendor('auvik')!;
      const regionField = v.fields.find((f) => f.key === 'region');
      expect(regionField).toBeDefined();
      expect(regionField!.required).toBe(false);
      expect(regionField!.options).toEqual([
        'us1', 'us2', 'us3', 'us4', 'us5', 'us6', 'eu1', 'eu2', 'au1', 'ca1', 'lnx',
      ]);
    });

    // Allowlist EXPANSION witness — NOT the SSRF-fallback test. Pins
    // that `region: 'lnx'` reaches its real cluster (auvikapi.lnx.my
    // .auvik.com) instead of falling back to us1. If a future refactor
    // accidentally drops lnx from the allowlist, this test fails fast
    // — distinct from the SSRF-guard rows which witness the opposite
    // direction (rejected inputs MUST fall back to us1).
    it('lnx allowlist-expansion witness: validate() targets auvikapi.lnx.my.auvik.com (not us1 fallback)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('auvik')!;
      const result = await v.validate!({
        username: 'op@msp.example', apiKey: 'k_lnx', region: 'lnx',
      });
      expect(result).toEqual({ valid: true });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://auvikapi.lnx.my.auvik.com/v1/authentication/verify');
      // Explicit negative: the lnx-bound request did NOT fall back to us1.
      expect(String(url)).not.toContain('us1');
    });

    // Sibling expansion witness for us6 — same shape as lnx, second
    // N=2 occurrence of the drift-recovery pattern. Confirms ruby's
    // set-boundary-via-external-source-citation discipline is now
    // operationally-load-bearing across multiple events at this
    // substrate, not just at codegen-time assertion.
    it('us6 allowlist-expansion witness: validate() targets auvikapi.us6.my.auvik.com (not us1 fallback)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('auvik')!;
      const result = await v.validate!({
        username: 'op@msp.example', apiKey: 'k_us6', region: 'us6',
      });
      expect(result).toEqual({ valid: true });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://auvikapi.us6.my.auvik.com/v1/authentication/verify');
      // Explicit negative: the us6-bound request did NOT fall back to us1.
      // Equality against `us1` substring is intentional — if the allowlist
      // drops us6, the fallback writes `us1` into the URL and this check
      // catches it.
      expect(String(url)).not.toContain('us1');
    });

    it('validate() targets the region-aware URL with Basic auth (us5 witness)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('auvik')!;
      const result = await v.validate!({ username: 'op@msp.example', apiKey: 'k_us5', region: 'us5' });
      expect(result).toEqual({ valid: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://auvikapi.us5.my.auvik.com/v1/authentication/verify');
      const headers = (init as RequestInit).headers as Record<string, string>;
      // Basic header is the SHA of (username:apiKey) base64-encoded — pin the
      // exact prefix so a future flip to Bearer-PAT can't slide in silently.
      const expectedAuth = `Basic ${Buffer.from('op@msp.example:k_us5').toString('base64')}`;
      expect(headers.Authorization).toBe(expectedAuth);
      expect(headers.Accept).toBe('application/json');
    });

    it('validate() defaults to us1 when region is omitted', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('auvik')!;
      const result = await v.validate!({ username: 'op@msp.example', apiKey: 'k' });
      expect(result).toEqual({ valid: true });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://auvikapi.us1.my.auvik.com/v1/authentication/verify');
    });

    it('validate() honors a non-us region (eu1 witness — the URL substrate is fully parameterized)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('auvik')!;
      await v.validate!({ username: 'op@msp.example', apiKey: 'k', region: 'eu1' });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://auvikapi.eu1.my.auvik.com/v1/authentication/verify');
    });

    it('validate() 401 -> invalid creds error (no upstream body leak)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('upstream-body-with-PII', { status: 401 }),
      );
      const v = getVendor('auvik')!;
      const result = await v.validate!({ username: 'op@msp.example', apiKey: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toBe('Invalid Auvik username or API key.');
      // Witness: error does NOT contain the upstream body fragment.
      expect(result.valid === false && result.error).not.toContain('upstream-body');
    });

    it('validate() non-401 -> raw HTTP status with region-selection hint', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('region misroute', { status: 404 }),
      );
      const v = getVendor('auvik')!;
      const result = await v.validate!({ username: 'op@msp.example', apiKey: 'k', region: 'us3' });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error).toContain('HTTP 404');
      expect(result.valid === false && result.error).toContain('region selection');
    });

    // SSRF regression-guard (warden HARD-REQ msg-1781546697098):
    // client-side dropdown CANNOT be trusted; validate() must allowlist
    // before URL interpolation. A crafted region like "evil.com#" would
    // otherwise hit https://auvikapi.evil.com#.my.auvik.com -> fragment
    // strip -> fetch auvikapi.evil.com with the Basic-auth header.
    // Allowlist-then-interpolate closes by-construction: any unknown
    // region falls back to us1 and the attacker domain is never reached.
    it.each([
      ['fragment injection', 'evil.com#'],
      ['path injection', 'us1/../evil'],
      ['double-dot subdomain', 'evil.com.'],
      ['empty string', ''],
      ['unknown region', 'mars1'],
      ['us1 with whitespace', 'us1 '],
    ])('validate() SSRF guard: rejects %s and falls back to us1 (no fetch to attacker domain)', async (_label, badRegion) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const v = getVendor('auvik')!;
      await v.validate!({ username: 'op@msp.example', apiKey: 'k', region: badRegion });
      const [url] = fetchSpy.mock.calls[0]!;
      // The ONLY accepted destination after fallback is the us1 cluster.
      expect(url).toBe('https://auvikapi.us1.my.auvik.com/v1/authentication/verify');
      // Negative-assertion: the attacker fragment never reached fetch().
      // Skipped for the empty-string row — `not.toContain('')` is vacuously
      // false; the URL equality above already pins that branch.
      if (badRegion !== '') {
        expect(String(url)).not.toContain(badRegion);
      }
    });
  });
});
