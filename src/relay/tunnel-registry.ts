/**
 * Tunnel registry — data-access layer over the `onprem_tunnels` table
 * (migration 032).
 *
 * The relay tier is the sole writer: it registers a tunnel on WSS connect,
 * touches `last_seen` on heartbeat, and marks a tunnel offline on socket
 * drop. The cloud gateway is the reader: routing an on-prem-vendor request
 * looks up the subtenant's live tunnel.
 *
 * Per the M1 scope doc (decision (v) — boss + analyst pre-ack green): tunnel
 * state lives in the conduit DB, not an in-memory map — it survives relay
 * restart and is auditable. The relay process additionally keeps the live
 * *socket handles* in memory (a socket is not serializable); this table is
 * the durable registry of which tunnels exist + their liveness, the
 * connector-doc §5 `connectors` registry.
 *
 * All access here is system-path (`runAsSystem`): the relay IS the
 * infrastructure owner of these rows, and the gateway routing read is a
 * deliberate operational lookup, not a user-scoped request. The M1 migration
 * ships RLS deny-by-default (zero request-path policies) — see migration 032
 * header.
 */
import { getSql, runAsSystem } from '../db/context.js';
import { nanoid } from 'nanoid';

export type TunnelStatus = 'online' | 'offline';

export interface OnpremTunnel {
  id: string;
  subtenantId: string;
  identityFingerprint: string;
  capabilities: string[];
  status: TunnelStatus;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TunnelRow {
  id: string;
  subtenant_id: string;
  identity_fingerprint: string;
  capabilities: string[];
  status: TunnelStatus;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTunnel(r: TunnelRow): OnpremTunnel {
  return {
    id: r.id,
    subtenantId: r.subtenant_id,
    identityFingerprint: r.identity_fingerprint,
    capabilities: r.capabilities,
    status: r.status,
    lastSeen: r.last_seen,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Register a tunnel on WSS connect (or re-register an existing identity).
 * Keyed on `identity_fingerprint` (unique) — a reconnecting on-prem gateway
 * presenting the same identity updates its existing row rather than
 * duplicating it. Marks the tunnel `online` and stamps `last_seen`.
 */
export async function registerTunnel(opts: {
  subtenantId: string;
  identityFingerprint: string;
  capabilities: string[];
}): Promise<OnpremTunnel> {
  return runAsSystem(async () => {
    const sql = getSql();
    const id = nanoid();
    const [row] = await sql<TunnelRow[]>`
      INSERT INTO onprem_tunnels (
        id, subtenant_id, identity_fingerprint, capabilities, status, last_seen
      ) VALUES (
        ${id}, ${opts.subtenantId}, ${opts.identityFingerprint},
        ${sql.json(opts.capabilities)}, 'online', NOW()
      )
      ON CONFLICT (identity_fingerprint) DO UPDATE
      SET subtenant_id = EXCLUDED.subtenant_id,
          capabilities = EXCLUDED.capabilities,
          status       = 'online',
          last_seen    = NOW(),
          updated_at   = NOW()
      RETURNING *
    `;
    return rowToTunnel(row);
  });
}

/** Touch `last_seen` on heartbeat. No-op-safe if the tunnel row is gone. */
export async function recordHeartbeat(tunnelId: string): Promise<void> {
  await runAsSystem(async () => {
    const sql = getSql();
    await sql`
      UPDATE onprem_tunnels
      SET last_seen = NOW(), updated_at = NOW()
      WHERE id = ${tunnelId}
    `;
  });
}

/** Mark a tunnel offline on socket drop. */
export async function markOffline(tunnelId: string): Promise<void> {
  await runAsSystem(async () => {
    const sql = getSql();
    await sql`
      UPDATE onprem_tunnels
      SET status = 'offline', updated_at = NOW()
      WHERE id = ${tunnelId}
    `;
  });
}

/**
 * Look up the live (online) tunnel for a subtenant — the routing hot path.
 * Returns null if the subtenant has no online tunnel; the caller fails fast
 * with a clear "tunnel offline" error rather than hanging (connector-doc §5).
 *
 * M1 binds one tunnel per subtenant; if multiple online rows ever exist,
 * the most recently seen wins.
 */
export async function findLiveTunnel(subtenantId: string): Promise<OnpremTunnel | null> {
  return runAsSystem(async () => {
    const sql = getSql();
    const [row] = await sql<TunnelRow[]>`
      SELECT * FROM onprem_tunnels
      WHERE subtenant_id = ${subtenantId} AND status = 'online'
      ORDER BY last_seen DESC NULLS LAST
      LIMIT 1
    `;
    return row ? rowToTunnel(row) : null;
  });
}

/** Fetch a tunnel by id. */
export async function getTunnel(tunnelId: string): Promise<OnpremTunnel | null> {
  return runAsSystem(async () => {
    const sql = getSql();
    const [row] = await sql<TunnelRow[]>`
      SELECT * FROM onprem_tunnels WHERE id = ${tunnelId}
    `;
    return row ? rowToTunnel(row) : null;
  });
}

/**
 * Mark every tunnel whose `last_seen` is older than `staleMs` offline.
 * Run on a relay-side interval as a safety net beneath socket-drop detection:
 * a tunnel whose process died without a clean socket close still flips to
 * offline once its heartbeats stop landing.
 */
export async function sweepStaleTunnels(staleMs: number): Promise<number> {
  return runAsSystem(async () => {
    const sql = getSql();
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const rows = await sql<{ id: string }[]>`
      UPDATE onprem_tunnels
      SET status = 'offline', updated_at = NOW()
      WHERE status = 'online'
        AND (last_seen IS NULL OR last_seen < ${cutoff})
      RETURNING id
    `;
    return rows.length;
  });
}
