/**
 * PostgreSQL-backed store for OAuth 2.1 entities.
 *
 * Manages clients, authorization codes, refresh tokens, and temporary
 * OAuth sessions used during the authorization flow.
 *
 * All operations are asynchronous (postgres.js).
 */

import type postgres from 'postgres';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expiresAt: string;
  vendor?: string;
}

export interface RefreshToken {
  token: string;
  clientId: string;
  userId: string;
  scope: string;
  expiresAt: string;
}

export interface OAuthSession {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  vendor: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TokenStore {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  // -----------------------------------------------------------------------
  // Schema initialisation
  // -----------------------------------------------------------------------

  async initTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS clients (
        client_id       TEXT PRIMARY KEY,
        client_name     TEXT NOT NULL,
        redirect_uris   TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS auth_codes (
        code                  TEXT PRIMARY KEY,
        client_id             TEXT NOT NULL,
        user_id               TEXT NOT NULL,
        redirect_uri          TEXT NOT NULL,
        code_challenge        TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope                 TEXT NOT NULL,
        expires_at            TIMESTAMPTZ NOT NULL,
        vendor                TEXT,
        FOREIGN KEY (client_id) REFERENCES clients(client_id)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token       TEXT PRIMARY KEY,
        client_id   TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        scope       TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (client_id) REFERENCES clients(client_id)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS oauth_sessions (
        session_id            TEXT PRIMARY KEY,
        client_id             TEXT NOT NULL,
        redirect_uri          TEXT NOT NULL,
        state                 TEXT NOT NULL,
        code_challenge        TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scope                 TEXT NOT NULL,
        vendor                TEXT NOT NULL DEFAULT '',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES clients(client_id)
      )
    `;
  }

  // -----------------------------------------------------------------------
  // Clients
  // -----------------------------------------------------------------------

  /** Maximum number of registered OAuth clients allowed. */
  private static readonly MAX_CLIENTS = 10_000;

  async registerClient(clientName: string, redirectUris: string[]): Promise<OAuthClient | null> {
    // Enforce a cap on total registered clients to prevent DB exhaustion
    const [{ count }] = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM clients
    `;
    if (count >= TokenStore.MAX_CLIENTS) {
      return null;
    }

    const clientId = nanoid();
    const now = new Date().toISOString();
    const urisJson = JSON.stringify(redirectUris);

    await this.sql`
      INSERT INTO clients (client_id, client_name, redirect_uris, created_at)
      VALUES (${clientId}, ${clientName}, ${urisJson}, ${now})
    `;

    return { clientId, clientName, redirectUris, createdAt: now };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const rows = await this.sql<
      { client_id: string; client_name: string; redirect_uris: string; created_at: string }[]
    >`
      SELECT * FROM clients WHERE client_id = ${clientId}
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      clientId: row.client_id,
      clientName: row.client_name,
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      createdAt: row.created_at,
    };
  }

  // -----------------------------------------------------------------------
  // Authorization codes (one-time use)
  // -----------------------------------------------------------------------

  async storeAuthCode(code: AuthCode): Promise<void> {
    await this.sql`
      INSERT INTO auth_codes
        (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, vendor)
      VALUES
        (${code.code}, ${code.clientId}, ${code.userId}, ${code.redirectUri}, ${code.codeChallenge}, ${code.codeChallengeMethod}, ${code.scope}, ${code.expiresAt}, ${code.vendor ?? null})
    `;
  }

  /** Retrieves and immediately deletes the code (single-use, atomic). */
  async getAuthCode(code: string): Promise<AuthCode | null> {
    const rows = await this.sql<
      {
        code: string;
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        code_challenge_method: string;
        scope: string;
        expires_at: string;
        vendor: string | null;
      }[]
    >`
      DELETE FROM auth_codes WHERE code = ${code} RETURNING *
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      code: row.code,
      clientId: row.client_id,
      userId: row.user_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      scope: row.scope,
      expiresAt: row.expires_at,
      vendor: row.vendor ?? undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Refresh tokens
  // -----------------------------------------------------------------------

  async storeRefreshToken(token: RefreshToken): Promise<void> {
    await this.sql`
      INSERT INTO refresh_tokens (token, client_id, user_id, scope, expires_at)
      VALUES (${token.token}, ${token.clientId}, ${token.userId}, ${token.scope}, ${token.expiresAt})
    `;
  }

  async getRefreshToken(token: string): Promise<RefreshToken | null> {
    const rows = await this.sql<
      { token: string; client_id: string; user_id: string; scope: string; expires_at: string }[]
    >`
      SELECT * FROM refresh_tokens WHERE token = ${token}
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      token: row.token,
      clientId: row.client_id,
      userId: row.user_id,
      scope: row.scope,
      expiresAt: row.expires_at,
    };
  }

  async revokeRefreshToken(token: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM refresh_tokens WHERE token = ${token}
    `;

    return result.count > 0;
  }

  async revokeAllUserTokens(userId: string): Promise<number> {
    const result = await this.sql`
      DELETE FROM refresh_tokens WHERE user_id = ${userId}
    `;

    return result.count;
  }

  // -----------------------------------------------------------------------
  // OAuth sessions (temporary, for authorization flow)
  // -----------------------------------------------------------------------

  async storeSession(session: OAuthSession): Promise<void> {
    await this.sql`
      INSERT INTO oauth_sessions
        (session_id, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, vendor, created_at)
      VALUES
        (${session.sessionId}, ${session.clientId}, ${session.redirectUri}, ${session.state}, ${session.codeChallenge}, ${session.codeChallengeMethod}, ${session.scope}, ${session.vendor}, ${session.createdAt})
    `;
  }

  /** Retrieves and deletes the session (single-use, atomic). */
  async getSession(sessionId: string): Promise<OAuthSession | null> {
    const rows = await this.sql<
      {
        session_id: string;
        client_id: string;
        redirect_uri: string;
        state: string;
        code_challenge: string;
        code_challenge_method: string;
        scope: string;
        vendor: string;
        created_at: string;
      }[]
    >`
      DELETE FROM oauth_sessions WHERE session_id = ${sessionId} RETURNING *
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      sessionId: row.session_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      state: row.state,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      scope: row.scope,
      vendor: row.vendor,
      createdAt: row.created_at,
    };
  }

  // -----------------------------------------------------------------------
  // Housekeeping
  // -----------------------------------------------------------------------

  /** Remove all expired auth codes, refresh tokens, stale sessions, and orphaned clients. */
  async cleanupExpired(): Promise<void> {
    await this.sql`DELETE FROM auth_codes WHERE expires_at < NOW()`;
    await this.sql`DELETE FROM refresh_tokens WHERE expires_at < NOW()`;

    // Sessions older than 10 minutes are considered stale
    await this.sql`DELETE FROM oauth_sessions WHERE created_at < NOW() - INTERVAL '10 minutes'`;

    // Remove clients older than 90 days that have no active refresh tokens
    await this.sql`
      DELETE FROM clients
      WHERE created_at < NOW() - INTERVAL '90 days'
        AND client_id NOT IN (SELECT DISTINCT client_id FROM refresh_tokens)
    `;
  }
}
