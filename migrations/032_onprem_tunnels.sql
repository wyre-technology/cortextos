-- =============================================================================
-- Migration:      032_onprem_tunnels.sql
-- Date:           2026-05-20
-- Ticket:         On-prem tunnels M1 — tunnel registry (decision (v))
--
-- Purpose:
--   Create onprem_tunnels — the registry backing the on-prem tunnel stream.
--   Each row is one on-prem gateway's persistent WSS tunnel: its per-tunnel
--   identity, the subtenant it is bound to, its capabilities, and liveness.
--
--   Per the M1 scope doc (lantern/memory/2026-05-20-onprem-m1-tunnel-skeleton-
--   scope.md, decision (v) — boss + analyst pre-ack green): tunnel state is
--   conduit state and belongs in the conduit DB, not an in-memory map in the
--   relay process (in-memory loses state on relay restart and is not
--   auditable). This is the connector-doc §5 `connectors` registry.
--
--   The relay tier (a new dedicated Container App — decision (ii)) is the
--   sole writer: it INSERTs on tunnel registration, UPDATEs last_seen on
--   heartbeat, and UPDATEs status on socket drop. The cloud gateway is the
--   reader: routing an on-prem-vendor request looks up the subtenant's live
--   tunnel here. Both the relay and the gateway reach this table system-path
--   (BYPASSRLS) — the relay because it IS the infrastructure owner of the
--   row, the gateway routing read because it is a deliberate operational
--   lookup, not a user-scoped request.
--
-- RLS posture — DELIBERATELY system-only for M1:
--   RLS is ENABLEd + FORCEd per conduit's every-table convention, but NO
--   request-path policies are created. With RLS forced and zero policies,
--   the NOBYPASSRLS request-path role (`conduit_request`) sees ZERO rows —
--   deny-by-default. That is correct for M1: nothing on the user request
--   path touches this table in M1. The relay and the gateway-routing read
--   are system-path. When build-step 4 (cloud-gateway routing) wires the
--   routing read, if any of it runs request-path, the SELECT policy lands
--   THEN and is reviewed by warden at the M1 first PR. Shipping the table
--   deny-by-default now is the conservative, honest scaffold — it cannot
--   leak because nothing request-path can read it.
--
--   The system (migration) role is BYPASSRLS, so the migration runner and
--   the relay/gateway system-path access are unaffected.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Table. One row per on-prem tunnel.
--   id                   — tunnel id (TEXT, app-generated).
--   subtenant_id         — the org/subtenant this tunnel is bound to. A
--                          tunnel serves exactly one subtenant (connector-doc
--                          §5: per-tunnel identity binds to one subtenant).
--   identity_fingerprint — fingerprint of the per-tunnel identity credential.
--                          M1: the signed enrollment token's fingerprint.
--                          M2 (Gate A): the mTLS client-cert fingerprint.
--   capabilities         — JSONB; which on-prem resources this tunnel can
--                          reach. M1: ['echo'] only. M2+: real MCP servers.
--   status               — 'online' | 'offline'. Set 'offline' on socket drop.
--   last_seen            — heartbeat timestamp; liveness / fail-fast basis.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onprem_tunnels (
  id                    TEXT PRIMARY KEY,
  subtenant_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity_fingerprint  TEXT NOT NULL,
  capabilities          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                TEXT NOT NULL DEFAULT 'offline'
                          CHECK (status IN ('online', 'offline')),
  last_seen             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Routing looks up a subtenant's live tunnel — index the hot path.
CREATE INDEX IF NOT EXISTS idx_onprem_tunnels_subtenant
  ON onprem_tunnels (subtenant_id);

-- Liveness sweeps scan by status — index the online subset.
CREATE INDEX IF NOT EXISTS idx_onprem_tunnels_status
  ON onprem_tunnels (status)
  WHERE status = 'online';

-- One tunnel identity is unique — the fingerprint cannot be shared across rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_onprem_tunnels_identity
  ON onprem_tunnels (identity_fingerprint);

-- ---------------------------------------------------------------------------
-- RLS — ENABLEd + FORCEd per conduit convention; deliberately ZERO policies
-- for M1 (deny-by-default for the request-path role). See header. Request-
-- path SELECT policy lands with build-step 4 if/when routing runs request-
-- path, and is warden-reviewed at the M1 first PR.
-- ---------------------------------------------------------------------------
ALTER TABLE onprem_tunnels ENABLE ROW LEVEL SECURITY;
ALTER TABLE onprem_tunnels FORCE ROW LEVEL SECURITY;

COMMIT;

-- =============================================================================
-- End of 032_onprem_tunnels.sql
-- =============================================================================
