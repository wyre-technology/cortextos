import { getSql, type Sql } from '../db/context.js';

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
  toolArguments: unknown | null;
  promptContext: string | null;
  source: string | null;
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
  tool_arguments: unknown | null;
  prompt_context: string | null;
  source: string | null;
  status_code: number;
  response_time_ms: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AuditService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  private toEntry(row: RequestLogRow): AuditEntry {
    return {
      id: row.id,
      userId: row.user_id,
      userEmail: row.user_email ?? null,
      userName: row.user_name ?? null,
      orgId: row.org_id,
      vendorSlug: row.vendor_slug,
      toolName: row.tool_name,
      toolArguments: row.tool_arguments ?? null,
      promptContext: row.prompt_context ?? null,
      source: row.source ?? null,
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
      // Include entries with matching org_id PLUS personal-credential entries
      // (org_id IS NULL) from current org members — but ONLY for the window
      // during which they were members. Without the joined_at filter, a user
      // who used personal credentials elsewhere before joining would have
      // those historic, unrelated entries become visible to org admins the
      // moment they accept the invite — surprising both the user (history
      // they thought private) and the admin (entries unrelated to this org).
      // Gateway PR #88.
      conditions.push(this.sql`(
        r.org_id = ${params.orgId}
        OR (
          r.org_id IS NULL
          AND r.user_id IN (
            SELECT user_id
            FROM org_members
            WHERE org_id = ${params.orgId}
              AND joined_at <= r.created_at
          )
        )
      )`);
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

    const header = 'timestamp,user_id,user_email,org_id,vendor,tool,source,status,duration_ms,tool_arguments,prompt_context';
    const rows = entries.map((e) =>
      [
        e.createdAt,
        e.userId,
        e.userEmail ?? '',
        e.orgId ?? '',
        e.vendorSlug,
        e.toolName ?? '',
        e.source ?? '',
        e.statusCode,
        e.responseTimeMs ?? '',
        e.toolArguments ? JSON.stringify(e.toolArguments).replace(/,/g, ';') : '',
        e.promptContext ? e.promptContext.replace(/,/g, ';').replace(/\n/g, ' ') : '',
      ].join(','),
    );

    return [header, ...rows].join('\n');
  }
}
