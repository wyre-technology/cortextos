-- =============================================================================
-- Migration:      035_vendor_registry.sql
-- Phase:          Vendor-registry decoupling — Phase 1 (data-fy the pure-data
--                 majority + getVendor-from-registry, flagged, parity-gated).
-- Design:         analyst deliverables/conduit-vendor-registry-decoupling-scope-
--                 2026-05-27.md §3-§5. Aaron sign-off 2026-05-27.
--
-- Problem:        Vendor config is hard-coded in `src/credentials/vendor-config.ts`
--                 (`export const VENDORS`), so adding/updating a vendor forces a
--                 full image rebuild + redeploy.
-- Goal:           A pure-data vendor add/update becomes a DB row, not a code change.
--
-- This migration adds the two registry tables. It is ADDITIVE + DORMANT: the
-- compiled VENDORS map stays the source of truth until the
-- `VENDOR_REGISTRY_ENABLED` flag flips, which is gated on the parity-gate going
-- green (registry-derived data deep-equals the compiled map for every migrated
-- vendor, across all accessors). Until then nothing reads these tables at runtime.
--
-- Transport (Phase 1, decision (B)): per-repo table in each repo's DB, seeded
-- from the ONE canonical seed; the CI parity-gate cross-compares (per-repo
-- DB==seed==compiled-map, and cross-repo conduit==gateway) fail-closed. The
-- physical single shared store is the deliberate Phase-3 reconcile.
--
-- Idempotent: CREATE { TABLE, INDEX } IF NOT EXISTS; DROP-then-CREATE policy +
-- trigger. Safe to re-run. Greenfield: no down-migration (drop trigger/fn/
-- policies/indexes/tables to reverse).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- vendors — GLOBAL vendor-definition registry (the data-fied VendorConfig).
--
-- Columns mirror the DATA fields of VendorConfig (vendor-config.ts). The
-- CODE-minority fields (`buildHeaders`, `validate`) are intentionally NOT
-- columns in Phase 1 — they remain compiled functions, preserved by the
-- entry-level hydrate (Object.assign(VENDORS[slug], row) merges these data
-- fields OVER the compiled entry, leaving the compiled fns intact). Phase 2
-- replaces them with declarative specs.
--
-- Global reference data: readable by all; writes are admin-authz-gated at the
-- application layer (same authz posture as the admin routes). No per-tenant
-- RLS on `vendors` — which vendors EXIST is not tenant-scoped; which are ON
-- per tenant lives in `vendor_enablement` below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendors (
  slug           TEXT PRIMARY KEY,
  name           TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  container_url  TEXT        NOT NULL,
  fields         JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- VendorField[]
  header_mapping JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- Record<string,string>
  docs_url       TEXT        NOT NULL DEFAULT '',
  oauth_config   JSONB,                                       -- OAuthVendorConfig | null
  preview        BOOLEAN     NOT NULL DEFAULT FALSE,
  mcp_path       TEXT,                                        -- NULL -> '/mcp' (app default)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- VendorCategory union (vendor-config.ts) — keep in lockstep with the TS type.
  CONSTRAINT vendors_category_valid CHECK (category IN (
    'rmm', 'psa', 'documentation', 'security', 'bcdr', 'network',
    'sales', 'accounting', 'crm', 'productivity', 'email-security', 'marketplace'
  ))
);

-- ---------------------------------------------------------------------------
-- vendor_enablement — per-tenant ON/OFF for a vendor definition.
--
-- Extends the tenancy pattern of reseller_shared_vendor_grants (migration 004):
-- a row turns a vendor ON for an org. RLS below is DEFENSE-IN-DEPTH only — the
-- gateway DB role (gatewayadmin) has BYPASSRLS + is table-owner, so RLS does NOT
-- filter for the gateway path. The getVendor/enablement read MUST therefore
-- filter org_id EXPLICITLY in query (WHERE org_id = ...), never relying on RLS
-- for the gateway. (Banked from the 2026-05-26 BYPASSRLS incident lesson.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_enablement (
  id           TEXT        PRIMARY KEY,
  org_id       TEXT        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_slug  TEXT        NOT NULL REFERENCES vendors(slug)     ON DELETE CASCADE,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  enabled_by   TEXT        REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, vendor_slug)
);

CREATE INDEX IF NOT EXISTS idx_vendor_enablement_org
  ON vendor_enablement (org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_enablement_vendor
  ON vendor_enablement (vendor_slug);

-- updated_at touch trigger (same per-table convention as 027_reseller_invoices).
CREATE OR REPLACE FUNCTION vendors_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendors_set_updated_at ON vendors;
CREATE TRIGGER trg_vendors_set_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendors_set_updated_at();

DROP TRIGGER IF EXISTS trg_vendor_enablement_set_updated_at ON vendor_enablement;
CREATE TRIGGER trg_vendor_enablement_set_updated_at
  BEFORE UPDATE ON vendor_enablement
  FOR EACH ROW EXECUTE FUNCTION vendors_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS on vendor_enablement (defense-in-depth; NOT the enforcement for the
-- gateway BYPASSRLS path — see the explicit-query-filter note above). A
-- request-path (NOBYPASSRLS) connection sees only enablement rows for orgs the
-- session user is a member of. USING-only, dropped-then-created (007 pattern).
-- `vendors` is global reference data — left without per-tenant RLS by design.
-- ---------------------------------------------------------------------------
ALTER TABLE vendor_enablement ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_enablement_member_select ON vendor_enablement;
CREATE POLICY vendor_enablement_member_select ON vendor_enablement
  USING (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      org_id
    )
  );

COMMIT;
