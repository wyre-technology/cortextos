-- =============================================================================
-- Migration:      028_user_email_case_insensitive.sql
-- Date:           2026-05-16
-- Ticket:         Phase 5 migration identity-binding fix
--
-- Purpose:
--   Make user-email uniqueness case-insensitive, and clean up the duplicate
--   user rows the case-SENSITIVE gap already produced.
--
--   Background: conduit resolves a login to a user row, and the Phase 5
--   data migration keyed migrated users on mcp-gateway-era subject ids. A
--   conduit SSO login under a different id — plus an email whose CASE
--   differed from the migrated row (e.g. `Aaron@` vs `aaron@`) — created a
--   second, membership-less `users` row, so the migrated person logged in
--   to an empty account. The companion code change (auth0.ts / azure-ad.ts
--   adopt-by-lower(email)) stops new duplicates being created; this
--   migration removes the ones already created and makes a recurrence
--   structurally impossible.
--
-- Two steps:
--   (1) Collapse each lower(email) collision group to ONE row — a keep-one
--       floor that never deletes the last row for an email. A membership-
--       bearing row is preferred as the keeper; with no membership-bearing
--       row the oldest is kept; a group with MORE THAN ONE membership-
--       bearing row is left untouched so step (2) fails loudly instead of
--       this migration guessing which to drop. See the step (1) comment.
--   (2) Replace the non-unique lower(email) lookup index with a UNIQUE one,
--       so a case-variant duplicate cannot be inserted again.
--
-- Idempotency: the dedup CTE is naturally re-runnable (no collisions left ->
--   nothing to delete); DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT
--   EXISTS. Safe to re-run.
--
-- Rollback: DROP the unique index, recreate the non-unique
--   idx_users_lower_email. Deleted rows are not restored — they are
--   membership-less login-strays; any ON DELETE CASCADE children went with
--   them (see the step (1) comment on FK behaviour).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Collapse lower(email) collision groups to one row each
-- ---------------------------------------------------------------------------
-- Each lower(email) collision group is reduced to exactly ONE surviving row.
-- This is a keep-one floor: the step never deletes the last row for an email.
--   - group has exactly one membership-bearing row  -> keep it, delete the
--     membership-less rest (the login-strays);
--   - group has zero membership-bearing rows        -> keep the oldest
--     (MIN created_at), delete the rest — still never deletes everything;
--   - group has more than one membership-bearing row -> delete NOTHING; the
--     CREATE UNIQUE INDEX below then fails loudly. Two rows that both carry
--     membership is not a stray-duplicate this migration may resolve by
--     guessing — it is surfaced for a human.
--
-- FK behaviour when a deleted stray is referenced elsewhere is NOT uniform,
-- so this step makes no loud-abort promise: a users(id) child on
-- ON DELETE CASCADE (e.g. credentials) is deleted along with the stray; a
-- column with no FK at all (e.g. credit_ledger.user_id) is left dangling;
-- only a NO ACTION / RESTRICT reference would abort the migration. This is
-- accepted — a genuine membership-less login-stray's child rows are
-- themselves junk created by that stray login, so cascading or dangling
-- them is correct cleanup, not data loss. The membership check is the real
-- safeguard: a row with any org/team/reseller membership is never deleted
-- unless it is the >1-membership case, which aborts loud instead.
WITH ranked AS (
  SELECT u.id,
         lower(u.email) AS lemail,
         u.created_at,
         (   EXISTS (SELECT 1 FROM org_members      m WHERE m.user_id = u.id)
          OR EXISTS (SELECT 1 FROM org_team_members m WHERE m.user_id = u.id)
          OR EXISTS (SELECT 1 FROM reseller_members m WHERE m.user_id = u.id)
         ) AS has_membership
    FROM users u
),
collision_groups AS (
  SELECT lemail,
         COUNT(*) FILTER (WHERE has_membership) AS membership_rows
    FROM ranked
   GROUP BY lemail
  HAVING COUNT(*) > 1
),
-- One keeper per eligible group (<= 1 membership-bearing row): the
-- membership-bearing row when there is one, otherwise the oldest row.
keepers AS (
  SELECT DISTINCT ON (r.lemail) r.id
    FROM ranked r
    JOIN collision_groups g ON g.lemail = r.lemail
   WHERE g.membership_rows <= 1
   ORDER BY r.lemail, r.has_membership DESC, r.created_at ASC, r.id ASC
)
DELETE FROM users u
 USING collision_groups g
 WHERE lower(u.email) = g.lemail
   AND g.membership_rows <= 1
   AND u.id NOT IN (SELECT id FROM keepers);

-- ---------------------------------------------------------------------------
-- 2. Case-insensitive uniqueness on email
-- ---------------------------------------------------------------------------
-- idx_users_lower_email already exists as a NON-unique lookup index — that
-- is how the duplicate above was allowed in. Replace it with a UNIQUE index
-- on the same expression: it serves the same lookups AND blocks recurrence.
DROP INDEX IF EXISTS idx_users_lower_email;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ---------------------------------------------------------------------------
-- 3. Apply-time audit
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_is_unique BOOLEAN;
  v_dupes     INTEGER;
BEGIN
  -- The lower(email) index exists AND is unique.
  SELECT i.indisunique INTO v_is_unique
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = 'users_email_lower_key';
  IF NOT COALESCE(v_is_unique, false) THEN
    RAISE EXCEPTION 'mig 028 audit: users_email_lower_key missing or not unique';
  END IF;

  -- No lower(email) collisions remain.
  SELECT COUNT(*) INTO v_dupes FROM (
    SELECT 1 FROM users GROUP BY lower(email) HAVING COUNT(*) > 1
  ) d;
  IF v_dupes <> 0 THEN
    RAISE EXCEPTION 'mig 028 audit: % lower(email) collision group(s) still present', v_dupes;
  END IF;
END$$;

COMMIT;
