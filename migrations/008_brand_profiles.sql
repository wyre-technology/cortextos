-- =============================================================================
-- Migration:      008_brand_profiles.sql
-- Date:           2026-04-20
-- PRD Reference:  prd-white-label.md §13 (Schema sketch), §5 (Inheritance),
--                 §6 (Assets), §7 (Custom domains), §9 (Theming tokens),
--                 §10 (Preview audit).
-- Ticket:         white-label / Task #1 (Database Schema and Migrations)
--
-- Purpose:
--   Introduce the DB-backed white-label branding schema so Conduit can serve
--   many MSP resellers (and their downstream customer orgs) from a single
--   deployment without Wyre strings leaking to end-customers. Creates:
--
--     - brand_profiles         one row per brand (wyre_default / reseller /
--                              customer tier), including color tokens, typography
--                              allowlist refs, support URLs, and controls such
--                              as allow_customer_overrides. Seeds one row with
--                              is_wyre_default=true carrying the ambient Wyre
--                              defaults (name/tagline/support URLs, color
--                              tokens). This row is the terminal fallback in
--                              the inheritance walk (PRD §5.1).
--     - custom_domains         per-MSP hostnames going through the DNS+ACME
--                              verification state machine (PRD §7).
--     - brand_assets           metadata for logos/favicons/OG images stored in
--                              the brand-assets CDN (PRD §6).
--     - brand_font_allowlist   Wyre-curated Google Fonts enum; heading_font and
--                              body_font on brand_profiles reference it, which
--                              prevents CSS injection via arbitrary font URLs
--                              (PRD §9). Seeded with a baseline set of Google
--                              Fonts families covering the v1 MSP UI.
--     - brand_preview_audit    records every Wyre-operator "Preview as {brand}"
--                              activation for cross-tenant auditability (PRD
--                              §10, §17).
--
-- Conventions:
--   The project uses TEXT primary keys (app-generated IDs) for business
--   tables (see 001_customer_tenants.sql, 003_reseller_members.sql, etc.)
--   even though the PRD schema sketch was written with UUID PRIMARY KEY. We
--   adopt TEXT PRIMARY KEY here for consistency with organizations(id) and
--   users(id), which are TEXT. brand_font_allowlist keeps a SERIAL id because
--   its rows are Wyre-managed lookup data, not app-addressable entities, and
--   the PRD sketch already chose SERIAL.
--
--   All FKs to organizations(id) use ON DELETE CASCADE: dropping an org drops
--   its brand, assets, custom domains, and any brand_profiles rows owned by
--   it. FKs to users(id) use ON DELETE SET NULL for audit/authorship columns
--   so we don't lose brand rows when a user is deleted.
--
--   The parent_brand_id self-FK uses ON DELETE SET NULL so that deleting a
--   parent (e.g., a reseller) does not cascade away the child customer brand
--   rows — they simply fall back to the Wyre default walk.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE UNIQUE
--   INDEX IF NOT EXISTS, guarded CHECK / FK additions via DO-blocks, and the
--   Wyre-default + font-allowlist seeds use ON CONFLICT DO NOTHING. Safe to
--   re-run.
--
-- Rollback Notes:
--   Greenfield rollback: drop tables in reverse FK order
--     (brand_preview_audit, brand_assets, custom_domains, brand_profiles,
--      brand_font_allowlist). Forward-only project convention — no down-
--     migration file (see 001_customer_tenants.sql).
--
-- Ordering / Concerns:
--   - brand_profiles must be created before brand_preview_audit (FK target).
--   - brand_font_allowlist does not FK from brand_profiles.{heading,body}_font
--     at the DB level: the PRD §9 contract is that the API layer validates
--     font values against the allowlist before INSERT/UPDATE. This keeps the
--     allowlist editable without needing to repair existing brand rows, and
--     matches the "Wyre-ops editable" nature of the table.
--   - Hex color CHECK constraints use the regex ^#[0-9a-fA-F]{6}$ per PRD §9
--     and §15 acceptance #11.
--   - Exactly-one Wyre default enforced via a partial unique index on
--     (is_wyre_default) WHERE is_wyre_default = true.
--   - One brand per org enforced via a partial unique index on (org_id)
--     WHERE org_id IS NOT NULL (the wyre_default row has org_id = NULL).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. brand_font_allowlist
--    Wyre-curated list of Google Fonts families eligible for use by any
--    brand_profile. Editable by Wyre ops only (enforced at the API layer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_font_allowlist (
  id            SERIAL PRIMARY KEY,
  family_name   TEXT UNIQUE NOT NULL,
  google_fonts  BOOLEAN NOT NULL DEFAULT TRUE,
  weight_css    TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_font_allowlist_active
  ON brand_font_allowlist (family_name)
  WHERE active = TRUE;

-- ---------------------------------------------------------------------------
-- 2. brand_profiles
--    One row per brand. Wyre ships one seeded row with is_wyre_default=true.
--    MSP orgs get one row (tier='reseller'); customer orgs optionally get
--    one (tier='customer') that inherits from its parent_brand_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_profiles (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  parent_brand_id          TEXT REFERENCES brand_profiles(id) ON DELETE SET NULL,
  tier                     TEXT NOT NULL,
  is_wyre_default          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Identity
  name                     TEXT NOT NULL,
  tagline                  TEXT,
  from_email_display_name  TEXT,
  support_url              TEXT,
  support_email            TEXT,
  docs_url                 TEXT,
  issues_url               TEXT,

  -- Visual — asset URLs
  logo_url                 TEXT,
  logo_dark_url            TEXT,
  favicon_url              TEXT,
  og_image_url             TEXT,

  -- Visual — color tokens (hex, validated below)
  primary_color            TEXT,
  accent_color             TEXT,
  text_primary             TEXT,
  text_secondary           TEXT,
  bg_primary               TEXT,
  bg_secondary             TEXT,
  border_color             TEXT,

  -- Visual — typography (must be on brand_font_allowlist.family_name;
  -- enforced at API layer so ops can rotate the allowlist without
  -- rewriting historical brand rows)
  heading_font             TEXT,
  body_font                TEXT,
  border_radius            INTEGER,

  -- Controls
  allow_customer_overrides BOOLEAN NOT NULL DEFAULT FALSE,

  -- Concurrency / caching (PRD §12)
  version                  BIGINT NOT NULL DEFAULT 1,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by               TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 2a. Guarded CHECK constraints on brand_profiles
--     (Postgres lacks IF NOT EXISTS for ADD CONSTRAINT, so we guard each
--     with a DO-block — same pattern as 002_reseller_tenancy_expand.sql.)
-- ---------------------------------------------------------------------------

-- Tier enum: wyre_default | reseller | customer (PRD §13)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'brand_profiles_tier_check'
       AND conrelid = 'brand_profiles'::regclass
  ) THEN
    ALTER TABLE brand_profiles
      ADD CONSTRAINT brand_profiles_tier_check
      CHECK (tier IN ('wyre_default', 'reseller', 'customer'));
  END IF;
END$$;

-- Hex color regex CHECKs (PRD §9, acceptance #11)
DO $$
DECLARE
  col TEXT;
  color_cols TEXT[] := ARRAY[
    'primary_color', 'accent_color',
    'text_primary', 'text_secondary',
    'bg_primary',   'bg_secondary',
    'border_color'
  ];
BEGIN
  FOREACH col IN ARRAY color_cols LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = format('brand_profiles_%s_hex_check', col)
         AND conrelid = 'brand_profiles'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE brand_profiles
           ADD CONSTRAINT brand_profiles_%I_hex_check
           CHECK (%I IS NULL OR %I ~ ''^#[0-9a-fA-F]{6}$'')',
        col, col, col
      );
    END IF;
  END LOOP;
END$$;

-- border_radius bounds (PRD §9: integer 0–24 px)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'brand_profiles_border_radius_check'
       AND conrelid = 'brand_profiles'::regclass
  ) THEN
    ALTER TABLE brand_profiles
      ADD CONSTRAINT brand_profiles_border_radius_check
      CHECK (border_radius IS NULL OR (border_radius BETWEEN 0 AND 24));
  END IF;
END$$;

-- Tier/org/wyre-default coherence:
--   * tier='wyre_default' => is_wyre_default = TRUE  AND org_id IS NULL
--   * tier IN ('reseller','customer') => is_wyre_default = FALSE AND org_id IS NOT NULL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'brand_profiles_tier_coherence_check'
       AND conrelid = 'brand_profiles'::regclass
  ) THEN
    ALTER TABLE brand_profiles
      ADD CONSTRAINT brand_profiles_tier_coherence_check
      CHECK (
        (tier = 'wyre_default' AND is_wyre_default = TRUE  AND org_id IS NULL)
        OR
        (tier IN ('reseller','customer') AND is_wyre_default = FALSE AND org_id IS NOT NULL)
      );
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2b. Indexes on brand_profiles
-- ---------------------------------------------------------------------------

-- Exactly one Wyre default (PRD §13)
CREATE UNIQUE INDEX IF NOT EXISTS brand_profiles_one_wyre_default
  ON brand_profiles (is_wyre_default)
  WHERE is_wyre_default = TRUE;

-- Exactly one brand per org (org_id nullable to allow the wyre_default row)
CREATE UNIQUE INDEX IF NOT EXISTS brand_profiles_one_per_org
  ON brand_profiles (org_id)
  WHERE org_id IS NOT NULL;

-- Fast org_id lookup (the resolver's hot path walks org -> parent -> default)
CREATE INDEX IF NOT EXISTS idx_brand_profiles_org_id
  ON brand_profiles (org_id);

-- Parent-brand walk support
CREATE INDEX IF NOT EXISTS idx_brand_profiles_parent_brand_id
  ON brand_profiles (parent_brand_id)
  WHERE parent_brand_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. custom_domains
--    MSP-owned hostnames routed back to their brand via the Host-header
--    resolver (PRD §7).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_domains (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hostname           TEXT UNIQUE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  dns_token          TEXT,
  tls_cert_ref       TEXT,
  tls_cert_not_after TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'custom_domains_status_check'
       AND conrelid = 'custom_domains'::regclass
  ) THEN
    ALTER TABLE custom_domains
      ADD CONSTRAINT custom_domains_status_check
      CHECK (status IN (
        'pending',
        'verifying_dns',
        'verifying_tls',
        'active',
        'failed',
        'revoked'
      ));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_custom_domains_org_id
  ON custom_domains (org_id);

-- Active-hostname lookup: the host-resolver middleware's hot path.
CREATE INDEX IF NOT EXISTS idx_custom_domains_active_hostname
  ON custom_domains (hostname)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 4. brand_assets
--    Metadata for logos / favicons / OG images. Blobs live in the brand-
--    assets CDN (Azure Blob / S3 / local per env). Rows are soft-deleted via
--    deleted_at; blob GC runs out-of-band.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_assets (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  public_url    TEXT NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'brand_assets_kind_check'
       AND conrelid = 'brand_assets'::regclass
  ) THEN
    ALTER TABLE brand_assets
      ADD CONSTRAINT brand_assets_kind_check
      CHECK (kind IN ('logo', 'logo_dark', 'favicon', 'og_image'));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'brand_assets_bytes_check'
       AND conrelid = 'brand_assets'::regclass
  ) THEN
    ALTER TABLE brand_assets
      ADD CONSTRAINT brand_assets_bytes_check
      CHECK (bytes >= 0);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_brand_assets_org_kind
  ON brand_assets (org_id, kind)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_brand_assets_content_hash
  ON brand_assets (content_hash);

-- ---------------------------------------------------------------------------
-- 5. brand_preview_audit
--    Records Wyre-operator "Preview as {brand}" activations (PRD §10, §17).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_preview_audit (
  id           TEXT PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES users(id),
  brand_id     TEXT NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_brand_preview_audit_operator
  ON brand_preview_audit (operator_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_brand_preview_audit_brand
  ON brand_preview_audit (brand_id, started_at DESC);

-- Active previews (ended_at IS NULL) — used by the operator UI banner and by
-- the "force-expire stale previews" sweeper.
CREATE INDEX IF NOT EXISTS idx_brand_preview_audit_active
  ON brand_preview_audit (operator_id)
  WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Seed: Wyre-default brand_profile
--    Terminal fallback for brand resolution (PRD §5.1, §13). Uses a stable
--    ID ('wyre-default') so application code and later migrations can
--    reference it without a lookup. Values mirror the current env-var
--    defaults baked into src/brand/index.ts so behavior is unchanged when
--    FEATURE_DB_BRANDING flips on (PRD §11).
-- ---------------------------------------------------------------------------
INSERT INTO brand_profiles (
  id,
  org_id,
  parent_brand_id,
  tier,
  is_wyre_default,
  name,
  tagline,
  from_email_display_name,
  support_url,
  support_email,
  docs_url,
  issues_url,
  primary_color,
  accent_color,
  text_primary,
  text_secondary,
  bg_primary,
  bg_secondary,
  border_color,
  heading_font,
  body_font,
  border_radius,
  allow_customer_overrides,
  version
) VALUES (
  'wyre-default',
  NULL,
  NULL,
  'wyre_default',
  TRUE,
  'Wyre',
  'MCP Gateway by Wyre',
  'Wyre',
  'https://wyre.io/support',
  'support@wyre.io',
  'https://docs.wyre.io',
  'https://github.com/wyre-technology/msp-claude-plugins/issues',
  '#0A84FF',
  '#30D158',
  '#111111',
  '#555555',
  '#FFFFFF',
  '#F5F5F7',
  '#E5E5EA',
  'Inter',
  'Inter',
  8,
  FALSE,
  1
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Seed: Google Fonts allowlist (PRD §9)
--    Baseline families available for heading_font / body_font selection.
--    Wyre ops extend this at runtime; the API layer validates brand_profiles
--    font values against brand_font_allowlist.family_name on write.
-- ---------------------------------------------------------------------------
INSERT INTO brand_font_allowlist (family_name, google_fonts, weight_css, active) VALUES
  ('Inter',             TRUE, '400;500;600;700', TRUE),
  ('Roboto',            TRUE, '400;500;700',     TRUE),
  ('Open Sans',         TRUE, '400;600;700',     TRUE),
  ('Lato',              TRUE, '400;700',         TRUE),
  ('Montserrat',        TRUE, '400;600;700',     TRUE),
  ('Source Sans 3',     TRUE, '400;600;700',     TRUE),
  ('Nunito',            TRUE, '400;600;700',     TRUE),
  ('Poppins',           TRUE, '400;500;600;700', TRUE),
  ('Work Sans',         TRUE, '400;500;600;700', TRUE),
  ('IBM Plex Sans',     TRUE, '400;500;600;700', TRUE),
  ('IBM Plex Serif',    TRUE, '400;500;600;700', TRUE),
  ('IBM Plex Mono',     TRUE, '400;500;600;700', TRUE),
  ('Merriweather',      TRUE, '400;700',         TRUE),
  ('Playfair Display',  TRUE, '400;600;700',     TRUE),
  ('JetBrains Mono',    TRUE, '400;500;700',     TRUE),
  ('Fira Sans',         TRUE, '400;500;600;700', TRUE),
  ('Fira Code',         TRUE, '400;500;700',     TRUE),
  ('DM Sans',           TRUE, '400;500;700',     TRUE),
  ('DM Serif Display',  TRUE, '400',             TRUE),
  ('Space Grotesk',     TRUE, '400;500;600;700', TRUE)
ON CONFLICT (family_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Column comments (documentation layer — visible in \d+ and ORM introspection)
-- ---------------------------------------------------------------------------
COMMENT ON TABLE  brand_profiles                          IS 'Per-brand configuration. One row per distinct brand. Wyre ships one row with is_wyre_default=true as terminal fallback. See PRD prd-white-label.md §5, §13.';
COMMENT ON COLUMN brand_profiles.org_id                   IS 'Owning organization. NULL only for the singleton wyre_default row.';
COMMENT ON COLUMN brand_profiles.parent_brand_id          IS 'Parent brand for inheritance walk (customer -> reseller). NULL for reseller/wyre_default rows.';
COMMENT ON COLUMN brand_profiles.tier                     IS 'Brand tier: wyre_default | reseller | customer. Matches the inheritance model in PRD §5.';
COMMENT ON COLUMN brand_profiles.is_wyre_default          IS 'Exactly one row may have this TRUE, enforced by partial unique index brand_profiles_one_wyre_default.';
COMMENT ON COLUMN brand_profiles.allow_customer_overrides IS 'MSP toggle: if FALSE, downstream customer orgs cannot mutate their brand row (API-layer enforced, PRD §5 + acceptance #7/#8).';
COMMENT ON COLUMN brand_profiles.version                  IS 'Monotonically increasing version. Bumped on every write by the API layer; used in cache keys to invalidate stale renders (PRD §12).';
COMMENT ON COLUMN brand_profiles.heading_font             IS 'Family name from brand_font_allowlist. API-layer validated, not FK-enforced, so the allowlist is editable without rewriting history.';
COMMENT ON COLUMN brand_profiles.body_font                IS 'Family name from brand_font_allowlist. API-layer validated, not FK-enforced.';

COMMENT ON TABLE  custom_domains                          IS 'MSP-owned hostnames routed to their brand by the Host-header resolver. See PRD §7.';
COMMENT ON COLUMN custom_domains.status                   IS 'State machine: pending -> verifying_dns -> verifying_tls -> active (| failed | revoked).';
COMMENT ON COLUMN custom_domains.tls_cert_ref             IS 'Reference (not the cert material itself) into Azure Key Vault or equivalent. Private keys never stored in Postgres.';

COMMENT ON TABLE  brand_assets                            IS 'Metadata for logos/favicons/OG images. Blob payload lives in the brand-assets CDN (Azure Blob / S3 / local). See PRD §6.';
COMMENT ON COLUMN brand_assets.content_hash               IS 'SHA-256 of bytes. Used in the CDN path so URLs are immutable / cacheable forever.';
COMMENT ON COLUMN brand_assets.deleted_at                 IS 'Soft-delete marker. Blob GC runs out-of-band (30-day grace per PRD §6).';

COMMENT ON TABLE  brand_font_allowlist                    IS 'Wyre-curated font families eligible for heading_font / body_font on brand_profiles. See PRD §9.';

COMMENT ON TABLE  brand_preview_audit                     IS 'Audit of Wyre-operator "Preview as {brand}" sessions. See PRD §10 and observability §17.';
COMMENT ON COLUMN brand_preview_audit.ended_at            IS 'NULL while preview is active. Set on explicit exit or by the stale-preview sweeper.';

COMMIT;

-- =============================================================================
-- End of 008_brand_profiles.sql
-- =============================================================================
