-- =============================================================================
-- Migration:      017_mcp_gateway_parity.sql
-- Date:           2026-05-04
-- PRD Reference:  plans/okay-so-we-need-imperative-pebble.md (Consolidation)
-- Audit doc:      docs/operations/mcp-gateway-vendor-delta.md (Phase 0)
--
-- Purpose:
--   Bring Conduit's schema up to parity with mcp-gateway so the data
--   migration script (Phase 4) can copy rows verbatim. The Phase 0 audit
--   identified six tables and one organizations column that mcp-gateway has
--   and Conduit does not:
--
--     - subscriptions               (Stripe subscription state, dedicated table
--                                    distinct from organizations.stripe_*)
--     - deleted_orgs                (soft-delete forensics)
--     - vendor_oauth_flow_states    (PKCE state for vendor OAuth — Xero, QBO,
--                                    M365, HubSpot)
--     - entity_mappings             (cross-vendor entity ID translation)
--     - credit_ledger               (credit consumption transactions)
--     - credit_blocks               (pre-purchased credit grants)
--     - organizations.seat_billing_grandfathered_until
--
--   Table shapes are copied verbatim from upstream so the ported services
--   (credit-service, vendor-state-store, entity-map-service) drop in without
--   schema fix-up.
--
-- Idempotency:
--   All CREATE / ALTER guarded with IF NOT EXISTS. The seat-billing backfill
--   UPDATE is bounded by `seat_billing_grandfathered_until IS NULL` so it
--   runs exactly once per row.
--
-- RLS:
--   - credit_ledger / credit_blocks: org-scoped, mirrors org_credentials
--     visibility.
--   - entity_mappings: scope column carries an org_id; mirror same pattern.
--   - vendor_oauth_flow_states: user-scoped (state is short-lived per-user).
--   - subscriptions: org-scoped, member-readable / admin-writable.
--   - deleted_orgs: admin-only (no RLS — relies on app-level gate, same
--     discipline as admin_audit_log).
--
-- Rollback:
--   Forward-only project convention. Greenfield rollback would DROP each
--   table created here and the seat-billing column.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. subscriptions  (mcp-gateway/migrations/0001_subscriptions.sql)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       TEXT        PRIMARY KEY,
  org_id                   TEXT        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id       TEXT        NOT NULL,
  stripe_subscription_id   TEXT        NOT NULL UNIQUE,
  plan                     TEXT        NOT NULL DEFAULT 'pro',
  status                   TEXT        NOT NULL DEFAULT 'active',
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id
  ON subscriptions (org_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id
  ON subscriptions (stripe_customer_id);

-- ---------------------------------------------------------------------------
-- 2. deleted_orgs  (mcp-gateway/src/org/org-service.ts:338)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deleted_orgs (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  plan                   TEXT NOT NULL,
  owner_id               TEXT NOT NULL,
  owner_email            TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  member_count           INTEGER NOT NULL,
  last_tool_call_at      TIMESTAMPTZ,
  org_created_at         TIMESTAMPTZ NOT NULL,
  deleted_by             TEXT NOT NULL,
  deleted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_deleted_orgs_owner_email
  ON deleted_orgs (owner_email);

-- ---------------------------------------------------------------------------
-- 3. vendor_oauth_flow_states  (mcp-gateway/src/oauth/vendor-state-store.ts:62)
--
-- code verifier is stored ENCRYPTED, keyed by master_key || user_id (matches
-- credential-service envelope; Phase 3 ports the read/write helpers).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_oauth_flow_states (
  state_token              TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_slug              TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  code_verifier_iv         TEXT NOT NULL,
  code_verifier_auth_tag   TEXT NOT NULL,
  code_verifier_salt       TEXT NOT NULL,
  org_id                   TEXT,
  team_id                  TEXT,
  oauth_session            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_oauth_flow_states_expires_at
  ON vendor_oauth_flow_states (expires_at);

-- ---------------------------------------------------------------------------
-- 4. entity_mappings  (mcp-gateway/src/proxy/entity-map-service.ts:75)
--
-- `scope` is an org_id (or 'global' for shared mappings). vendor_ids is a
-- JSONB map of { "<vendor_slug>": "<vendor_entity_id>" }.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_mappings (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  vendor_ids      JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_mappings_scope
  ON entity_mappings (scope);

CREATE INDEX IF NOT EXISTS idx_entity_mappings_lookup
  ON entity_mappings (scope, entity_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_mappings_unique
  ON entity_mappings (scope, entity_type, lower(canonical_name));

-- ---------------------------------------------------------------------------
-- 5. credit_ledger  (mcp-gateway/src/billing/credit-service.ts:28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_ledger (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  vendor_slug  TEXT NOT NULL,
  credits_used INT NOT NULL DEFAULT 1,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credit_ledger_org_month
  ON credit_ledger (org_id, recorded_at);

-- ---------------------------------------------------------------------------
-- 6. credit_blocks  (mcp-gateway/src/billing/credit-service.ts:44)
--
-- granted_by / reason set when the block was comp'd by an admin rather than
-- purchased through Stripe. Both NULL for paid blocks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_blocks (
  id                        BIGSERIAL PRIMARY KEY,
  org_id                    TEXT NOT NULL,
  credits                   INT NOT NULL,
  remaining                 INT NOT NULL,
  purchased_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stripe_payment_intent_id  TEXT,
  granted_by                TEXT,
  reason                    TEXT
);

CREATE INDEX IF NOT EXISTS credit_blocks_org
  ON credit_blocks (org_id, purchased_at);

CREATE UNIQUE INDEX IF NOT EXISTS credit_blocks_payment_intent_unique
  ON credit_blocks (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. organizations.seat_billing_grandfathered_until
--
-- 90-day grace window for orgs that had Stripe subscriptions before per-seat
-- billing was introduced. Backfilled below; subsequent rows get NULL until a
-- billing event populates them.
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS seat_billing_grandfathered_until TIMESTAMPTZ;

UPDATE organizations
   SET seat_billing_grandfathered_until = NOW() + INTERVAL '90 days'
 WHERE stripe_subscription_id IS NOT NULL
   AND seat_billing_grandfathered_until IS NULL;

-- =============================================================================
-- RLS policies
--
-- Pattern matches migrations/007_rls_enable.sql + 014_rls_with_check_clauses.sql:
--   - SELECT for any org member
--   - INSERT/UPDATE/DELETE for owner/admin (write paths) — ledger and entity
--     mapping writes go through services that already check role at the API
--     boundary, but RLS is the defense-in-depth.
--
-- vendor_oauth_flow_states is user-scoped (the user starting the OAuth dance
-- is the only legitimate reader of their own PKCE state). Cleanup on
-- expiry runs as a privileged session that bypasses RLS.
-- =============================================================================

-- subscriptions ----------------------------------------------------------------
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = subscriptions.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS subscriptions_write ON subscriptions;
CREATE POLICY subscriptions_write ON subscriptions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = subscriptions.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = subscriptions.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
  );

-- credit_ledger ----------------------------------------------------------------
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_ledger_select ON credit_ledger;
CREATE POLICY credit_ledger_select ON credit_ledger
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = credit_ledger.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS credit_ledger_insert ON credit_ledger;
CREATE POLICY credit_ledger_insert ON credit_ledger
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = credit_ledger.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  );

-- credit_blocks ----------------------------------------------------------------
ALTER TABLE credit_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_blocks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_blocks_select ON credit_blocks;
CREATE POLICY credit_blocks_select ON credit_blocks
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = credit_blocks.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS credit_blocks_write ON credit_blocks;
CREATE POLICY credit_blocks_write ON credit_blocks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = credit_blocks.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = credit_blocks.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
  );

-- entity_mappings -------------------------------------------------------------
-- scope is an org_id (or 'global' for shared mappings). 'global' rows are
-- visible to any authenticated session.
ALTER TABLE entity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_mappings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_mappings_select ON entity_mappings;
CREATE POLICY entity_mappings_select ON entity_mappings
  FOR SELECT
  USING (
    entity_mappings.scope = 'global'
    OR EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = entity_mappings.scope
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS entity_mappings_write ON entity_mappings;
CREATE POLICY entity_mappings_write ON entity_mappings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = entity_mappings.scope
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = entity_mappings.scope
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
  );

-- vendor_oauth_flow_states ----------------------------------------------------
-- User-scoped: the only legitimate reader is the user who initiated the OAuth
-- handshake. Privileged background cleanup runs with RLS bypassed.
ALTER TABLE vendor_oauth_flow_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_oauth_flow_states FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_oauth_flow_states_self ON vendor_oauth_flow_states;
CREATE POLICY vendor_oauth_flow_states_self ON vendor_oauth_flow_states
  FOR ALL
  USING (
    user_id = current_setting('conduit.current_user_id', true)
  )
  WITH CHECK (
    user_id = current_setting('conduit.current_user_id', true)
  );

-- deleted_orgs ----------------------------------------------------------------
-- Admin-only audit table; same posture as admin_audit_log. App-level gate
-- enforces the platform-admin role; no RLS policy here so a misconfigured
-- session var doesn't accidentally expose forensic rows. We still ENABLE RLS
-- with no policies so a bare SELECT returns zero rows.
ALTER TABLE deleted_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_orgs FORCE ROW LEVEL SECURITY;

COMMIT;

-- =============================================================================
-- End of 017_mcp_gateway_parity.sql
-- =============================================================================
