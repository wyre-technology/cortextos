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
});
