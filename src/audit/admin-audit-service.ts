import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminEventType =
  | 'member_invited'
  | 'member_removed'
  | 'invitation_accepted'
  | 'invitation_revoked'
  | 'org_credential_created'
  | 'org_credential_deleted'
  | 'role_changed'
  | 'org_updated'
  | 'org_deleted'
  | 'billing_plan_changed'
  | 'server_access_granted'
  | 'server_access_revoked'
  | 'server_access_bulk_set'
  | 'service_client_created'
  | 'service_client_revoked'
  | 'team_created'
  | 'team_renamed'
  | 'team_deleted'
  | 'team_member_added'
  | 'team_member_removed'
  | 'team_server_access_granted'
  | 'team_server_access_revoked'
  | 'log_shipping_destination_created'
  | 'log_shipping_destination_updated'
  | 'log_shipping_destination_deleted'
  | 'scim_connection_created'
  | 'scim_connection_revoked';

export interface AdminAuditEntry {
  id: string;
  orgId: string;
  actorId: string;
  actorEmail: string | null;
  actorName: string | null;
  targetId: string | null;
  targetEmail: string | null;
  targetName: string | null;
  eventType: AdminEventType;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminAuditQuery {
  orgId: string;
  eventType?: string;
  actorId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

interface AdminAuditRow {
  id: string;
  org_id: string;
  actor_id: string;
  actor_email: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_email: string | null;
  target_name: string | null;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AdminAuditService {
  constructor(private sql: postgres.Sql) {}

  private toEntry(row: AdminAuditRow): AdminAuditEntry {
    return {
      id: row.id,
      orgId: row.org_id,
      actorId: row.actor_id,
      actorEmail: row.actor_email ?? null,
      actorName: row.actor_name ?? null,
      targetId: row.target_id,
      targetEmail: row.target_email ?? null,
      targetName: row.target_name ?? null,
      eventType: row.event_type as AdminEventType,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
    };
  }

  async log(entry: {
    orgId: string;
    actorId: string;
    targetId?: string;
    eventType: AdminEventType;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const id = crypto.randomUUID();
    await this.sql`
      INSERT INTO admin_audit_log (id, org_id, actor_id, target_id, event_type, metadata)
      VALUES (
        ${id},
        ${entry.orgId},
        ${entry.actorId},
        ${entry.targetId ?? null},
        ${entry.eventType},
        ${entry.metadata ? this.sql.json(entry.metadata as Record<string, unknown> & postgres.JSONValue) : null}
      )
    `;
  }

  async query(params: AdminAuditQuery): Promise<{ entries: AdminAuditEntry[]; total: number }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    const conditions: ReturnType<typeof this.sql>[] = [
      this.sql`a.org_id = ${params.orgId}`,
    ];

    if (params.eventType) {
      conditions.push(this.sql`a.event_type = ${params.eventType}`);
    }
    if (params.actorId) {
      conditions.push(this.sql`a.actor_id = ${params.actorId}`);
    }
    if (params.startDate) {
      conditions.push(this.sql`a.created_at >= ${params.startDate}`);
    }
    if (params.endDate) {
      conditions.push(this.sql`a.created_at <= ${params.endDate}`);
    }

    const where = this.sql`WHERE ${conditions.reduce((a, b) => this.sql`${a} AND ${b}`)}`;

    const [countResult, rows] = await Promise.all([
      this.sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM admin_audit_log a ${where}`,
      this.sql<AdminAuditRow[]>`
        SELECT a.*,
          actor.email AS actor_email, actor.name AS actor_name,
          target.email AS target_email, target.name AS target_name
        FROM admin_audit_log a
        LEFT JOIN users actor ON actor.id = a.actor_id
        LEFT JOIN users target ON target.id = a.target_id
        ${where}
        ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}
      `,
    ]);

    return {
      entries: rows.map((r) => this.toEntry(r)),
      total: countResult[0]?.count ?? 0,
    };
  }

  async exportCsv(params: AdminAuditQuery): Promise<string> {
    const { entries } = await this.query({ ...params, limit: 10000, offset: 0 });

    const header = 'timestamp,org_id,actor,actor_email,target,target_email,event_type,metadata';
    const rows = entries.map((e) =>
      [
        e.createdAt,
        e.orgId,
        e.actorId,
        e.actorEmail ?? '',
        e.targetId ?? '',
        e.targetEmail ?? '',
        e.eventType,
        e.metadata ? JSON.stringify(e.metadata).replace(/,/g, ';') : '',
      ].join(','),
    );

    return [header, ...rows].join('\n');
  }

  async cleanupAdminAuditLog(retentionDays = 90): Promise<number> {
    const result = await this.sql`
      DELETE FROM admin_audit_log
      WHERE created_at < NOW() - ${retentionDays + ' days'}::interval
    `;
    return result.count;
  }
}
