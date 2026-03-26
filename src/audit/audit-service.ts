import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminEventType =
  | 'tool_allowlist_updated'
  | 'tool_allowlist_cleared';

export interface AuditEntry {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  orgId: string | null;
  vendorSlug: string;
  toolName: string | null;
  statusCode: number;
  responseTimeMs: number | null;
  createdAt: string;
}

export interface AuditQuery {
  orgId?: string;
  userId?: string;
  vendorSlug?: string;
  startDate?: string;  // ISO 8601
  endDate?: string;    // ISO 8601
  limit?: number;
  offset?: number;
}

interface RequestLogRow {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  org_id: string | null;
  vendor_slug: string;
  tool_name: string | null;
  status_code: number;
  response_time_ms: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AuditService {
  constructor(private sql: postgres.Sql) {}

  private toEntry(row: RequestLogRow): AuditEntry {
    return {
      id: row.id,
      userId: row.user_id,
      userEmail: row.user_email ?? null,
      userName: row.user_name ?? null,
      orgId: row.org_id,
      vendorSlug: row.vendor_slug,
      toolName: row.tool_name,
      statusCode: row.status_code,
      responseTimeMs: row.response_time_ms,
      createdAt: row.created_at,
    };
  }

  async query(params: AuditQuery): Promise<{ entries: AuditEntry[]; total: number }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    // Build dynamic WHERE conditions
    const conditions: ReturnType<typeof this.sql>[] = [];

    if (params.orgId) {
      // Include entries with matching org_id OR personal-credential entries
      // (org_id IS NULL) from users who belong to this org
      conditions.push(this.sql`(r.org_id = ${params.orgId} OR (r.org_id IS NULL AND r.user_id IN (
        SELECT user_id FROM org_members WHERE org_id = ${params.orgId}
      )))`);
    }
    if (params.userId) {
      conditions.push(this.sql`r.user_id = ${params.userId}`);
    }
    if (params.vendorSlug) {
      conditions.push(this.sql`r.vendor_slug = ${params.vendorSlug}`);
    }
    if (params.startDate) {
      conditions.push(this.sql`r.created_at >= ${params.startDate}`);
    }
    if (params.endDate) {
      conditions.push(this.sql`r.created_at <= ${params.endDate}`);
    }

    const where = conditions.length > 0
      ? this.sql`WHERE ${conditions.reduce((a, b) => this.sql`${a} AND ${b}`)}`
      : this.sql``;

    const [countResult, rows] = await Promise.all([
      this.sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM request_log r ${where}`,
      this.sql<RequestLogRow[]>`
        SELECT r.*, u.email AS user_email, u.name AS user_name
        FROM request_log r
        LEFT JOIN users u ON u.id = r.user_id
        ${where}
        ORDER BY r.created_at DESC LIMIT ${limit} OFFSET ${offset}
      `,
    ]);

    return {
      entries: rows.map((r) => this.toEntry(r)),
      total: countResult[0]?.count ?? 0,
    };
  }

  async exportCsv(params: AuditQuery): Promise<string> {
    // Remove pagination for CSV export
    const { entries } = await this.query({ ...params, limit: 10000, offset: 0 });

    const header = 'timestamp,user_id,user_email,org_id,vendor,tool,status,duration_ms';
    const rows = entries.map((e) =>
      [
        e.createdAt,
        e.userId,
        e.userEmail ?? '',
        e.orgId ?? '',
        e.vendorSlug,
        e.toolName ?? '',
        e.statusCode,
        e.responseTimeMs ?? '',
      ].join(','),
    );

    return [header, ...rows].join('\n');
  }
}
