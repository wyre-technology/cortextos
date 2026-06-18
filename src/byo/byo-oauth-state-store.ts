/**
 * Persistent PKCE flow-state store for the BYOMCP OAuth flow (WYREAI-187).
 *
 * The BYO OAuth authorize step and its callback can land on different replicas,
 * so the per-flow secrets cannot live in process memory. They live in Postgres
 * (migration 056) keyed by an opaque single-use `state_token`, owner-scoped by
 * RLS (`conduit.current_user_id`), and are atomically consumed on callback.
 *
 * This is the BYO analogue of `src/oauth/vendor-state-store.ts`. The difference:
 * a catalog vendor's client_id + endpoints come from compiled config, so its
 * store only persists the code_verifier; a BYO server's client is registered at
 * runtime (RFC 7591 DCR), so this store also carries the dynamic `client_id`
 * and (for a confidential client) the `client_secret` — both alongside the
 * code_verifier, with the two secrets encrypted at rest (AES-GCM, scope-bound to
 * the owner's user_id) and the byo_server_id the flow is connecting.
 *
 * The discovered authorization-server metadata is deliberately NOT persisted:
 * `completeByoOAuth` re-discovers it from the server's endpoint on callback, so
 * the issuer used for RFC 9207 validation is always fresh.
 */
import { getSql, type Sql } from '../db/context.js';
import { encrypt, decrypt } from '../credentials/crypto.js';

export interface CreateByoStateParams {
  stateToken: string;
  userId: string;
  byoServerId: string;
  clientId: string;
  codeVerifier: string;
  /** Present for a confidential (non-PKCE-only) dynamically-registered client. */
  clientSecret?: string;
  /** TTL in seconds. Defaults to 600 (10 minutes). */
  ttlSeconds?: number;
}

export interface ConsumedByoState {
  userId: string;
  byoServerId: string;
  clientId: string;
  codeVerifier: string;
  clientSecret?: string;
}

/** The encrypted-at-rest portion of a flow state. */
interface ByoStateSecrets {
  codeVerifier: string;
  clientSecret?: string;
}

interface ByoStateRow {
  state_token: string;
  user_id: string;
  byo_server_id: string;
  client_id: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
  expires_at: string;
}

export class ByoOAuthStateStore {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  private readonly masterKey: Buffer;

  constructor(masterKey: Buffer) {
    this.masterKey = masterKey;
  }

  /**
   * Persist a new BYO PKCE flow state. The code_verifier and (if any) the
   * client_secret are encrypted with a key derived from `masterKey || userId`.
   */
  async create(params: CreateByoStateParams): Promise<void> {
    const ttl = params.ttlSeconds ?? 600;
    const secrets: ByoStateSecrets = {
      codeVerifier: params.codeVerifier,
      clientSecret: params.clientSecret,
    };
    const payload = encrypt(this.masterKey, params.userId, JSON.stringify(secrets));
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.sql`
      INSERT INTO byo_oauth_states (
        state_token,
        user_id,
        byo_server_id,
        client_id,
        encrypted_data,
        iv,
        auth_tag,
        salt,
        expires_at
      ) VALUES (
        ${params.stateToken},
        ${params.userId},
        ${params.byoServerId},
        ${params.clientId},
        ${payload.ciphertext},
        ${payload.iv},
        ${payload.authTag},
        ${payload.salt},
        ${expiresAt.toISOString()}
      )
    `;
  }

  /**
   * Atomically consume a flow state: delete the row and return its decrypted
   * payload. Returns null if missing, expired, or undecryptable. `DELETE ...
   * RETURNING *` makes the state single-use even under concurrent callbacks.
   */
  async consume(stateToken: string): Promise<ConsumedByoState | null> {
    const rows = await this.sql<ByoStateRow[]>`
      DELETE FROM byo_oauth_states
      WHERE state_token = ${stateToken}
      RETURNING *
    `;

    const row = rows[0];
    if (!row) return null;

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }

    let secrets: ByoStateSecrets;
    try {
      const json = decrypt(this.masterKey, row.user_id, {
        ciphertext: row.encrypted_data,
        iv: row.iv,
        authTag: row.auth_tag,
        salt: row.salt,
      });
      secrets = JSON.parse(json) as ByoStateSecrets;
    } catch {
      return null;
    }

    return {
      userId: row.user_id,
      byoServerId: row.byo_server_id,
      clientId: row.client_id,
      codeVerifier: secrets.codeVerifier,
      clientSecret: secrets.clientSecret,
    };
  }

  /** Delete all rows whose `expires_at` is in the past. Returns count. */
  async sweepExpired(): Promise<number> {
    const result = await this.sql`
      DELETE FROM byo_oauth_states WHERE expires_at <= NOW()
    `;
    return result.count;
  }
}
