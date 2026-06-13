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

import { getSql, type Sql } from '../db/context.js';
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

  // RC2 PR-A — per-event Loops template-slug overrides (mig 045). JSONB on
  // the DB side; null or Record<string,string> when read out via postgres.js.
  template_overrides: Record<string, string> | null;
}

interface OrgParentRow {
  parent_org_id: string | null;
}

// -----------------------------------------------------------------------------
// snake_case row -> camelCase BrandConfig mapping
// -----------------------------------------------------------------------------

/**
 * HTML-escape a single string for safe rendering in an HTML context (the
 * sink for every BrandConfig field flowing into Loops merge-tags or
 * transactional-email templates). Tiny escape table — matches the conduit
 * web/helpers.ts escapeHtml shape. Defined here (not imported from web/) to
 * keep the brand-resolver dependency-free of the web layer; the small
 * duplication is acceptable per the cross-cutting-utility-vs-coupling
 * trade-off (single-source-of-helper has the import-chain cost; per-domain
 * micro-helper has the duplication cost; for a 5-char-replacement function
 * the duplication wins).
 *
 * RC2 PR-A escape-boundary discipline: this fires for EVERY string field on
 * BrandConfig at toBrandConfig-time, so all 15+ downstream consumers (Loops
 * merge-tags, transactional emails, etc.) inherit the defense BY-CONSTRUCTION
 * without per-consumer defensive code. The pattern is the N=2 cross-cycle
 * firing of "attacker-influenced-value-flowing-into-rendered-output requires
 * escape-at-seam-between-source-and-sink" (sibling to WYREAI-98 #306
 * consentDocumentUrl-XSS escape; boss-locked at msg-1780675433546).
 *
 * Caller note: if a future consumer needs RAW (unescaped) values — e.g., an
 * admin-display rendering reseller-name in an attribute context where
 * additional escaping is required, or any non-HTML sink — fetch from the
 * brand_profiles table directly. The resolver's contract is HTML-safe.
 */
function escapeHtmlString(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a possibly-null string field. NULL passes through unchanged. */
function escNullable(s: string | null | undefined): string | null | undefined {
  if (s === null || s === undefined) return s;
  return escapeHtmlString(s);
}

/**
 * Coalesce DB nullable columns into BrandConfig's non-null env-compat shape.
 * The legacy BrandConfig fields (name/tagline/logoUrl/etc.) are non-nullable
 * strings for backwards compatibility with env-only callers (PRD §11), so we
 * substitute sensible defaults when the DB column is NULL. The new DB-backed
 * fields preserve nullability for strict round-tripping.
 *
 * RC2 PR-A: every string field is HTML-escaped at this boundary. The
 * BrandConfig returned is HTML-safe by-construction — single defense point
 * covering all 15+ downstream consumers (see escapeHtmlString docstring).
 * Non-string fields (numbers, booleans, the templateOverrides Record) pass
 * through unchanged. The templateOverrides RECORD's VALUES (slug-names) are
 * NOT escaped because they don't flow into rendered HTML — they flow into
 * Loops's slug-selection logic where they're consumed as identifiers, not
 * rendered. The KEYS (event-names) are application-defined constants, not
 * user-influenced, so they're untouched too.
 */
export function toBrandConfig(row: BrandProfileRow): BrandConfig {
  const versionNum =
    typeof row.version === 'string' ? Number.parseInt(row.version, 10) : row.version;

  return {
    // Legacy env-compat fields (non-null) — coalesce DB nulls THEN escape.
    // Order matters: coalesce first so the default-string is escaped (no-op
    // for the trusted constants but uniform discipline), THEN escape.
    name: escapeHtmlString(row.name),
    tagline: escapeHtmlString(row.tagline ?? ''),
    logoUrl: escapeHtmlString(row.logo_url ?? ''),
    supportUrl: escapeHtmlString(row.support_url ?? ''),
    docsUrl: escapeHtmlString(row.docs_url ?? '/'),
    issuesUrl: escapeHtmlString(row.issues_url ?? ''),
    primaryColor: escapeHtmlString(row.primary_color ?? '#000000'),
    accentColor: escapeHtmlString(row.accent_color ?? '#000000'),
    headingFont: escapeHtmlString(row.heading_font ?? 'Inter'),
    bodyFont: escapeHtmlString(row.body_font ?? 'Inter'),
    borderRadius:
      row.border_radius !== null && row.border_radius !== undefined
        ? `${row.border_radius}px`
        : '8px', // numeric round-trip, no escape needed
    domain: '', // domain is derived from custom_domains / BASE_URL elsewhere.

    // DB-backed fields (PRD §13). Nullable strings escape via escNullable;
    // identifiers (id, orgId, parentBrandId) are app-controlled but escape
    // for defense-in-depth; enums + numbers + booleans + templateOverrides
    // pass through unchanged (rationale in toBrandConfig docstring).
    id: escapeHtmlString(row.id),
    orgId: row.org_id, // identifier; never rendered into HTML attribute or body
    parentBrandId: row.parent_brand_id, // same
    tier: row.tier, // enum literal, safe
    fromEmailDisplayName: escNullable(row.from_email_display_name),
    supportEmail: escNullable(row.support_email),
    logoDarkUrl: escNullable(row.logo_dark_url),
    textPrimary: escNullable(row.text_primary),
    textSecondary: escNullable(row.text_secondary),
    bgPrimary: escNullable(row.bg_primary),
    bgSecondary: escNullable(row.bg_secondary),
    borderColor: escNullable(row.border_color),
    borderRadiusPx: row.border_radius, // numeric, no escape
    allowCustomerOverrides: row.allow_customer_overrides,
    version: Number.isFinite(versionNum) ? versionNum : 1,
    isWyreDefault: row.is_wyre_default,

    // RC2 PR-A — templateOverrides round-trip. Not escaped (see docstring).
    // Returns null when DB column is NULL (the ~95% case).
    templateOverrides: row.template_overrides,
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
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  private readonly ttlMs: number;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(cacheTtlSeconds: number = DEFAULT_CACHE_TTL_SECONDS) {
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
