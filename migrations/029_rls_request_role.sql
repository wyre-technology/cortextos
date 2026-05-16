-- =============================================================================
-- Migration:      029_rls_request_role.sql
-- Date:           2026-05-16
-- Ticket:         RLS request-path enforcement (two-connection-class)
--
-- Purpose:
--   Wire database privileges for the NOBYPASSRLS request-path role.
--
--   Background: conduit's RLS policies (migration 007 onward) only enforce
--   when the connection runs as a role that is BOTH a non-owner AND
--   NOBYPASSRLS. Production historically connected as a single BYPASSRLS
--   role, so every RLS policy was a silent no-op. The gateway now opens two
--   connection classes (see src/db/context.ts):
--     - system-path  — BYPASSRLS, for migrations / boot DDL / the webhook;
--     - request-path — a NOBYPASSRLS role, `conduit_request`, used for every
--       authenticated HTTP request, so RLS policies actually filter rows.
--
--   This migration does NOT create the `conduit_request` role. CREATE ROLE
--   needs superuser and a login password that must never live in a committed
--   file — that is an infra / runbook step (see
--   docs/operations/rls-request-role.md). What this migration does, against
--   whatever `conduit_request` the operator provisioned:
--
--   (1) If the role exists: GRANT it DML on every current table, USAGE/SELECT
--       on sequences, EXECUTE on functions, USAGE on the schema. The GRANT
--       only lets the role ISSUE statements — RLS still filters every row the
--       statement touches. A role with no GRANT cannot run RLS-filtered
--       queries at all; a role with GRANT but NOBYPASSRLS runs them filtered.
--   (2) ALTER DEFAULT PRIVILEGES so tables / sequences / functions created by
--       the system (migration) role in FUTURE migrations are auto-granted to
--       `conduit_request` — a future migration never has to remember to
--       re-grant.
--   (3) Audit: fail the migration loudly if `conduit_request` exists but
--       carries BYPASSRLS. A BYPASSRLS request role silently re-creates the
--       exact no-op this whole effort removes; that misconfiguration must
--       stop the boot, not pass quietly.
--
-- Ordering requirement (production):
--   `conduit_request` MUST exist before the image carrying this migration
--   first boots — the GRANT branch is a one-shot (migrations apply once by
--   filename). If the role is absent at apply time the migration is a
--   NOTICE-only no-op: that is the documented dev / CI posture, where a
--   single superuser role runs everything and RLS is a BYPASSRLS no-op. See
--   the runbook for the create-role-first sequence.
--
-- Idempotency: every statement is guarded or naturally re-runnable. Safe to
--   re-run. Rollback: REVOKE the grants; drop the default-privilege entries.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Grant request-path privileges on existing objects
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit_request') THEN
    GRANT USAGE ON SCHEMA public TO conduit_request;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO conduit_request;
    GRANT USAGE, SELECT                ON ALL SEQUENCES   IN SCHEMA public TO conduit_request;
    GRANT EXECUTE                      ON ALL FUNCTIONS   IN SCHEMA public TO conduit_request;
    RAISE NOTICE 'mig 029: granted request-path privileges to conduit_request';
  ELSE
    RAISE NOTICE 'mig 029: role conduit_request absent — skipping grants (dev/CI RLS-noop posture)';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. Auto-grant future objects created by the system (migration) role
-- ---------------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES applies to objects created by the CURRENT role
-- (the migration runner's system role). It errors if the grantee role is
-- absent, so it is guarded by the same existence check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conduit_request') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO conduit_request;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT                  ON SEQUENCES TO conduit_request;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE                        ON FUNCTIONS TO conduit_request;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. Audit — a BYPASSRLS *or SUPERUSER* request role defeats the two-role model
-- ---------------------------------------------------------------------------
-- A superuser bypasses RLS unconditionally, independent of the rolbypassrls
-- flag — so checking rolbypassrls alone would pass a conduit_request that was
-- provisioned as a superuser. Both attributes must be clear.
DO $$
DECLARE
  v_bypassrls BOOLEAN;
  v_super     BOOLEAN;
BEGIN
  SELECT rolbypassrls, rolsuper INTO v_bypassrls, v_super
    FROM pg_roles WHERE rolname = 'conduit_request';
  IF v_bypassrls IS TRUE OR v_super IS TRUE THEN
    RAISE EXCEPTION 'mig 029 audit: role conduit_request has BYPASSRLS or '
      'SUPERUSER — request-path RLS would be a silent no-op. Recreate the '
      'role with NOBYPASSRLS and no SUPERUSER (see '
      'docs/operations/rls-request-role.md).';
  END IF;
END$$;

COMMIT;
