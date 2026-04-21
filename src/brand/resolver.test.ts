// =============================================================================
// src/brand/resolver.test.ts
//
// Unit tests for BrandResolver (PRD §5 inheritance walk, §12 cache).
// DB is mocked with a tagged-template fake (same pattern as
// src/credentials/credential-service.test.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

import {
  BrandResolver,
  BrandResolverError,
  WYRE_DEFAULT_BRAND_ID,
} from './resolver.js';

// -----------------------------------------------------------------------------
// Fake DB
// -----------------------------------------------------------------------------

interface FakeBrandRow {
  id: string;
  org_id: string | null;
  parent_brand_id: string | null;
  tier: 'wyre_default' | 'reseller' | 'customer';
  is_wyre_default: boolean;
  name: string;
  tagline: string | null;
  from_email_display_name: string | null;
  support_url: string | null;
  support_email: string | null;
  docs_url: string | null;
  issues_url: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  text_primary: string | null;
  text_secondary: string | null;
  bg_primary: string | null;
  bg_secondary: string | null;
  border_color: string | null;
  heading_font: string | null;
  body_font: string | null;
  border_radius: number | null;
  allow_customer_overrides: boolean;
  version: number;
}

interface FakeOrgRow {
  id: string;
  parent_org_id: string | null;
}

function makeBrand(overrides: Partial<FakeBrandRow> & { id: string; name: string }): FakeBrandRow {
  return {
    org_id: null,
    parent_brand_id: null,
    tier: 'customer',
    is_wyre_default: false,
    tagline: null,
    from_email_display_name: null,
    support_url: null,
    support_email: null,
    docs_url: null,
    issues_url: null,
    logo_url: null,
    logo_dark_url: null,
    primary_color: null,
    accent_color: null,
    text_primary: null,
    text_secondary: null,
    bg_primary: null,
    bg_secondary: null,
    border_color: null,
    heading_font: null,
    body_font: null,
    border_radius: null,
    allow_customer_overrides: false,
    version: 1,
    ...overrides,
  };
}

interface FakeDb {
  brands: FakeBrandRow[];
  orgs: FakeOrgRow[];
  /** Query-call counter; tests assert cache hits by its delta. */
  callCount: number;
  sql: postgres.Sql;
}

