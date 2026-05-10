-- =============================================================================
-- Migration:      013_organization_domains.sql
-- Date:           2026-04-21
-- PRD Reference:  prd-onboarding.md (email-domain auto-claim), prd-msp-admin.md
-- Ticket:         onboarding / domain-claim
--
-- Purpose:
--   Let an org claim an email domain so users landing from that domain (and
--   NOT already a member of any org) can self-serve a join request. Public
--   email providers (gmail, outlook, …) are rejected application-side; this
--   table is the authorization-of-record for the claim itself.
--
--   Verification is DNS-TXT based:  _conduit-verify.<domain>  =  <token>
--
-- Idempotency:
--   CREATE TABLE / INDEX IF NOT EXISTS. Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS organization_domains (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL,
  verification_token  TEXT NOT NULL,
  verified_at         TIMESTAMPTZ,
  verified_by         TEXT REFERENCES users(id),
  auto_join_role      TEXT NOT NULL DEFAULT 'member',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          TEXT REFERENCES users(id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organization_domains_role_check'
       AND conrelid = 'organization_domains'::regclass
  ) THEN
    ALTER TABLE organization_domains
      ADD CONSTRAINT organization_domains_role_check
      CHECK (auto_join_role IN ('member', 'admin'));
  END IF;
END$$;

-- One claim per (org, domain) regardless of verification state.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_domains_org_domain
  ON organization_domains (org_id, domain);

-- Only one *verified* org per domain (unverified attempts may coexist).
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_domains_verified_domain
  ON organization_domains (domain)
  WHERE verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organization_domains_org
  ON organization_domains (org_id);

COMMIT;

-- =============================================================================
-- End of 013_organization_domains.sql
-- =============================================================================
