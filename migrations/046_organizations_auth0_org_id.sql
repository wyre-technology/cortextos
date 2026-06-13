-- 046_organizations_auth0_org_id.sql
--
-- Multi-IdP foundation slice 1 — store the paired Auth0 Organization id
-- against the Conduit organizations row.
--
-- Why this exists (June 29 launch directive 2026-06-13):
--   Aaron pre-launch-committed adopting Auth0 Organizations as the multi-
--   tenancy primitive so we can support per-org IdP routing for tenants
--   AND sub-tenants (Okta, JumpCloud, Google direct, etc.). Today Conduit
--   uses plain Auth0 Universal Login with a single app + no Organizations
--   primitive — every tenant shares the same connection pool. The migration
--   here is the storage substrate for slice 1; slice 2 (pearl) wires
--   email-domain → connection routing on top of this id; slice 3 (boss)
--   builds the SAML wizard UI.
--
-- Scope discipline:
--   * Nullable on purpose: existing pre-launch orgs backfill in a separate
--     pass once the Management API client + provisioning hook (PR-2/3 in
--     this slice) are in place. NULL = "Conduit org without an Auth0 Org
--     peer yet" — the auth flow falls through to legacy Universal Login.
--   * UNIQUE: one-to-one mapping between Conduit orgs and Auth0 Orgs. The
--     constraint catches accidental double-create + drift between the two
--     systems by-construction at write-time (vs reconciliation-after-the-
--     fact).
--   * TEXT: Auth0 Org ids are opaque strings of the form `org_<alnum>`
--     (~20 chars including prefix). TEXT keeps us schema-agnostic to any
--     future Auth0 id-format change without a follow-up migration.
--
-- Idempotency:
--   ADD COLUMN IF NOT EXISTS is safe to re-run. The UNIQUE constraint is
--   added via the DO $$ + pg_constraint-lookup pattern (Postgres has no
--   `ADD CONSTRAINT IF NOT EXISTS`) — same shape as migration 045's
--   template_overrides check constraint.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auth0_org_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organizations_auth0_org_id_unique'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_auth0_org_id_unique UNIQUE (auth0_org_id);
  END IF;
END $$;

-- Index for the callback-handler hot-path lookup (auth0.ts:/callback validates
-- id_token.org_id against the organizations row that owns the auth context).
-- Postgres builds an implicit btree for the UNIQUE constraint, which serves
-- equality lookups; explicit index here is for documentation + a guarded
-- IF NOT EXISTS in case future schema work reshapes the UNIQUE constraint.
CREATE INDEX IF NOT EXISTS idx_organizations_auth0_org_id
  ON organizations (auth0_org_id) WHERE auth0_org_id IS NOT NULL;
