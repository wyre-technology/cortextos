/**
 * BYOMCP server storage (WYREAI-188).
 *
 * Per-user storage for user-supplied ("bring your own") non-catalog MCP
 * servers: endpoint URL + transport + auth headers. Mirrors CredentialService
 * — AES-GCM encryption at rest (crypto.ts), and all reads/writes go through
 * getSql() (the request-path NOBYPASSRLS connection), so the FORCE-RLS policies
 * in migration 055 scope every row to its owner (conduit.current_user_id, the
 * 141 path). One tenant's BYO server is never visible/callable by another.
 *
 * SECURITY: create()/update() run the user-supplied endpoint through
 * validateVendorBaseUrl (SSRF guard) at store time, complementing the
 * transport's guard at fetch time (McpHttpTransport, WYREAI-186). The endpoint
 * is rejected before it is ever persisted, so a stored BYO server can't be a
 * latent SSRF target.
 */
import { getSql, type Sql } from '../db/context.js';
import { encrypt as encryptPayload, decrypt as decryptPayload } from '../credentials/crypto.js';
import { validateVendorBaseUrl } from '../credentials/safe-fetch.js';
import { config } from '../config.js';
import { nanoid } from 'nanoid';

export type ByoTransport = 'streamable-http' | 'sse';

/** Metadata for a stored BYO server — never includes decrypted headers. */
export interface ByoMcpServer {
  id: string;
  name: string;
  endpointUrl: string;
  transport: ByoTransport;
  createdAt: string;
  updatedAt: string;
}

/** A BYO server with its decrypted auth headers, for the transport to use. */
export interface ByoMcpServerWithHeaders extends ByoMcpServer {
  headers: Record<string, string>;
}

export interface ByoMcpServerInput {
  name: string;
  endpointUrl: string;
  transport?: ByoTransport;
  /** Auth headers (e.g. { Authorization: 'Bearer …' }); encrypted at rest. */
  headers?: Record<string, string>;
}

interface Row {
  id: string;
  name: string;
  endpoint_url: string;
  transport: ByoTransport;
  created_at: string;
  updated_at: string;
}

interface SecretRow extends Row {
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
}

export class ByoMcpServerService {
  private readonly masterKey: Buffer;

  constructor() {
    this.masterKey = Buffer.from(config.masterKey, 'hex');
  }

  private get sql(): Sql {
    return getSql();
  }

  /**
   * Boot-time DDL mirror of migration 055 (the app creates tables at startup
   * the same way credential-service does). Migrations remain the source of
   * truth for the RLS policies.
   */
  async initTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS byo_mcp_servers (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        name           TEXT NOT NULL,
        endpoint_url   TEXT NOT NULL,
        transport      TEXT NOT NULL DEFAULT 'streamable-http',
        encrypted_data TEXT NOT NULL,
        iv             TEXT NOT NULL,
        auth_tag       TEXT NOT NULL,
        salt           TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, name)
      )
    `;
  }

  /**
   * Register (or update, by name) a BYO MCP server for a user. Rejects a
   * non-public endpoint before persisting it (SSRF). Returns the row id.
   */
  async create(userId: string, input: ByoMcpServerInput): Promise<string> {
    await validateVendorBaseUrl(input.endpointUrl);

    const transport: ByoTransport = input.transport ?? 'streamable-http';
    const payload = encryptPayload(this.masterKey, userId, JSON.stringify(input.headers ?? {}));
    const id = nanoid();

    const result = await this.sql<{ id: string }[]>`
      INSERT INTO byo_mcp_servers
        (id, user_id, name, endpoint_url, transport, encrypted_data, iv, auth_tag, salt)
      VALUES
        (${id}, ${userId}, ${input.name}, ${input.endpointUrl}, ${transport},
         ${payload.ciphertext}, ${payload.iv}, ${payload.authTag}, ${payload.salt})
      ON CONFLICT (user_id, name) DO UPDATE SET
        endpoint_url   = EXCLUDED.endpoint_url,
        transport      = EXCLUDED.transport,
        encrypted_data = EXCLUDED.encrypted_data,
        iv             = EXCLUDED.iv,
        auth_tag       = EXCLUDED.auth_tag,
        salt           = EXCLUDED.salt,
        updated_at     = NOW()
      RETURNING id
    `;
    return result[0].id;
  }

  /** List a user's BYO servers — metadata only, no decrypted headers. */
  async list(userId: string): Promise<ByoMcpServer[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, name, endpoint_url, transport, created_at, updated_at
      FROM byo_mcp_servers
      WHERE user_id = ${userId}
      ORDER BY name
    `;
    return rows.map(this.toMeta);
  }

  /** Get one BYO server WITH decrypted headers, for the transport to connect. */
  async get(userId: string, id: string): Promise<ByoMcpServerWithHeaders | null> {
    const rows = await this.sql<SecretRow[]>`
      SELECT id, name, endpoint_url, transport, created_at, updated_at,
             encrypted_data, iv, auth_tag, salt
      FROM byo_mcp_servers
      WHERE user_id = ${userId} AND id = ${id}
    `;
    const row = rows[0];
    if (!row) return null;

    const headersJson = decryptPayload(this.masterKey, userId, {
      ciphertext: row.encrypted_data,
      iv: row.iv,
      authTag: row.auth_tag,
      salt: row.salt,
    });
    return {
      ...this.toMeta(row),
      headers: JSON.parse(headersJson) as Record<string, string>,
    };
  }

  /** Delete a user's BYO server. Returns true if a row was removed. */
  async delete(userId: string, id: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM byo_mcp_servers WHERE user_id = ${userId} AND id = ${id}
    `;
    return result.count > 0;
  }

  private toMeta(row: Row): ByoMcpServer {
    return {
      id: row.id,
      name: row.name,
      endpointUrl: row.endpoint_url,
      transport: row.transport,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
