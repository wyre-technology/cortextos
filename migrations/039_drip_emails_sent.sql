-- =============================================================================
-- Migration:      039_drip_emails_sent.sql
-- Date:           2026-06-01
-- Linear:         WYREAI-94 (sub-issue 76.2 under WYREAI-76 E3 drip-scheduler)
-- Source:         mcp-gateway/src/email/drip-scheduler.ts:ensureTable (port)
--
-- Purpose:
--   Idempotency tracker for the drip-email scheduler (WYREAI-94). One row
--   per (user_id, email_key) records that the scheduler has sent that drip
--   step to that user. The next tick's WHERE clause LEFT JOINs against this
--   table and skips users who already received the step.
--
--   Gateway runs CREATE TABLE IF NOT EXISTS at runtime inside the
--   scheduler's runOnce path (ensureTable). Conduit's discipline is
--   migration-first (see WYREAI-85 / mig 038 retention precedent), so the
--   table lives here instead. The scheduler does not ensureTable at
--   runtime in conduit.
--
-- Schema rationale:
--   - (user_id, email_key) PRIMARY KEY: idempotency by construction. A
--     duplicate INSERT under ON CONFLICT DO NOTHING is the at-least-once
--     send protection -- we never send the same drip step twice.
--   - sent_at default NOW(): audit timestamp. Scheduler does not read it;
--     operators can inspect cadence and detect outages.
--   - REFERENCES users(id) ON DELETE CASCADE: matches GDPR-erasure pattern
--     established by other user-FK tables; user deletion removes drip
--     history.
--
-- No RLS policies: this is a system-table touched only by the drip-scheduler
-- which runs via runAsSystem / BYPASSRLS connection class (mig 029 spine).
-- SCIM tests do not exercise drip-scheduler -- ALLOWED_SKIPS entry added in
-- src/scim/__tests__/integration-harness.ts in the same PR.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS drip_emails_sent (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, email_key)
);

COMMIT;
