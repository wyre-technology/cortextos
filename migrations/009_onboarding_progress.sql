-- =============================================================================
-- Migration:      009_onboarding_progress.sql
-- Date:           2026-04-20
-- PRD Reference:  prd-onboarding.md §7.5 (progress persistence) and §4.8
--                 (Funnel A files touched). Taskmaster tag `onboarding` / Task #1.
--
-- Purpose:
--   Foundation schema for the three onboarding funnels (A: reseller signup,
--   B: customer provisioning, C: end-user join). Adds:
--     1. organizations.kind            — persona tag for the org ('reseller' |
--                                         'customer'). Distinct from (and in
--                                         addition to) organizations.type added
--                                         in 002; see "Deviation note" below.
--     2. organizations.review_required — gate that blocks addCustomer when the
--                                         async fraud-heuristics job flags a
--                                         reseller org (PRD §4.4).
--     3. organizations.trial_ends_at   — set by the reseller-plan Stripe
--                                         Checkout webhook to NOW()+14 days
--                                         (PRD §4.5, acceptance #5).
--     4. onboarding_progress           — per-(user,org,funnel) wizard resume
--                                         row (PRD §7.5). Writes happen at each
--                                         step boundary; lookup jumps the user
--                                         back to the last incomplete step.
--
-- Idempotency:
--   ADD COLUMN IF NOT EXISTS for all organizations columns, CREATE TABLE /
--   INDEX IF NOT EXISTS for onboarding_progress, and DO-block guards for
--   CHECK constraints (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
--   Safe to re-run.
--
-- Deviation note — `kind` vs `type`:
--   Migration 002 added organizations.type with values ('reseller','customer',
--   'standalone') to satisfy the reseller-tenancy PRD. The onboarding PRD
--   §7.5 / §4.8 explicitly names the column `kind` and restricts it to
--   ('reseller','customer'). Rather than alias one to the other (which would
--   couple two PRDs at the schema level), we add `kind` as a separate nullable
--   column populated by the onboarding service at org creation. A backfill
--   UPDATE copies `type` into `kind` where type IN ('reseller','customer') so
--   existing rows are consistent. A future consolidation can collapse the two.
--
-- Rollback Notes:
--   Greenfield: drop the table, then drop the three columns (in reverse add
--   order). Once onboarding_progress rows or non-null kind/trial_ends_at exist,
--   coordinate per the expand/backfill/contract playbook. No down-migration
--   file — project convention is forward-only single-file migrations (see
--   001_customer_tenants.sql, 002_reseller_tenancy_expand.sql).
--
-- Ordering / Concerns:
--   - onboarding_progress.org_id FKs organizations(id) ON DELETE CASCADE:
--     removing an org cleans up its partial-onboarding rows (PRD §7.5).
--   - user_id is TEXT without an FK (users table may be owned by Auth0 sync
--     and may not always have a row at the instant the funnel starts — e.g.
--     before email verification). Matches the posture of reseller_members'
--     invited_by handling and the onboarding PRD §3 persona flows.
--   - UNIQUE (user_id, org_id, funnel) enforces the "one open progress row per
--     user per org per funnel" invariant from PRD §7.5.
--   - The open-progress partial index supports the resume-lookup hot path
--     (load the incomplete row for a user) without bloating the full index.
--   - Primary key is TEXT to match 001–007 conventions (not gen_random_uuid()
--     UUID as the raw PRD SQL sketch used — the codebase uses TEXT IDs
--     generated application-side; see organizations.id, reseller_members.id).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. organizations.kind
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kind TEXT;

-- Guarded CHECK constraint. Nullable kind is allowed (legacy/standalone rows
-- predate onboarding); when present it must be one of the two onboarding
-- personas defined in PRD §4.8.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'organizations_kind_check'
       AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_kind_check
      CHECK (kind IS NULL OR kind IN ('reseller', 'customer'));
  END IF;
END$$;

-- Defensive backfill: copy type -> kind where type matches an onboarding
-- persona. Leaves 'standalone' rows with kind=NULL.
UPDATE organizations
   SET kind = type
 WHERE kind IS NULL
   AND type IN ('reseller', 'customer');

CREATE INDEX IF NOT EXISTS idx_organizations_kind
  ON organizations (kind)
  WHERE kind IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. organizations.review_required (fraud-flag gate, PRD §4.4)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the only interesting query is "reseller orgs currently under
-- review" for the Wyre-internal admin queue.
CREATE INDEX IF NOT EXISTS idx_organizations_review_required
  ON organizations (id)
  WHERE review_required = TRUE;

-- ---------------------------------------------------------------------------
-- 3. organizations.trial_ends_at (PRD §4.5, acceptance #5)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4. onboarding_progress (PRD §7.5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_progress (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  funnel        TEXT NOT NULL,
  step          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  UNIQUE (user_id, org_id, funnel)
);

-- Guarded funnel CHECK — the three personas from PRD §1.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'onboarding_progress_funnel_check'
       AND conrelid = 'onboarding_progress'::regclass
  ) THEN
    ALTER TABLE onboarding_progress
      ADD CONSTRAINT onboarding_progress_funnel_check
      CHECK (funnel IN ('reseller', 'customer', 'end_user'));
  END IF;
END$$;

-- Resume-lookup hot path: find the user's open (incomplete) progress rows.
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_open
  ON onboarding_progress (user_id)
  WHERE completed_at IS NULL;

-- Secondary lookup: all progress rows for a given org (admin dashboards,
-- audit exports).
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_org
  ON onboarding_progress (org_id);

COMMIT;

-- =============================================================================
-- End of 009_onboarding_progress.sql
-- =============================================================================
