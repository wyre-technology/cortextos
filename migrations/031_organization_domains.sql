-- =============================================================================
-- Migration:      031_organization_domains.sql
-- Date:           2026-05-18
-- Ticket:         GAP-1 — port domain-claim/verify from mcp-gateway to conduit
--
-- Purpose:
--   Create organization_domains — the table backing domain claim / verify and
--   domain-based org auto-join. Ported from mcp-gateway (src/org/domain-
--   service.ts initTables()), where the table has NO row-level security.
--
--   conduit runs RLS (migration 007 onward) on the NOBYPASSRLS request path,
--   so this migration ADDS RLS policies that did not exist on the gateway —
--   they are NET-NEW SECURITY SURFACE, not a copy. The per-org scoping below
--   is the load-bearing part of this port and should be reviewed as new.
--
-- RLS model — who may see / mutate an organization_domains row:
--   The management surface (org admin lists / adds / verifies / deletes a
--   domain for their own org) is org-member-scoped: a row is visible and
--   mutable only to members of its org_id, via conduit_is_member_of_org (the
--   shared SECURITY DEFINER helper from migration 018). The HTTP routes
--   additionally gate on requireOrgRole(admin) at the app layer — RLS is the
--   defense-in-depth floor under that.
--
--   The CLAIM surface is deliberately NOT covered by these policies: claim-
--   eligibility / claim look up a verified domain for a user who is NOT yet a
--   member of the owning org — a member-scoped policy would hide exactly the
--   row the claim flow must find. Those reads are a deliberate cross-org
--   lookup and run system-path (runAsSystem / BYPASSRLS) in domain-service.ts,
--   the same posture conduit uses for every other deliberate cross-tenant
--   read. RLS is therefore correct to scope the request path to org members
--   only; the claim path is intentionally outside it.
--
--   The system (migration) role is BYPASSRLS, so the migration runner, boot
--   DDL, and the runAsSystem claim lookups are unaffected by these policies.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Table. Mirrors the mcp-gateway organization_domains shape 1:1 (id, org_id,
-- domain, verification_token, verified_at, verified_by, auto_join_role,
-- created_at, created_by). FKs reference organizations(id) and users(id),
-- both created by OrgService.initTables() before the migration runner runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_domains (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL,
  verification_token  TEXT NOT NULL,
  verified_at         TIMESTAMPTZ,
  verified_by         TEXT REFERENCES users(id),
  auto_join_role      TEXT NOT NULL DEFAULT 'member'
                        CHECK (auto_join_role IN ('member', 'admin')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          TEXT REFERENCES users(id)
);

-- One claim row per (org, domain); re-adding rotates the token via UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_domains_org_domain
  ON organization_domains (org_id, domain);

-- A domain may be VERIFIED by at most one org. Partial-unique on the verified
-- subset — this is the real race safety net behind domain-service.verify().
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_domains_verified_domain
  ON organization_domains (domain)
  WHERE verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organization_domains_org
  ON organization_domains (org_id);

-- ---------------------------------------------------------------------------
-- RLS — NET-NEW (the gateway table had none). Member-scoped: see header.
-- ENABLE + FORCE matches conduit's other RLS tables; FORCE so the policy
-- applies even to a table owner. The system role stays BYPASSRLS.
-- ---------------------------------------------------------------------------
ALTER TABLE organization_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_domains FORCE ROW LEVEL SECURITY;

-- SELECT — a domain row is visible to members of its org.
DROP POLICY IF EXISTS organization_domains_select ON organization_domains;
CREATE POLICY organization_domains_select ON organization_domains
  FOR SELECT
  USING (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      organization_domains.org_id
    )
  );

-- INSERT — a member may only create a row for their own org.
DROP POLICY IF EXISTS organization_domains_insert ON organization_domains;
CREATE POLICY organization_domains_insert ON organization_domains
  FOR INSERT
  WITH CHECK (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      organization_domains.org_id
    )
  );

-- UPDATE — both USING (rows in scope) and WITH CHECK (no org_id re-pointing
-- out of scope), matching the migration 014/022 UPDATE-policy convention.
DROP POLICY IF EXISTS organization_domains_update ON organization_domains;
CREATE POLICY organization_domains_update ON organization_domains
  FOR UPDATE
  USING (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      organization_domains.org_id
    )
  )
  WITH CHECK (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      organization_domains.org_id
    )
  );

-- DELETE — a member may only delete a row for their own org.
DROP POLICY IF EXISTS organization_domains_delete ON organization_domains;
CREATE POLICY organization_domains_delete ON organization_domains
  FOR DELETE
  USING (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      organization_domains.org_id
    )
  );

COMMIT;

-- =============================================================================
-- End of 031_organization_domains.sql
-- =============================================================================
