/**
 * OrgIdpConnectionService — CRUD on the org_idp_connections table
 * (migration 047 from slice 7 PR-A foundation).
 *
 * Multi-IdP foundation slice 6+7 PR-B (June 29 launch directive
 * 2026-06-13). The wizard POST handler at
 * /admin/orgs/:orgId/idp-connections calls these methods AFTER the
 * Auth0 createConnection + enableConnection round-trip succeeds, under
 * the BOTH-OR-NEITHER discipline rationale documented at the route
 * layer (sibling-shape to slice-3's createOrg + Auth0Provisioner seam).
 *
 * No Auth0-side calls happen here — that's the wizard handler's
 * responsibility. This service is the persistence-substrate only.
 *
 * Future-PR breadcrumb (per analyst msg 1781370739032 / boss msg
 * 1781370784165): when reseller-self-service IdP connection management
 * lands as a later slice, every request-handler that READS an idp
 * connection on behalf of a reseller-admin acting-on-customer-org MUST
 * revalidate the actingAs invariants (3 checks: member role, FK chain,
 * not-archived) at read time. NOT this slice — platform-admin path only.
 */

import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';

export type IdpConnectionStrategy = 'samlp' | 'oidc';
export type IdpConnectionStatus = 'active' | 'disabled' | 'errored';

export interface OrgIdpConnection {
  id: string;
  orgId: string;
  auth0ConnectionId: string;
  entityId: string;
  strategy: IdpConnectionStrategy;
  displayName: string | null;
  status: IdpConnectionStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface OrgIdpConnectionRow {
  id: string;
  org_id: string;
  auth0_connection_id: string;
  entity_id: string;
  strategy: string;
  display_name: string | null;
  status: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreateOrgIdpConnectionInputs {
  orgId: string;
  auth0ConnectionId: string;
  entityId: string;
  strategy: IdpConnectionStrategy;
  displayName?: string;
  createdByUserId: string;
}

export class OrgIdpConnectionService {
  private get sql(): Sql {
    return getSql();
  }

  async create(inputs: CreateOrgIdpConnectionInputs): Promise<OrgIdpConnection> {
    const id = `idpc_${nanoid()}`;
    const rows = await this.sql<OrgIdpConnectionRow[]>`
      INSERT INTO org_idp_connections (
        id, org_id, auth0_connection_id, entity_id, strategy,
        display_name, status, created_by_user_id
      )
      VALUES (
        ${id}, ${inputs.orgId}, ${inputs.auth0ConnectionId}, ${inputs.entityId},
        ${inputs.strategy}, ${inputs.displayName ?? null},
        'active', ${inputs.createdByUserId}
      )
      RETURNING *
    `;
    return this.toEntity(rows[0]);
  }

  async listForOrg(orgId: string): Promise<OrgIdpConnection[]> {
    const rows = await this.sql<OrgIdpConnectionRow[]>`
      SELECT * FROM org_idp_connections
       WHERE org_id = ${orgId}
       ORDER BY created_at DESC
    `;
    return rows.map((r) => this.toEntity(r));
  }

  async getById(id: string): Promise<OrgIdpConnection | null> {
    const rows = await this.sql<OrgIdpConnectionRow[]>`
      SELECT * FROM org_idp_connections WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  /**
   * Hard delete. Called from the wizard's DELETE handler AFTER the
   * Auth0-side deleteConnection succeeds; the BOTH-OR-NEITHER ordering
   * is reversed vs create (Auth0-first on create, Auth0-first on delete
   * too — same uniform shape, since the catch path is "Auth0 deleted but
   * DB row remains" which is a DB-cleanup problem rather than an orphan-
   * Auth0 problem). Tracked for the slice-6+7 wizard handler.
   */
  async hardDelete(id: string): Promise<void> {
    await this.sql`DELETE FROM org_idp_connections WHERE id = ${id}`;
  }

  private toEntity(row: OrgIdpConnectionRow): OrgIdpConnection {
    return {
      id: row.id,
      orgId: row.org_id,
      auth0ConnectionId: row.auth0_connection_id,
      entityId: row.entity_id,
      strategy: row.strategy as IdpConnectionStrategy,
      displayName: row.display_name,
      status: row.status as IdpConnectionStatus,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
