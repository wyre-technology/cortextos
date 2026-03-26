import type postgres from 'postgres';
import { nanoid } from 'nanoid';
import type { LogShippingDestination, LogSource, ShippableEvent } from './adapters/types.js';
export type { LogShippingDestination, LogSource, ShippableEvent };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DestinationRow {
  id: string;
  org_id: string;
  label: string;
  platform: string;
  endpoint_url: string;
  config: Record<string, string>;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CursorRow {
  destination_id: string;
  source: string;
  last_shipped_at: string;
}

interface ErrorRow {
  id: string;
  destination_id: string;
  source: string;
  error_message: string;
  occurred_at: string;
}

export interface LogShippingError {
  id: string;
  destinationId: string;
  source: string;
  errorMessage: string;
  occurredAt: string;
}

// Mask sensitive credential fields for API responses
export function maskConfig(config: Record<string, string>): Record<string, string> {
  const sensitiveKeys = ['token', 'password', 'apiKey', 'api_key', 'secret'];
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    masked[k] = sensitiveKeys.includes(k) ? `${v.slice(0, 4)}****` : v;
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LogShippingService {
  constructor(private sql: postgres.Sql) {}

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async initTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS log_shipping_destinations (
        id           TEXT PRIMARY KEY,
        org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        label        TEXT NOT NULL,
        platform     TEXT NOT NULL CHECK (platform IN ('loki', 'graylog', 'logscale')),
        endpoint_url TEXT NOT NULL,
        config       JSONB NOT NULL DEFAULT '{}',
        enabled      BOOLEAN NOT NULL DEFAULT TRUE,
        created_by   TEXT NOT NULL REFERENCES users(id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_log_shipping_destinations_org
        ON log_shipping_destinations(org_id)
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS log_shipping_cursors (
        destination_id TEXT REFERENCES log_shipping_destinations(id) ON DELETE CASCADE,
        source         TEXT CHECK (source IN ('request_log', 'admin_audit_log')),
        last_shipped_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
        PRIMARY KEY (destination_id, source)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS log_shipping_errors (
        id             TEXT PRIMARY KEY,
        destination_id TEXT REFERENCES log_shipping_destinations(id) ON DELETE CASCADE,
        source         TEXT NOT NULL,
        error_message  TEXT NOT NULL,
        occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_log_shipping_errors_dest
        ON log_shipping_errors(destination_id, occurred_at DESC)
    `;
  }

  // -------------------------------------------------------------------------
  // Row mapping
  // -------------------------------------------------------------------------

  private toDest(row: DestinationRow): LogShippingDestination {
    return {
      id: row.id,
      orgId: row.org_id,
      label: row.label,
      platform: row.platform as LogShippingDestination['platform'],
      endpointUrl: row.endpoint_url,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {}),
      enabled: row.enabled,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async create(entry: {
    orgId: string;
    label: string;
    platform: LogShippingDestination['platform'];
    endpointUrl: string;
    config: Record<string, string>;
    createdBy: string;
  }): Promise<LogShippingDestination> {
    const id = nanoid();
    const rows = await this.sql<DestinationRow[]>`
      INSERT INTO log_shipping_destinations
        (id, org_id, label, platform, endpoint_url, config, created_by)
      VALUES (
        ${id}, ${entry.orgId}, ${entry.label}, ${entry.platform},
        ${entry.endpointUrl}, ${this.sql.json(entry.config as Record<string, unknown> & postgres.JSONValue)}, ${entry.createdBy}
      )
      RETURNING *
    `;
    return this.toDest(rows[0]);
  }

  async list(orgId: string): Promise<LogShippingDestination[]> {
    const rows = await this.sql<DestinationRow[]>`
      SELECT * FROM log_shipping_destinations WHERE org_id = ${orgId} ORDER BY created_at
    `;
    return rows.map((r) => this.toDest(r));
  }

  async get(id: string): Promise<LogShippingDestination | null> {
    const rows = await this.sql<DestinationRow[]>`
      SELECT * FROM log_shipping_destinations WHERE id = ${id}
    `;
    return rows[0] ? this.toDest(rows[0]) : null;
  }

  async update(id: string, patch: {
    label?: string;
    endpointUrl?: string;
    config?: Record<string, string>;
  }): Promise<LogShippingDestination | null> {
    const current = await this.get(id);
    if (!current) return null;

    const label = patch.label ?? current.label;
    const endpointUrl = patch.endpointUrl ?? current.endpointUrl;
    // Merge config: existing fields + patch fields (patch wins)
    const config = { ...current.config, ...(patch.config ?? {}) };

    const rows = await this.sql<DestinationRow[]>`
      UPDATE log_shipping_destinations SET
        label = ${label},
        endpoint_url = ${endpointUrl},
        config = ${this.sql.json(config as Record<string, unknown> & postgres.JSONValue)},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? this.toDest(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM log_shipping_destinations WHERE id = ${id}
    `;
    return result.count > 0;
  }

  async setEnabled(id: string, enabled: boolean): Promise<LogShippingDestination | null> {
    const rows = await this.sql<DestinationRow[]>`
      UPDATE log_shipping_destinations SET enabled = ${enabled}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? this.toDest(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // Batch fetch for shipping
  // -------------------------------------------------------------------------

  async listEnabled(): Promise<LogShippingDestination[]> {
    const rows = await this.sql<DestinationRow[]>`
      SELECT * FROM log_shipping_destinations WHERE enabled = TRUE
    `;
    return rows.map((r) => this.toDest(r));
  }

  async getCursor(destinationId: string, source: LogSource): Promise<Date> {
    const rows = await this.sql<CursorRow[]>`
      SELECT last_shipped_at FROM log_shipping_cursors
      WHERE destination_id = ${destinationId} AND source = ${source}
    `;
    return rows[0] ? new Date(rows[0].last_shipped_at) : new Date(0);
  }

  async advanceCursor(destinationId: string, source: LogSource, lastShippedAt: Date): Promise<void> {
    await this.sql`
      INSERT INTO log_shipping_cursors (destination_id, source, last_shipped_at)
      VALUES (${destinationId}, ${source}, ${lastShippedAt.toISOString()})
      ON CONFLICT (destination_id, source) DO UPDATE
        SET last_shipped_at = EXCLUDED.last_shipped_at
    `;
  }

  // Fetch a batch of events from request_log for the given org since the cursor
  async fetchRequestLogBatch(orgId: string, since: Date, limit = 500): Promise<ShippableEvent[]> {
    const rows = await this.sql<{
      id: string; user_id: string; org_id: string | null; vendor_slug: string;
      tool_name: string | null; status_code: number; response_time_ms: number | null;
      created_at: string;
    }[]>`
      SELECT * FROM request_log
      WHERE org_id = ${orgId}
        AND created_at > ${since.toISOString()}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      source: 'request_log' as const,
      payload: {
        user_id: r.user_id,
        org_id: r.org_id,
        vendor_slug: r.vendor_slug,
        tool_name: r.tool_name,
        status_code: r.status_code,
        response_time_ms: r.response_time_ms,
      },
    }));
  }

  // Fetch a batch of events from admin_audit_log for the given org since the cursor
  async fetchAdminAuditLogBatch(orgId: string, since: Date, limit = 500): Promise<ShippableEvent[]> {
    const rows = await this.sql<{
      id: string; org_id: string; actor_id: string; target_id: string | null;
      event_type: string; metadata: Record<string, unknown> | null; created_at: string;
    }[]>`
      SELECT id, org_id, actor_id, target_id, event_type, metadata, created_at
      FROM admin_audit_log
      WHERE org_id = ${orgId}
        AND created_at > ${since.toISOString()}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      source: 'admin_audit_log' as const,
      payload: {
        org_id: r.org_id,
        actor_id: r.actor_id,
        target_id: r.target_id,
        event_type: r.event_type,
        metadata: r.metadata,
      },
    }));
  }

  // -------------------------------------------------------------------------
  // Error ring-buffer
  // -------------------------------------------------------------------------

  async recordError(destinationId: string, source: LogSource, errorMessage: string): Promise<void> {
    const id = nanoid();
    await this.sql`
      INSERT INTO log_shipping_errors (id, destination_id, source, error_message)
      VALUES (${id}, ${destinationId}, ${source}, ${errorMessage})
    `;
    // Prune to last 50 per destination
    await this.sql`
      DELETE FROM log_shipping_errors
      WHERE destination_id = ${destinationId}
        AND id NOT IN (
          SELECT id FROM log_shipping_errors
          WHERE destination_id = ${destinationId}
          ORDER BY occurred_at DESC
          LIMIT 50
        )
    `;
  }

  async getRecentErrors(destinationId: string, limit = 10): Promise<LogShippingError[]> {
    const rows = await this.sql<ErrorRow[]>`
      SELECT * FROM log_shipping_errors
      WHERE destination_id = ${destinationId}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      destinationId: r.destination_id,
      source: r.source,
      errorMessage: r.error_message,
      occurredAt: r.occurred_at,
    }));
  }
}
