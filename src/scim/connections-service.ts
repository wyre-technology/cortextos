/**
 * SCIM connection lifecycle and bearer-token verification.
 *
 * Token discipline mirrors src/org/invitation-service.ts:73 (sha256 at rest,
 * plaintext returned to caller exactly once). 32 bytes of CSPRNG randomness,
 * base64url-encoded — same shape as the M2M client_secret in
 * src/oauth/authorization-server.ts.
 *
 * RLS: writes to scim_connections require `conduit.current_user_id` to be a
 * member with admin/owner role of the connection's org (or its parent
 * reseller). The bearer-token verifier path operates without a user session
 * and instead sets `conduit.current_org_id` directly so SCIM handlers can
 * read tenant-scoped tables under RLS.
 */

import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type postgres from 'postgres';
import type {
  IdpType,
  ScimConnection,
  ScimConnectionStatus,
  ScimScope,
} from './types.js';

interface ScimConnectionRow {
  id: string;
  org_id: string;
  scope: string;
  idp_type: string;
  token_hash: string;
  default_role: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
}

function rowToConnection(row: ScimConnectionRow): ScimConnection {
  return {
    id: row.id,
    orgId: row.org_id,
    scope: row.scope as ScimScope,
    idpType: row.idp_type as IdpType,
    tokenHash: row.token_hash,
    defaultRole: row.default_role,
    status: row.status as ScimConnectionStatus,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
  };
}

export function hashScimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a 32-byte secret, base64url-encoded with no padding. Length is
 * 43 chars, fits in any IdP "Secret Token" field, never breaks URL safety.
 */
export function generateScimToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreateConnectionInput {
  orgId: string;
  scope: ScimScope;
  idpType: IdpType;
  defaultRole: string;
  createdBy: string;
}

export interface CreatedConnection {
  connection: ScimConnection;
  /** Plaintext bearer token. Caller must show this to the admin once. */
  token: string;
}

export class ScimConnectionsService {
  constructor(private sql: postgres.Sql) {}

  async create(input: CreateConnectionInput): Promise<CreatedConnection> {
    const id = `scim_${nanoid()}`;
    const token = generateScimToken();
    const tokenHash = hashScimToken(token);

    const rows = await this.sql<ScimConnectionRow[]>`
      INSERT INTO scim_connections
        (id, org_id, scope, idp_type, token_hash, default_role, status, created_by)
      VALUES
        (${id}, ${input.orgId}, ${input.scope}, ${input.idpType},
         ${tokenHash}, ${input.defaultRole}, 'active', ${input.createdBy})
      RETURNING *
    `;

    return { connection: rowToConnection(rows[0]), token };
  }

  /**
   * Verify a bearer token presented by an IdP. Returns null on miss/revoked
   * — handlers translate that into 401. We deliberately do NOT distinguish
   * "unknown token" from "revoked token" in the response.
   */
  async verifyToken(token: string): Promise<ScimConnection | null> {
    const tokenHash = hashScimToken(token);
    const rows = await this.sql<ScimConnectionRow[]>`
      SELECT * FROM scim_connections
       WHERE token_hash = ${tokenHash}
         AND status = 'active'
         AND revoked_at IS NULL
    `;
    return rows[0] ? rowToConnection(rows[0]) : null;
  }

  async getById(id: string): Promise<ScimConnection | null> {
    const rows = await this.sql<ScimConnectionRow[]>`
      SELECT * FROM scim_connections WHERE id = ${id}
    `;
    return rows[0] ? rowToConnection(rows[0]) : null;
  }

  async listForOrg(orgId: string): Promise<ScimConnection[]> {
    const rows = await this.sql<ScimConnectionRow[]>`
      SELECT * FROM scim_connections
       WHERE org_id = ${orgId}
       ORDER BY created_at DESC
    `;
    return rows.map(rowToConnection);
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE scim_connections
         SET status = 'revoked',
             revoked_at = NOW()
       WHERE id = ${id}
         AND status = 'active'
    `;
    return result.count > 0;
  }

  async recordSyncSuccess(id: string): Promise<void> {
    await this.sql`
      UPDATE scim_connections
         SET last_sync_at = NOW(),
             last_error = NULL
       WHERE id = ${id}
    `;
  }

  async recordSyncError(id: string, error: string): Promise<void> {
    // Truncate to keep last_error bounded; we never log secrets here, but
    // belt-and-suspenders against an exception message embedding a payload.
    const truncated = error.length > 1000 ? `${error.slice(0, 1000)}…` : error;
    await this.sql`
      UPDATE scim_connections
         SET last_error = ${truncated}
       WHERE id = ${id}
    `;
  }
}
