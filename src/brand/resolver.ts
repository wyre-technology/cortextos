// =============================================================================
// src/brand/resolver.ts
//
// PRD Reference: prd-white-label.md §5 (Inheritance), §5.1 (Terminal fallback),
//                §13 (Schema sketch).
// Ticket:        white-label / Task #3 (Brand resolver core)
//
// Resolution algorithm (PRD §5):
//   resolveBrand(orgId):
//     1. orgId == null                            -> wyre-default
//     2. brand_profiles WHERE org_id = orgId      -> return that brand
//        (direct hit; we do NOT walk parent when a direct brand exists)
//     3. organizations.parent_org_id IS NOT NULL  -> recurse into parent
//        (max depth 10; cycle protection)
//     4. no own brand, no parent                  -> wyre-default
//     5. wyre-default row missing                 -> BrandResolverError
//                                                     ('FALLBACK_MISSING')
//
// An in-memory TTL cache (Map, default 60s) keyed by orgId (with a
// dedicated sentinel for null) short-circuits repeat lookups so every request
// does not hit the DB.
// =============================================================================

import type postgres from 'postgres';
import type { BrandConfig } from './types.js';

/** Stable primary-key of the seeded Wyre-default brand row (migration 008). */
export const WYRE_DEFAULT_BRAND_ID = 'wyre-default';

/** Maximum depth for the org -> parent_org_id walk. Guards against cycles. */
export const MAX_RESOLVE_DEPTH = 10;

/** Default TTL for the in-memory resolver cache. */
export const DEFAULT_CACHE_TTL_SECONDS = 60;

/** Cache-key sentinel for the "null orgId" (unauthenticated) resolution. */
const NULL_ORG_CACHE_KEY = '__null__';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type BrandResolverErrorCode =
  | 'MAX_DEPTH_EXCEEDED'
  | 'FALLBACK_MISSING'
  | 'INVALID_ORG';

export class BrandResolverError extends Error {
  public readonly code: BrandResolverErrorCode;

