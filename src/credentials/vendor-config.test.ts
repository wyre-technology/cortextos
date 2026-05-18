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
    expect(vendor!.containerUrl).toBe('http://datto-rmm-mcp:8080');
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
});
