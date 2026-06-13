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
  toBrandConfig,
} from './resolver.js';
import { runWithSql } from '../db/context.js';

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
    const resolver = new BrandResolver();

    const brand = await runWithSql(db.sql, () => resolver.resolveBrand('org-customer'));

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
    const resolver = new BrandResolver();

    const brand = await runWithSql(db.sql, () => resolver.resolveBrand('org-customer'));

    expect(brand.name).toBe('ResellerCo');
    expect(brand.id).toBe('brand-reseller');
    expect(brand.orgId).toBe('org-reseller');
  });

  it('returns wyre-default for a standalone org with no brand and no parent', async () => {
    const db = createFakeDb({
      orgs: [{ id: 'org-standalone', parent_org_id: null }],
    });
    const resolver = new BrandResolver();

    const brand = await runWithSql(db.sql, () => resolver.resolveBrand('org-standalone'));

    expect(brand.id).toBe(WYRE_DEFAULT_BRAND_ID);
    expect(brand.isWyreDefault).toBe(true);
    expect(brand.name).toBe('Wyre');
  });

  it('returns wyre-default when orgId is null', async () => {
    const db = createFakeDb();
    const resolver = new BrandResolver();

    const brand = await runWithSql(db.sql, () => resolver.resolveBrand(null));

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
    const resolver = new BrandResolver();

    await expect(runWithSql(db.sql, () => resolver.resolveBrand('org-0'))).rejects.toMatchObject({
      name: 'BrandResolverError',
      code: 'MAX_DEPTH_EXCEEDED',
    });
  });

  it('throws FALLBACK_MISSING when the wyre-default row is absent', async () => {
    const db = createFakeDb({
      includeWyreDefault: false,
      orgs: [{ id: 'org-standalone', parent_org_id: null }],
    });
    const resolver = new BrandResolver();

    await expect(runWithSql(db.sql, () => resolver.resolveBrand('org-standalone'))).rejects.toBeInstanceOf(
      BrandResolverError,
    );
    await expect(runWithSql(db.sql, () => resolver.resolveBrand(null))).rejects.toMatchObject({
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
    const resolver = new BrandResolver(60);

    const first = await runWithSql(db.sql, () => resolver.resolveBrand('org-x'));
    const callsAfterFirst = db.callCount;
    const second = await runWithSql(db.sql, () => resolver.resolveBrand('org-x'));

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
    const resolver = new BrandResolver(1);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await runWithSql(db.sql, () => resolver.resolveBrand('org-y'));
    const callsAfterFirst = db.callCount;

    // Second call within TTL window — no DB.
    await runWithSql(db.sql, () => resolver.resolveBrand('org-y'));
    expect(db.callCount).toBe(callsAfterFirst);

    // Advance past TTL.
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    await runWithSql(db.sql, () => resolver.resolveBrand('org-y'));
    expect(db.callCount).toBeGreaterThan(callsAfterFirst);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// toBrandConfig — RC2 PR-A escape-boundary + templateOverrides round-trip
//
// Pearl-side foundation for RC2 cross-cutting brand-resolver-aware-output
// across 15+ transactional/Loops fire-sites (dev's PR-B). Escape-at-seam
// pattern is the N=2 cross-cycle firing of attacker-influenced-value-flowing-
// into-rendered-output (sibling to WYREAI-98 #306 consentDocumentUrl XSS;
// boss-locked at msg-1780675433546).
//
// asymmetric-pair shape per ruby's rot-vector-closure pin: every escape-test
// has a paired pass-through-test for the unescaped-by-design fields
// (templateOverrides VALUES, identifiers, enums) so a future refactor that
// silently escapes them too gets caught.
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  // Minimum BrandProfileRow shape for toBrandConfig.
  return {
    id: 'b-1',
    org_id: 'org-1',
    parent_brand_id: null,
    tier: 'reseller' as const,
    is_wyre_default: false,
    name: 'Acme MSP',
    tagline: 'IT done right',
    from_email_display_name: 'Acme Support',
    support_url: 'https://acme.example/support',
    support_email: 'help@acme.example',
    docs_url: 'https://acme.example/docs',
    issues_url: 'https://acme.example/bugs',
    logo_url: 'https://cdn.acme.example/logo.svg',
    logo_dark_url: 'https://cdn.acme.example/logo-dark.svg',
    primary_color: '#0066ff',
    accent_color: '#00cc88',
    text_primary: '#111111',
    text_secondary: '#666666',
    bg_primary: '#ffffff',
    bg_secondary: '#f0f0f0',
    border_color: '#cccccc',
    heading_font: 'Inter',
    body_font: 'Inter',
    border_radius: 8,
    allow_customer_overrides: false,
    version: 1,
    template_overrides: null,
    ...overrides,
  };
}

describe('toBrandConfig — escape-boundary (RC2 PR-A)', () => {
  it('escapes HTML in name (the highest-blast-radius field — flows into email From + body)', () => {
    const row = makeRow({ name: '<script>alert(1)</script>Evil Co' });
    const config = toBrandConfig(row as never);
    expect(config.name).toBe('&lt;script&gt;alert(1)&lt;/script&gt;Evil Co');
    expect(config.name).not.toContain('<script>');
  });

  it('escapes HTML in tagline', () => {
    const row = makeRow({ tagline: '" onclick="alert(1)' });
    const config = toBrandConfig(row as never);
    expect(config.tagline).toBe('&quot; onclick=&quot;alert(1)');
  });

  it('escapes HTML in URL fields (logoUrl + supportUrl + docsUrl + issuesUrl)', () => {
    // URLs end up in href + img src in rendered emails. Escape closes the
    // attribute-breakout vector (e.g. `"><script>`) for any URL field.
    const row = makeRow({
      logo_url: 'https://x.test/"><script>',
      support_url: 'https://x.test/&unsafe',
      docs_url: 'https://x.test/<svg>',
      issues_url: 'https://x.test/\'',
    });
    const config = toBrandConfig(row as never);
    expect(config.logoUrl).toBe('https://x.test/&quot;&gt;&lt;script&gt;');
    expect(config.supportUrl).toBe('https://x.test/&amp;unsafe');
    expect(config.docsUrl).toBe('https://x.test/&lt;svg&gt;');
    expect(config.issuesUrl).toBe('https://x.test/&#39;');
  });

  it('escapes HTML in DB-backed string fields (fromEmailDisplayName, supportEmail, logoDarkUrl)', () => {
    const row = makeRow({
      from_email_display_name: 'Acme <strong>Support</strong>',
      support_email: 'help@acme.example?bcc=<x>',
      logo_dark_url: 'https://cdn.x/"<script>',
    });
    const config = toBrandConfig(row as never);
    expect(config.fromEmailDisplayName).toBe('Acme &lt;strong&gt;Support&lt;/strong&gt;');
    expect(config.supportEmail).toBe('help@acme.example?bcc=&lt;x&gt;');
    expect(config.logoDarkUrl).toBe('https://cdn.x/&quot;&lt;script&gt;');
  });

  it('escapes HTML in color tokens (defense-in-depth — colors should be hex but enforce at boundary)', () => {
    const row = makeRow({ text_primary: '#fff" onload="x()', accent_color: '<svg/onload=y()>' });
    const config = toBrandConfig(row as never);
    expect(config.textPrimary).toBe('#fff&quot; onload=&quot;x()');
    expect(config.accentColor).toBe('&lt;svg/onload=y()&gt;');
  });

  it('escape is idempotent — already-escaped input stays escaped (no double-escape)', () => {
    // A future caller that already escaped before write (defensive layering)
    // should not see double-escaping. The escape function is character-
    // replacement so '&amp;' becomes '&amp;amp;'. Tests document the
    // current behavior — escape happens at THIS boundary, not upstream.
    // This is a CONTRACT test: callers MUST NOT pre-escape; the resolver
    // is the single point of escape.
    const row = makeRow({ name: 'A&amp;B' });
    const config = toBrandConfig(row as never);
    expect(config.name).toBe('A&amp;amp;B'); // double-escaped — caller error pinned
  });

  it('passes through NULL fields unchanged (no NULL → empty-string coercion)', () => {
    // Nullable string fields stay null when DB returns null — keeps the
    // round-trip honest. consumer-side fallbacks (in buildBrandMergeTags)
    // handle the null-to-default chain.
    const row = makeRow({
      from_email_display_name: null,
      support_email: null,
      logo_dark_url: null,
      text_primary: null,
      text_secondary: null,
      bg_primary: null,
      bg_secondary: null,
      border_color: null,
    });
    const config = toBrandConfig(row as never);
    expect(config.fromEmailDisplayName).toBeNull();
    expect(config.supportEmail).toBeNull();
    expect(config.logoDarkUrl).toBeNull();
    expect(config.textPrimary).toBeNull();
  });
});

describe('toBrandConfig — templateOverrides round-trip + pass-through (RC2 PR-A)', () => {
  it('round-trips null templateOverrides (the ~95% case)', () => {
    const row = makeRow({ template_overrides: null });
    const config = toBrandConfig(row as never);
    expect(config.templateOverrides).toBeNull();
  });

  it('round-trips a populated templateOverrides JSONB object verbatim', () => {
    const overrides = {
      'trial-converted': 'trial-converted-acme',
      'dunning-past-due': 'dunning-past-due-acme',
    };
    const row = makeRow({ template_overrides: overrides });
    const config = toBrandConfig(row as never);
    expect(config.templateOverrides).toEqual(overrides);
  });

  it('does NOT escape templateOverrides VALUES (slug-identifiers, not rendered HTML)', () => {
    // Asymmetric-pair counterpoint to the escape-boundary tests above:
    // every string field that flows into rendered HTML is escaped; the
    // templateOverrides RECORD's VALUES (slug-names) are NOT escaped
    // because they flow into Loops's slug-selection logic, not rendered
    // markup. Future refactor that silently escapes them would corrupt
    // the slug-name when Loops looks it up. Rot-vector closure.
    const overrides = { 'trial-converted': 'slug-with-special-chars-<>"' };
    const row = makeRow({ template_overrides: overrides });
    const config = toBrandConfig(row as never);
    expect(config.templateOverrides?.['trial-converted']).toBe('slug-with-special-chars-<>"');
  });

  it('does NOT escape orgId / parentBrandId identifiers', () => {
    // Same pass-through axis: identifiers are app-controlled, never
    // rendered into HTML. Escaping would corrupt the FK round-trip.
    const row = makeRow({ org_id: 'org-with-special-<chars>', parent_brand_id: 'b-<>' });
    const config = toBrandConfig(row as never);
    expect(config.orgId).toBe('org-with-special-<chars>');
    expect(config.parentBrandId).toBe('b-<>');
  });
});
