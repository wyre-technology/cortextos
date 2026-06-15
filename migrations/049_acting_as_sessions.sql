-- 049_acting_as_sessions.sql
--
-- Multi-IdP foundation slice 3 — actingAs session-handling substrate
-- (LIFECYCLE-BIND HARD-REQUIREMENT, June 29 launch directive 2026-06-15).
--
-- Why this exists (boss msg-1781523125447 + warden Angle 2):
--   PR #386 ratified the actingAs schema + audit-event union; PR #394
--   closed the at-action AUTHORIZATION layer via
--   authorizeResellerAdminOnCustomer. The MISSING piece is the SESSION-
--   HANDLING substrate that POPULATES CallerContext.actingAs from server-
--   side state + revalidates 3 invariants at every read. That's THIS PR.
--
-- DB-backed (not cookie-only) per boss msg-1781534979759 decision:
--   * Server-side revoke: admin/system trigger can force-clear without
--     reaching client storage
--   * Client-side cookie tampering can't bypass — cookie holds session_id;
--     actingAs lives here
--   * Audit-trail by-construction: this row IS the audit record
--   * The msp_operator_session_revoked event variant gets its row-side
--     data from this table
--
-- 3-check revalidation invariants (boss msg-1781370784165 + warden Angle 2):
--   (1) caller.userId still member of via_reseller_org_id with role >= reseller_admin
--   (2) on_behalf_of_org_id still customer of via_reseller_org_id (FK-chain)
--   (3) Customer-org not deleted (parentOrgId chain intact via getOrg returning non-null)
--
--   Any failure -> set ended_at = NOW + revoked_reason = '<discriminator>' +
--   emit msp_operator_session_revoked audit-event.
--
-- Schema rationale:
--   * session_id TEXT PRIMARY KEY: stored in a signed cookie. Lookup-side
--     of the session-cookie pair.
--   * Both org FKs ON DELETE CASCADE: if the reseller OR the customer org
--     is hard-deleted, the session row goes with it. The audit-event was
--     already emitted at start-time; revocation would surface via the
--     middleware's getOrg null-check on next read regardless.
--   * user_id FK ON DELETE CASCADE: same logic — if the user is gone,
--     the session is moot.
--   * ended_at TIMESTAMPTZ NULL: set on voluntary exit (POST /exit) OR
--     on system revoke. NULL = active session.
--   * revoked_reason TEXT NULL: NULL = voluntary exit (POST /exit) OR
--     still-active. Non-null = system revoke (audit discriminator).
--     Values: 'role_lost' | 'no_longer_customer' | 'customer_deleted'.
--
-- Idempotent CREATE TABLE IF NOT EXISTS + DO $$ + pg_constraint-lookup
-- pattern (sibling-shape to migs 046/047/048).

CREATE TABLE IF NOT EXISTS acting_as_sessions (
  session_id            TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via_reseller_org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  on_behalf_of_org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at              TIMESTAMPTZ,
  revoked_reason        TEXT,
  ip                    TEXT,
  user_agent            TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'acting_as_sessions_revoked_reason_check'
  ) THEN
    ALTER TABLE acting_as_sessions
      ADD CONSTRAINT acting_as_sessions_revoked_reason_check
      CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN (
          'actor_removed_from_reseller',
          'role_demoted_below_admin',
          'customer_unparented_from_reseller',
          'customer_archived',
          'admin_force_revoked'
        )
      );
  END IF;
END $$;

-- Hot-path: middleware lookup by session_id (already covered by PRIMARY KEY).

-- Active-session lookup for a user (the operator-routes /exit handler needs
-- to find the user's current active session without a session_id hint).
CREATE INDEX IF NOT EXISTS idx_acting_as_sessions_user_active
  ON acting_as_sessions (user_id) WHERE ended_at IS NULL;