  constructor(code: BrandResolverErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BrandResolverError';
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// DB row shapes (snake_case, matching migration 008_brand_profiles.sql)
// -----------------------------------------------------------------------------

interface BrandProfileRow {
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
  version: number | string;
}

interface OrgParentRow {
  parent_org_id: string | null;
}

// -----------------------------------------------------------------------------
// snake_case row -> camelCase BrandConfig mapping
// -----------------------------------------------------------------------------

/**
 * Coalesce DB nullable columns into BrandConfig's non-null env-compat shape.
 * The legacy BrandConfig fields (name/tagline/logoUrl/etc.) are non-nullable
 * strings for backwards compatibility with env-only callers (PRD §11), so we
 * substitute sensible defaults when the DB column is NULL. The new DB-backed
 * fields preserve nullability for strict round-tripping.
 */
export function toBrandConfig(row: BrandProfileRow): BrandConfig {
  const versionNum =
    typeof row.version === 'string' ? Number.parseInt(row.version, 10) : row.version;

  return {
    // Legacy env-compat fields (non-null) — coalesce DB nulls.
    name: row.name,
    tagline: row.tagline ?? '',
    logoUrl: row.logo_url ?? '',
    supportUrl: row.support_url ?? '',
    docsUrl: row.docs_url ?? '/',
    issuesUrl: row.issues_url ?? '',
    primaryColor: row.primary_color ?? '#000000',
    accentColor: row.accent_color ?? '#000000',
    headingFont: row.heading_font ?? 'Inter',
    bodyFont: row.body_font ?? 'Inter',
    borderRadius:
      row.border_radius !== null && row.border_radius !== undefined
        ? `${row.border_radius}px`
        : '8px',
    domain: '', // domain is derived from custom_domains / BASE_URL elsewhere.

    // DB-backed fields (PRD §13).
    id: row.id,
    orgId: row.org_id,
    parentBrandId: row.parent_brand_id,
    tier: row.tier,
    fromEmailDisplayName: row.from_email_display_name,
    supportEmail: row.support_email,
    logoDarkUrl: row.logo_dark_url,
    textPrimary: row.text_primary,
    textSecondary: row.text_secondary,
    bgPrimary: row.bg_primary,
    bgSecondary: row.bg_secondary,
    borderColor: row.border_color,
    borderRadiusPx: row.border_radius,
    allowCustomerOverrides: row.allow_customer_overrides,
    version: Number.isFinite(versionNum) ? versionNum : 1,
    isWyreDefault: row.is_wyre_default,
  };
}

// -----------------------------------------------------------------------------
// Cache
// -----------------------------------------------------------------------------

interface CacheEntry {
  brand: BrandConfig;
  expiresAt: number; // epoch ms
}

// -----------------------------------------------------------------------------
// BrandResolver
// -----------------------------------------------------------------------------

export class BrandResolver {
  private readonly sql: postgres.Sql;
  private readonly ttlMs: number;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(sql: postgres.Sql, cacheTtlSeconds: number = DEFAULT_CACHE_TTL_SECONDS) {
    this.sql = sql;
    this.ttlMs = Math.max(0, cacheTtlSeconds) * 1000;
  }

  /**
   * Resolve the BrandConfig that applies to the given org.
   * See algorithm comment at top of file.
   */
  async resolveBrand(orgId: string | null): Promise<BrandConfig> {
    const cacheKey = orgId ?? NULL_ORG_CACHE_KEY;
    const hit = this.readCache(cacheKey);
    if (hit) return hit;

    const brand =
      orgId === null
        ? await this.loadWyreDefault()
        : await this.walk(orgId, 0);

    this.writeCache(cacheKey, brand);
    return brand;
  }

  /** Clear the full cache. Exposed for tests and admin ops. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Invalidate a single org (used by brand-write paths; PRD §12). */
  invalidate(orgId: string | null): void {
    this.cache.delete(orgId ?? NULL_ORG_CACHE_KEY);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async walk(orgId: string, depth: number): Promise<BrandConfig> {
    if (depth > MAX_RESOLVE_DEPTH) {
      throw new BrandResolverError(
        'MAX_DEPTH_EXCEEDED',
        `brand resolution exceeded max depth ${MAX_RESOLVE_DEPTH} at org ${orgId}`,
      );
    }

    if (typeof orgId !== 'string' || orgId.length === 0) {
      throw new BrandResolverError('INVALID_ORG', 'orgId must be a non-empty string');
    }

    // 2. Direct brand lookup.
    const direct = await this.loadBrandByOrgId(orgId);
    if (direct) return toBrandConfig(direct);

    // 3. Parent walk.
    const parentOrgId = await this.loadParentOrgId(orgId);
    if (parentOrgId) {
      return this.walk(parentOrgId, depth + 1);
    }

    // 4. Terminal fallback.
    return this.loadWyreDefault();
  }

  private async loadBrandByOrgId(orgId: string): Promise<BrandProfileRow | null> {
    const rows = await this.sql<BrandProfileRow[]>`
      SELECT * FROM brand_profiles WHERE org_id = ${orgId} LIMIT 1
    `;
    return rows.length > 0 ? rows[0] ?? null : null;
  }

  private async loadParentOrgId(orgId: string): Promise<string | null> {
    const rows = await this.sql<OrgParentRow[]>`
      SELECT parent_org_id FROM organizations WHERE id = ${orgId} LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0]?.parent_org_id ?? null;
  }

  private async loadWyreDefault(): Promise<BrandConfig> {
    const rows = await this.sql<BrandProfileRow[]>`
      SELECT * FROM brand_profiles WHERE is_wyre_default = TRUE LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new BrandResolverError(
        'FALLBACK_MISSING',
        'wyre-default brand row missing (should be seeded by migration 008)',
      );
    }
    return toBrandConfig(row);
  }

  private readCache(key: string): BrandConfig | null {
    if (this.ttlMs === 0) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.brand;
  }

  private writeCache(key: string, brand: BrandConfig): void {
    if (this.ttlMs === 0) return;
    this.cache.set(key, { brand, expiresAt: Date.now() + this.ttlMs });
  }
}
