-- =============================================================================
-- Migration:      010_customer_sub_orgs.sql
-- Date:           2026-04-20
-- PRD Reference:  prd-onboarding.md §5 (Funnel B — Customer Provisioning),
--                 §5.4 (provisioning transaction), §5.8 (files touched),
--                 §6.4 (end-user join team assignment).
--                 Taskmaster tag `onboarding` / Task #2.
--
-- Purpose:
--   Shape org_invitations for Funnel B customer-admin invites and for Funnel C
--   team-scoped joins:
--     1. org_invitations.intended_role  — role the invitee is assigned on
--                                          acceptance. Funnel B writes 'owner'
--                                          (customer primary admin), Funnel A/C
--                                          team invites default to 'member'
--                                          (PRD §5.4, §6.4).
--     2. org_invitations.team_id        — optional team assignment applied
--                                          when the invite is accepted. FK to
--                                          org_teams(id) ON DELETE SET NULL
--                                          (PRD §6.4).
--     3. Indexes to support the new columns' lookup patterns.
--
--   The orgs.parent_org_id column referenced by PRD §5.8 was already added by
--   migration 002_reseller_tenancy_expand.sql (as organizations.parent_org_id).
--   This migration does NOT redefine it; see "Scope note" below.
--
-- Scope note — parent_org_id already exists:
--   PRD §5.8 reads "orgs.parent_org_id" as if the onboarding migration adds it.
--   The reseller-tenancy workstream landed 002_reseller_tenancy_expand.sql
--   first, which added organizations.parent_org_id (TEXT, self-FK ON DELETE
--   RESTRICT) and the enforce_org_hierarchy trigger. Re-adding the column here
--   would collide, so we only extend org_invitations. The customer sub-org
--   "schema" requirement is therefore satisfied jointly by 002 (parent/type)
--   + 009 (kind/trial_ends_at/review_required) + 010 (invitation enhancements).
--
-- Deviation note — FK target for team_id:
--   The PRD sketch uses "REFERENCES teams(id)". The codebase's team table is
--   actually `org_teams` (see src/org/team-service.ts). We FK to org_teams(id).
--   ON DELETE SET NULL so deleting a team does not destroy outstanding
--   invitations — it just clears the team hint, and the invitee still lands
--   in the org with the default role on acceptance (PRD §6.4 fallback).
--
-- Idempotency:
--   ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DO-block guards on
--   CHECK / FK constraints (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
--   Safe to re-run.
--
-- Rollback Notes:
--   Greenfield: drop indexes, drop FK + CHECK constraints, drop columns.
--   Once invitations carry intended_role='owner' or non-null team_id,
--   coordinate per the expand/backfill/contract playbook. No down-migration
--   file — project convention is forward-only (see 001_customer_tenants.sql).
--
-- Ordering / Concerns:
--   - intended_role has a CHECK constraint matching the roles recognized by
--     MemberService + the PRD §5.4 / §6.4 grammar: 'owner', 'admin', 'member'.
--     Legacy rows (pre-migration) will be NULL; the InvitationService applies
--     the documented default ('member') when NULL at accept time.
--   - team_id is nullable and has no CHECK; the FK + trigger-free design is
--     fine because org_teams.org_id is already constrained to the org.
--     Cross-org team assignment is prevented at the service layer (PRD §8.6
--     multi-tenant isolation — OrgService is the single choke point).
--   - Index on intended_role is partial (WHERE intended_role IS NOT NULL) so
--     the legacy NULL rows don't pay index-maintenance cost.
--   - Index on team_id is partial (WHERE team_id IS NOT NULL) for the same
--     reason; the common query is "outstanding invitations for team T".
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. org_invitations.intended_role (PRD §5.4, §6.4)
-- ---------------------------------------------------------------------------
ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS intended_role TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'org_invitations_intended_role_check'
       AND conrelid = 'org_invitations'::regclass
  ) THEN
    ALTER TABLE org_invitations
      ADD CONSTRAINT org_invitations_intended_role_check
      CHECK (intended_role IS NULL OR intended_role IN ('owner', 'admin', 'member'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. org_invitations.team_id (PRD §6.4 team pre-assignment hint)
-- ---------------------------------------------------------------------------
ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS team_id TEXT;

-- Guarded FK addition. ON DELETE SET NULL: deleting a team preserves the
-- invitation row but clears the team hint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'org_invitations_team_id_fkey'
       AND conrelid = 'org_invitations'::regclass
  ) THEN
    ALTER TABLE org_invitations
      ADD CONSTRAINT org_invitations_team_id_fkey
      FOREIGN KEY (team_id)
      REFERENCES org_teams(id)
      ON DELETE SET NULL;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- Support the "which outstanding invitations grant owner/admin" admin query.
CREATE INDEX IF NOT EXISTS idx_org_invitations_intended_role
  ON org_invitations (intended_role)
  WHERE intended_role IS NOT NULL;

-- Support the "pending invitations for a team" lookup used by the team
-- admin UI and by accept-time team assignment.
CREATE INDEX IF NOT EXISTS idx_org_invitations_team_id
  ON org_invitations (team_id)
  WHERE team_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- End of 010_customer_sub_orgs.sql
-- =============================================================================
