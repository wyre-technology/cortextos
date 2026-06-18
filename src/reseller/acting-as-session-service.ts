/**
 * ActingAsSessionService — DB-backed session storage for MSP-as-OPERATOR
 * actingAs state (mig 049 from slice 3 LIFECYCLE-BIND substrate).
 *
 * June 29 launch directive 2026-06-15. Per boss msg-1781534979759 decision:
 * DB-backed (not cookie-only) so admin/system can force-revoke a session
 * mid-flight without reaching client storage. The msp_operator_session_*
 * audit-event union (src/audit/acting-as-audit-types.ts) gets its
 * row-side data from this table.
 *
 * Pure persistence — Auth0/audit/notification side-effects are the
 * operator-routes handler's responsibility.
 */

import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';

/**
 * Revoke-reason discriminators mirror the ratified
 * ActingAsAuditEvent['msp_operator_session_revoked'].revokeReason union
 * (src/audit/acting-as-audit-types.ts) so the row-side data + the audit
 * event payload share a single vocabulary. admin_force_revoked is the
 * out-of-band admin-tooling path (not the 3-check middleware path); kept
 * here so future admin-tooling can write the same column.
 */
export type ActingAsRevokeReason =
  | 'actor_removed_from_reseller'
  | 'role_demoted_below_admin'
  | 'customer_unparented_from_reseller'
  | 'customer_archived'
  // LAYER-C deleted-customer reason (mig 053 deleted_at distinguishability,
  // boss msg-1781750604363 warden VERIFY-1 extension). Fires when the
  // middleware revalidate detects the customer's deleted_at column is
  // set OR the soft-delete route fires its explicit cascade. Lets
  // forensics distinguish suspend-revoke from delete-revoke on the
  // msp_operator_session_revoked event stream.
  | 'customer_deleted'
  | 'admin_force_revoked';

export interface ActingAsSession {
  sessionId: string;
  userId: string;
  viaResellerOrgId: string;
  onBehalfOfOrgId: string;
  startedAt: string;
  endedAt: string | null;
  revokedReason: ActingAsRevokeReason | null;
  ip: string | null;
  userAgent: string | null;
}