function createFakeDb(opts?: {
  includeWyreDefault?: boolean;
  brands?: FakeBrandRow[];
  orgs?: FakeOrgRow[];
}): FakeDb {
  const includeWyreDefault = opts?.includeWyreDefault ?? true;
  const brands: FakeBrandRow[] = [...(opts?.brands ?? [])];
  if (includeWyreDefault) {
    brands.push(
      makeBrand({
        id: WYRE_DEFAULT_BRAND_ID,
        name: 'Wyre',
        tagline: 'MCP Gateway by Wyre',
        tier: 'wyre_default',
        is_wyre_default: true,
        support_url: 'https://wyre.io/support',
        docs_url: 'https://docs.wyre.io',
        primary_color: '#0A84FF',
        accent_color: '#30D158',
        heading_font: 'Inter',
        body_font: 'Inter',
        border_radius: 8,
      }),
    );
  }
  const orgs: FakeOrgRow[] = [...(opts?.orgs ?? [])];

  const state = { callCount: 0 };

  // Tagged-template fake — same shape as postgres.js sql``.
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.callCount += 1;
    const query = strings.join('?');

    if (query.includes('FROM brand_profiles') && query.includes('is_wyre_default')) {
      const row = brands.find((b) => b.is_wyre_default);
      return Promise.resolve(row ? [row] : []);
    }

    if (query.includes('FROM brand_profiles') && query.includes('org_id =')) {
      const orgId = values[0] as string;
      const row = brands.find((b) => b.org_id === orgId);
      return Promise.resolve(row ? [row] : []);
    }

    if (query.includes('FROM organizations') && query.includes('id =')) {
      const orgId = values[0] as string;
      const row = orgs.find((o) => o.id === orgId);
      return Promise.resolve(row ? [{ parent_org_id: row.parent_org_id }] : []);
    }

    return Promise.resolve([]);
  };

  const sql = tag as unknown as postgres.Sql;
  return {
    brands,
    orgs,
    get callCount() {
      return state.callCount;
    },
    set callCount(v: number) {
      state.callCount = v;
    },
    sql,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('BrandResolver', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns org own brand when present (no parent walk)', async () => {
    const db = createFakeDb({
      brands: [
        makeBrand({
          id: 'brand-customer',
          org_id: 'org-customer',
          tier: 'customer',
          name: 'CustomerCo',
          parent_brand_id: 'brand-reseller',
        }),
        makeBrand({
          id: 'brand-reseller',
          org_id: 'org-reseller',
          tier: 'reseller',
          name: 'ResellerCo',
        }),
      ],
      orgs: [
        { id: 'org-customer', parent_org_id: 'org-reseller' },
        { id: 'org-reseller', parent_org_id: null },
      ],
    });
    const resolver = new BrandResolver(db.sql);

    const brand = await resolver.resolveBrand('org-customer');

    expect(brand.name).toBe('CustomerCo');
    expect(brand.id).toBe('brand-customer');
    // Exactly one DB call: the direct brand hit. No parent walk.
    expect(db.callCount).toBe(1);
  });

  it("walks to parent's brand when org has no own brand", async () => {
    const db = createFakeDb({
      brands: [
        makeBrand({
          id: 'brand-reseller',
          org_id: 'org-reseller',
          tier: 'reseller',
          name: 'ResellerCo',
        }),
      ],
      orgs: [
        { id: 'org-customer', parent_org_id: 'org-reseller' },
        { id: 'org-reseller', parent_org_id: null },
      ],
    });
    const resolver = new BrandResolver(db.sql);

    const brand = await resolver.resolveBrand('org-customer');

    expect(brand.name).toBe('ResellerCo');
    expect(brand.id).toBe('brand-reseller');
    expect(brand.orgId).toBe('org-reseller');
  });

  it('returns wyre-default for a standalone org with no brand and no parent', async () => {
    const db = createFakeDb({
      orgs: [{ id: 'org-standalone', parent_org_id: null }],
    });
    const resolver = new BrandResolver(db.sql);

    const brand = await resolver.resolveBrand('org-standalone');

    expect(brand.id).toBe(WYRE_DEFAULT_BRAND_ID);
    expect(brand.isWyreDefault).toBe(true);
    expect(brand.name).toBe('Wyre');
  });

  it('returns wyre-default when orgId is null', async () => {
    const db = createFakeDb();
    const resolver = new BrandResolver(db.sql);

    const brand = await resolver.resolveBrand(null);

    expect(brand.id).toBe(WYRE_DEFAULT_BRAND_ID);
    expect(brand.isWyreDefault).toBe(true);
  });

  it('throws MAX_DEPTH_EXCEEDED when the parent chain cycles/exceeds 10', async () => {
    // Build a 12-deep chain: org-0 -> org-1 -> ... -> org-11, none branded.
    const orgs: FakeOrgRow[] = [];
    for (let i = 0; i < 12; i++) {
      orgs.push({
        id: `org-${i}`,
        parent_org_id: i < 11 ? `org-${i + 1}` : null,
      });
    }
    const db = createFakeDb({ orgs });
    const resolver = new BrandResolver(db.sql);

    await expect(resolver.resolveBrand('org-0')).rejects.toMatchObject({
      name: 'BrandResolverError',
      code: 'MAX_DEPTH_EXCEEDED',
    });
  });

  it('throws FALLBACK_MISSING when the wyre-default row is absent', async () => {
    const db = createFakeDb({
      includeWyreDefault: false,
      orgs: [{ id: 'org-standalone', parent_org_id: null }],
    });
    const resolver = new BrandResolver(db.sql);

    await expect(resolver.resolveBrand('org-standalone')).rejects.toBeInstanceOf(
      BrandResolverError,
    );
    await expect(resolver.resolveBrand(null)).rejects.toMatchObject({
      code: 'FALLBACK_MISSING',
    });
  });

  it('cache hit returns same value without a DB query', async () => {
    const db = createFakeDb({
      brands: [
        makeBrand({
          id: 'brand-x',
          org_id: 'org-x',
          tier: 'customer',
          name: 'X',
        }),
      ],
      orgs: [{ id: 'org-x', parent_org_id: null }],
    });
    const resolver = new BrandResolver(db.sql, 60);

    const first = await resolver.resolveBrand('org-x');
    const callsAfterFirst = db.callCount;
    const second = await resolver.resolveBrand('org-x');

    expect(second).toBe(first); // reference-equal — served from cache
    expect(db.callCount).toBe(callsAfterFirst); // no new DB calls
  });

  it('cache TTL expiry causes a re-query', async () => {
    const db = createFakeDb({
      brands: [
        makeBrand({
          id: 'brand-y',
          org_id: 'org-y',
          tier: 'customer',
          name: 'Y',
        }),
      ],
      orgs: [{ id: 'org-y', parent_org_id: null }],
    });
    // 1-second TTL to keep the test fast.
    const resolver = new BrandResolver(db.sql, 1);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await resolver.resolveBrand('org-y');
    const callsAfterFirst = db.callCount;

    // Second call within TTL window — no DB.
    await resolver.resolveBrand('org-y');
    expect(db.callCount).toBe(callsAfterFirst);

    // Advance past TTL.
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    await resolver.resolveBrand('org-y');
    expect(db.callCount).toBeGreaterThan(callsAfterFirst);

    vi.useRealTimers();
  });
});
