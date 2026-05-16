/**
 * Persistent backing store for vendor PKCE flow state.
 *
 * Replaces the in-memory `Map<state, PendingOAuthState>` that previously
 * lived in `src/web/routes.ts`. The Map breaks horizontal scaling: an
 * OAuth callback can land on a different replica from the one that
 * initiated the flow, and the state lookup fails. With this store, the
 * state lives in Postgres so any replica can resolve it.
 *
 * Schema lives in `migrations/017_mcp_gateway_parity.sql`. The PKCE code
 * verifier is encrypted at rest using `src/credentials/crypto.ts`,
 * scope-bound to the user_id that started the flow.
 */
import { getSql, type Sql } from '../db/context.js';
import { encrypt, decrypt } from '../credentials/crypto.js';

export interface CreateStateParams {
  stateToken: string;
  userId: string;
  vendorSlug: string;
  codeVerifier: string;
  orgId?: string;
  teamId?: string;
  oauthSession?: string;
  /** TTL in seconds. Defaults to 600 (10 minutes). */
  ttlSeconds?: number;
}

export interface ConsumedState {
  userId: string;
  vendorSlug: string;
  codeVerifier: string;
  orgId?: string;
  teamId?: string;
  oauthSession?: string;
}

interface FlowStateRow {
  state_token: string;
  user_id: string;
  vendor_slug: string;
  code_verifier_ciphertext: string;
  code_verifier_iv: string;
  code_verifier_auth_tag: string;
  code_verifier_salt: string;
  org_id: string | null;
  team_id: string | null;
  oauth_session: string | null;
  expires_at: string;
}

export class VendorOAuthStateStore {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  private masterKey: Buffer;

  constructor(masterKey: Buffer) {
    this.masterKey = masterKey;
  }

  /**
   * Persist a new PKCE flow state. The code verifier is encrypted at rest
   * with a key derived from `masterKey || userId`.
   */
  async create(params: CreateStateParams): Promise<void> {
    const ttl = params.ttlSeconds ?? 600;
    const payload = encrypt(this.masterKey, params.userId, params.codeVerifier);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.sql`
      INSERT INTO vendor_oauth_flow_states (
        state_token,
        user_id,
        vendor_slug,
        code_verifier_ciphertext,
        code_verifier_iv,
        code_verifier_auth_tag,
        code_verifier_salt,
        org_id,
        team_id,
        oauth_session,
        expires_at
      ) VALUES (
        ${params.stateToken},
        ${params.userId},
        ${params.vendorSlug},
        ${payload.ciphertext},
        ${payload.iv},
        ${payload.authTag},
        ${payload.salt},
        ${params.orgId ?? null},
        ${params.teamId ?? null},
        ${params.oauthSession ?? null},
        ${expiresAt.toISOString()}
      )
    `;
  }

  /**
   * Atomically consume a flow state: deletes the row and returns the
   * decrypted payload. Returns null if missing or expired.
   *
   * Uses `DELETE ... RETURNING *` so the row can only be consumed once
   * even under concurrent callbacks.
   */
  async consume(stateToken: string): Promise<ConsumedState | null> {
    const rows = await this.sql<FlowStateRow[]>`
      DELETE FROM vendor_oauth_flow_states
      WHERE state_token = ${stateToken}
      RETURNING *
    `;

    const row = rows[0];
    if (!row) return null;

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }

    let codeVerifier: string;
    try {
      codeVerifier = decrypt(this.masterKey, row.user_id, {
        ciphertext: row.code_verifier_ciphertext,
        iv: row.code_verifier_iv,
        authTag: row.code_verifier_auth_tag,
        salt: row.code_verifier_salt,
      });
    } catch {
      return null;
    }

    return {
      userId: row.user_id,
      vendorSlug: row.vendor_slug,
      codeVerifier,
      orgId: row.org_id ?? undefined,
      teamId: row.team_id ?? undefined,
      oauthSession: row.oauth_session ?? undefined,
    };
  }

  /** Delete all rows whose `expires_at` is in the past. Returns count. */
  async sweepExpired(): Promise<number> {
    const result = await this.sql`
      DELETE FROM vendor_oauth_flow_states WHERE expires_at <= NOW()
    `;
    return result.count;
  }
}