interface ActingAsSessionRow {
  session_id: string;
  user_id: string;
  via_reseller_org_id: string;
  on_behalf_of_org_id: string;
  started_at: string;
  ended_at: string | null;
  revoked_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface StartSessionInputs {
  userId: string;
  viaResellerOrgId: string;
  onBehalfOfOrgId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export class ActingAsSessionService {
  private get sql(): Sql {
    return getSql();
  }

  /**
   * Start a new actingAs session. Mints a fresh session_id (used as the
   * signed-cookie value on the response). The caller (operator-routes
   * /switch handler) is responsible for setting the cookie + emitting the
   * msp_operator_session_started audit-event AFTER this returns.
   */
  async start(inputs: StartSessionInputs): Promise<ActingAsSession> {
    const sessionId = `aas_${nanoid(32)}`;
    const rows = await this.sql<ActingAsSessionRow[]>`
      INSERT INTO acting_as_sessions (
        session_id, user_id, via_reseller_org_id, on_behalf_of_org_id, ip, user_agent
      )
      VALUES (
        ${sessionId}, ${inputs.userId}, ${inputs.viaResellerOrgId},
        ${inputs.onBehalfOfOrgId}, ${inputs.ip ?? null}, ${inputs.userAgent ?? null}
      )
      RETURNING *
    `;
    return this.toEntity(rows[0]);
  }

  /**
   * Fetch an ACTIVE session by session_id (ended_at IS NULL). Returns
   * null when the row is missing OR already ended/revoked. Middleware
   * uses this on every authenticated request that carries the
   * actingAs cookie.
   */
  async getActive(sessionId: string): Promise<ActingAsSession | null> {
    if (!sessionId) return null;
    const rows = await this.sql<ActingAsSessionRow[]>`
      SELECT * FROM acting_as_sessions
       WHERE session_id = ${sessionId}
         AND ended_at IS NULL
       LIMIT 1
    `;
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  /**
   * End a session voluntarily (POST /api/reseller/me/customers/exit).
   * Sets ended_at = NOW with NULL revoked_reason — distinguishes
   * actor-initiated exit from system-initiated revoke. Idempotent: a
   * second call on an already-ended row returns the existing entity
   * unchanged (the UPDATE matches zero rows; fall through to fetch).
   */
  async end(sessionId: string): Promise<ActingAsSession | null> {
    const updated = await this.sql<ActingAsSessionRow[]>`
      UPDATE acting_as_sessions
         SET ended_at = NOW()
       WHERE session_id = ${sessionId}
         AND ended_at IS NULL
       RETURNING *
    `;
    if (updated.length > 0) return this.toEntity(updated[0]);
    const existing = await this.sql<ActingAsSessionRow[]>`
      SELECT * FROM acting_as_sessions WHERE session_id = ${sessionId} LIMIT 1
    `;
    return existing[0] ? this.toEntity(existing[0]) : null;
  }

  /**
   * Revoke EVERY active session targeting a given customer org. LAYER-C
   * suspend side-effect cascade (boss msg-1781747367566 warden pre-prep):
   * suspending a customer-org must close the by-construction "suspended
   * but acting_as still works" soft-state hole — every MSP-operator
   * currently impersonating the suspended customer is force-revoked at
   * the next request boundary AND their cookie is invalidated server-
   * side by clearing the active row in this table.
   *
   * Used by the suspend route handler (POST /api/orgs/:orgId/suspend).
   * Idempotent: passing an orgId with zero active sessions returns an
   * empty array; passing an orgId that's already had its sessions
   * revoked returns an empty array (the WHERE clause filters on
   * ended_at IS NULL).
   *
   * Returns the revoked sessions so the route handler can fan out audit
   * events for forensics + ops paging (which actors were mid-impersonation
   * when the revoke happened — important for incident reconstruction).
   *
   * Reason is fixed to a caller-supplied value (typically
   * 'customer_archived' — semantically closest to "the customer org is no
   * longer eligible to be impersonated"; the suspend route uses that
   * one). 'admin_force_revoked' is reserved for the future admin-tooling
   * path that isn't a customer-lifecycle event.
   */
  async revokeAllForCustomerOrg(
    customerOrgId: string,
    reason: ActingAsRevokeReason,
  ): Promise<ActingAsSession[]> {
    const updated = await this.sql<ActingAsSessionRow[]>`
      UPDATE acting_as_sessions
         SET ended_at = NOW(),
             revoked_reason = ${reason}
       WHERE on_behalf_of_org_id = ${customerOrgId}
         AND ended_at IS NULL
       RETURNING *
    `;
    return updated.map((row) => this.toEntity(row));
  }

  /**
   * Revoke a session due to a 3-check failure (LIFECYCLE-BIND
   * HARD-REQUIREMENT). Sets ended_at = NOW + revoked_reason. Same
   * idempotency posture as end() — second call on revoked row no-ops
   * and returns the existing entity.
   */
  async revoke(
    sessionId: string,
    reason: ActingAsRevokeReason,
  ): Promise<ActingAsSession | null> {
    const updated = await this.sql<ActingAsSessionRow[]>`
      UPDATE acting_as_sessions
         SET ended_at = NOW(),
             revoked_reason = ${reason}
       WHERE session_id = ${sessionId}
         AND ended_at IS NULL
       RETURNING *
    `;
    if (updated.length > 0) return this.toEntity(updated[0]);
    const existing = await this.sql<ActingAsSessionRow[]>`
      SELECT * FROM acting_as_sessions WHERE session_id = ${sessionId} LIMIT 1
    `;
    return existing[0] ? this.toEntity(existing[0]) : null;
  }

  private toEntity(row: ActingAsSessionRow): ActingAsSession {
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      viaResellerOrgId: row.via_reseller_org_id,
      onBehalfOfOrgId: row.on_behalf_of_org_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      revokedReason: (row.revoked_reason as ActingAsRevokeReason | null) ?? null,
      ip: row.ip,
      userAgent: row.user_agent,
    };
  }
}
