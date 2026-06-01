-- =============================================================================
-- Migration:      038_request_log_retention.sql
-- Date:           2026-06-01
-- Linear:         WYREAI-85 (refile of conduit#231 after 274-commit drift +
--                 slot-022 conflict — see WYREAI-85 description for routing)
-- Compliance:     Notion "Conduit — Compliance Review" D2 (resolved 2026-05-21)
--
-- Purpose:
--   Bound request_log retention to 13 months (395 days). request_log
--   accumulates one row per MCP tool call; without bounded retention we
--   trade storage and blast-radius for forensic depth indefinitely.
--
--   13 months threads the regulatory needle:
--     - SOC 2 CC7.2 — covers the annual evidence cycle with ~1 month of
--       overlap for audit handoff.
--     - EU AI Act Art. 12 — exceeds the ~6-month logging floor with margin.
--     - GDPR Art. 5(1)(e) — defensible storage limitation, justified by
--       legitimate-interest in security forensics; bounded rather than
--       indefinite.
--     - Long enough to reconstruct a slow-burn intrusion that spans an
--       entire reporting period.
--
-- Implementation:
--
--   1. Covering index on request_log(created_at) so the nightly DELETE
--      doesn't sequential-scan a hot table. Existing queries that filter
--      by user/org/vendor keep using their own indexes.
--
--   2. purge_expired_request_log() — SECURITY DEFINER, RETURNS bigint
--      (row count for caller logging/alerts). Emits a RAISE LOG so the
--      sweep is recorded in Postgres logs (observability pipeline
--      ingests these). The function deliberately does NOT write into
--      reseller_admin_audit: that table's FKs (reseller_org_id,
--      actor_user_id) are NOT NULL and require real org/user rows,
--      which a system-level retention job does not have. Inventing
--      synthetic FK targets would be worse than leaving the audit in
--      the Postgres log stream.
--
--      SECURITY DEFINER discipline (3-foot-gun checklist):
--        (a) search_path pinned to `pg_catalog, public` — matches the
--            existing convention in migration 018's helpers and prevents
--            schema-shadow attacks via attacker-controlled schemas in
--            the function's search path.
--        (b) minimum-work body — DELETE + GET DIAGNOSTICS + RAISE LOG +
--            RETURN. No cross-table queries, no mutations beyond the
--            retention sweep itself, no elevated-privilege surface
--            expansion.
--        (c) membership-check correctness — N/A (this is a system
--            retention job, not an authz gate).
--
--   3. REVOKE ALL ON FUNCTION FROM PUBLIC — defense in depth so an
--      app role can only call the function via an explicit GRANT.
--
--   4. pg_cron schedule at 03:17 UTC nightly (off-peak NA/EU/AU/NZ).
--      Conditional on pg_extension — Azure Postgres Flexible Server
--      ships pg_cron; local dev typically does not, in which case the
--      application-side scheduler should invoke the function nightly.
--
--      Local-dev fallback path operator note: after the REVOKE FROM
--      PUBLIC step, only a role with implicit access (cluster admin,
--      Azure's azure_pg_admin in prod, or postgres in local-dev) can
--      invoke the function. In prod this is satisfied automatically
--      because pg_cron runs as cluster-admin. For the local-dev app-
--      side scheduler, the operator must either (a) connect via a
--      system-path role that already has implicit access, or (b) run
--      `GRANT EXECUTE ON FUNCTION purge_expired_request_log() TO
--      <conduit-app-role>;` from a privileged session. The grant is
--      deliberately NOT inlined into this migration so the function's
--      callable surface stays tied to the operator's role-provisioning
--      decision (see mig 029's runbook-as-source-of-truth pattern).
--
-- The retention window (395 days) is intentionally hardcoded. Changing
-- it requires a new migration so the change is reviewable and auditable
-- — more important than the flexibility of a settings row, given how
-- rarely the value should change.
--
-- Reversibility: this migration is reversible. Dropping the function
-- and index has no effect on data. To unwind, drop the cron job, the
-- function, then the index (in that order).
--
-- Cost-shape: one full table scan during initial deployment to build
-- the index; subsequent scans are bounded by the retention window.
--
-- Reconciliation with neighboring migrations on request_log:
--   - 029 RLS request-role — orthogonal; this function is SECURITY
--     DEFINER and bypasses request-role RLS by design.
--   - 030 widens request_log_select reseller-read — orthogonal; this
--     function operates on DELETE, not SELECT, and runs under definer
--     privileges that bypass the policy regardless.
-- =============================================================================

BEGIN;

-- 1. Index to make the nightly retention sweep cheap.
CREATE INDEX IF NOT EXISTS idx_request_log_created_at_retention
  ON request_log (created_at);

-- 2. The retention function.
CREATE OR REPLACE FUNCTION purge_expired_request_log()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  retention_days CONSTANT int := 395;  -- 13 months — see migration header.
  cutoff timestamptz;
  rows_deleted bigint;
BEGIN
  cutoff := now() - make_interval(days => retention_days);

  DELETE FROM request_log WHERE created_at < cutoff;
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;

  -- Audit the sweep via Postgres logs. See migration header for why we
  -- don't write into reseller_admin_audit (NOT NULL FKs on reseller_org_id
  -- and actor_user_id make it the wrong sink for a system-level job).
  RAISE LOG 'request_log.purge cutoff=% rows_deleted=% retention_days=%',
    cutoff, rows_deleted, retention_days;

  RETURN rows_deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_request_log() FROM PUBLIC;

-- 3. Schedule via pg_cron if the extension is installed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'request_log_retention_daily',
      '17 3 * * *',  -- 03:17 UTC daily.
      'SELECT purge_expired_request_log();'
    );
  END IF;
END $$;

COMMIT;
