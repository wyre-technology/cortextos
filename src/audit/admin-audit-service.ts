import type postgres from "postgres";
import { getSql, type Sql } from "../db/context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminEventType =
  | "member_invited"
  | "member_removed"
  | "invitation_accepted"
  | "invitation_revoked"
  | "org_credential_created"
  | "org_credential_deleted"
  // Team + service-client credential CRUD audit (ruby VC1 SOC2 audit-
  // trail gap closure 2026-06-05). org_credential_* event-types above
  // already cover org-scoped creds (fired from src/org/routes.ts route
  // layer); these add coverage for team-scoped + service-client-scoped
  // credential CRUD, which were unaudited at the user-action substrate.
  | "team_credential_created"
  | "team_credential_deleted"
  | "service_client_credential_created"
  | "service_client_credential_deleted"
  // Reseller-channel customer org creation audit (ruby RC3 launch-
  // foundational gap closure 2026-06-05). MSP-side reseller_admin
  // creates a sub-customer org via POST /admin/reseller/:resellerId/
  // customers; this is the first event in the multi-party reseller
  // lifecycle and was previously unaudited.
  | "customer_org_created"
  | "role_changed"
  | "org_updated"
  | "org_deleted"
  | "billing_plan_changed"
  | "server_access_granted"
  | "server_access_revoked"
  | "server_access_bulk_set"
  | "service_client_created"
  | "service_client_revoked"
  | "team_created"
  | "team_renamed"
  | "team_deleted"
  | "team_member_added"
  | "team_member_removed"
  | "team_server_access_granted"
  | "team_server_access_revoked"
  | "log_shipping_destination_created"
  | "log_shipping_destination_updated"
  | "log_shipping_destination_deleted"
  | "scim_connection_created"
  | "scim_connection_revoked"
  | "admin_comp_credits"
  // WYREAI-98 AI MSA consent recording — org_consent_accepted is the
  // org-scoped binding event (first-accept or re-accept after a material
  // change); user_consent_acknowledged is the per-user informational layer
  // logged alongside the binding org-record. Metadata carries the
  // document_url + document_version (SHA256) + document_size_bytes for the
  // audit reader; pearl-side ConsentService.recordOrgConsent + recordUserAcknowledgment
  // both fire one log entry per binding/acknowledgment event.
  | "org_consent_accepted"
  | "user_consent_acknowledged"
  // WYREAI-118 + 119 (E1 admin create-org launch-blocker). Fires when the
  // admin creates an org via POST /admin/orgs with stub-owner placeholder
  // + owner_swap_to_invited invitation. Metadata carries: name, org_type,
  // plan, invited_owner_email, stub_owner_user_id. Pairs with the
  // existing 'invitation_accepted' event at the swap-completion moment
  // (when the invited user accepts and the NARROWED-DELETE atomic-swap
  // replaces the stub).
  | "org_created_by_admin"
  // Multi-IdP foundation slice 6+7 (June 29 launch directive 2026-06-13).
  // Platform-admin pastes SAML metadata XML at the wizard
  // (POST /admin/orgs/:orgId/idp-connections) -> Auth0 createConnection +
  // enableConnection on the org's Auth0 Org peer + INSERT into
  // org_idp_connections (mig 047). Audit-event names per analyst's
  // visible-without-internal-knowledge discipline (msg 1781371246033):
  // 'idp_connection_*' is grep-traceable for future ops without needing
  // to know the wizard surface lives at /admin/orgs/:orgId/idp-connections.
  // Metadata carries: strategy ('samlp'|'oidc'), entity_id,
  // auth0_connection_id, display_name?
  | "idp_connection_created"
  | "idp_connection_deleted"
  // WYREAI-25 (b) EAP slice. Fires when an admin grants or revokes the
  // EAP org_fee waiver via POST /admin/orgs/:orgId/eap-waiver(/revoke).
  // Metadata for the grant carries reason_note (free-form admin note,
  // e.g. "Approved by Aaron via Slack 2026-06-18"). The grant row itself
  // (org_discounts) carries granted_by + granted_at as the customer-
  // facing SoT; this audit-log row is the chronological admin-trail
  // viewer SoT (belt-and-suspenders pattern per ruby msg-1781749672262,
  // distinct read-side consumers, same SoT semantics).
  | "eap_waiver_granted"
  | "eap_waiver_revoked"
  // Track C reseller-settings sweep-3 API & Webhooks tab (June 29
  // launch directive, boss msg-1781452776703 + split-into-substrate-PR-A
  // per Aaron's UI-Figma-first directive msg-1781453810337). Per-reseller-
  // org API key CRUD via the JSON endpoints at
  // POST /api/orgs/:orgId/api-keys + .../revoke. Distinct from the
  // service_client_* events (those are M2M / customer-org-level OAuth
  // tokens; these are reseller-org-level admin script tokens for the
  // Track C management API).
  | "api_key_created"
  | "api_key_revoked"
  // LAYER-C customer-org destructive lifecycle (WYREAI-171 Phase-3 follow-up,
  // boss msg-1781747082572 + warden pre-prep msg-1781747367566). Reseller-
  // admin operating via actingAs binding (or direct customer-owner)
  // suspend/unsuspend/soft-delete/restore a customer-org. Schema is shared
  // (`suspended_at` column from mig 012); the audit event is the
  // discriminator between "operator suspended this customer" vs "operator
  // soft-deleted this customer pending sweeper hard-delete." The
  // 'restored' event covers both unsuspend AND restore-from-soft-delete
  // — forensics can backfill the prior state from the prior event row.
  | "customer_org_suspended"
  | "customer_org_unsuspended"
  | "customer_org_soft_deleted"
  | "customer_org_restored";

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
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

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
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata,
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

  async query(
    params: AdminAuditQuery,
  ): Promise<{ entries: AdminAuditEntry[]; total: number }> {
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

    const where = this
      .sql`WHERE ${conditions.reduce((a, b) => this.sql`${a} AND ${b}`)}`;

    const [countResult, rows] = await Promise.all([
      this.sql<
        { count: number }[]
      >`SELECT COUNT(*)::int AS count FROM admin_audit_log a ${where}`,
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
    const { entries } = await this.query({
      ...params,
      limit: 10000,
      offset: 0,
    });

    const header =
      "timestamp,org_id,actor,actor_email,target,target_email,event_type,metadata";
    const rows = entries.map((e) =>
      [
        e.createdAt,
        e.orgId,
        e.actorId,
        e.actorEmail ?? "",
        e.targetId ?? "",
        e.targetEmail ?? "",
        e.eventType,
        e.metadata ? JSON.stringify(e.metadata).replace(/,/g, ";") : "",
      ].join(","),
    );

    return [header, ...rows].join("\n");
  }

  /**
   * Distinct event types present in the org's audit log. Powers the
   * filter dropdown on /org/reseller/audit (sweep-2 cluster-2 (c),
   * 2026-06-14). Returned in alphabetical order so the dropdown is
   * stable across requests + admin sessions.
   *
   * Scoped by org_id only — same boundary as query(). Empty array when
   * the org has no audit log entries yet.
   */
  async distinctEventTypes(orgId: string): Promise<string[]> {
    const rows = await this.sql<{ event_type: string }[]>`
      SELECT DISTINCT event_type FROM admin_audit_log
      WHERE org_id = ${orgId}
      ORDER BY event_type ASC
    `;
    return rows.map((r) => r.event_type);
  }

  async cleanupAdminAuditLog(retentionDays = 90): Promise<number> {
    const result = await this.sql`
      DELETE FROM admin_audit_log
      WHERE created_at < NOW() - ${retentionDays + " days"}::interval
    `;
    return result.count;
  }
}
