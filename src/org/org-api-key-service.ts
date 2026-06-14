import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getSql, type Sql } from '../db/context.js';

/**
 * OrgApiKeyService — CRUD on the org_api_keys table (mig 048 from sweep-3).
 *
 * Track C reseller-settings API & Webhooks tab (v1 = API keys only,
 * webhooks deferred to v1.1 post-launch). Per boss msg-1781452776703 +
 * sign-axis discipline (msg-1781453109725): plaintext secret returned
 * ONLY from the create response, never from list/get/anywhere. The
 * irreversibility is pinned by a validation-witness test asserting no
 * other surface exposes plaintext after create.
 *
 * Distinct from src/org/org-service.ts createServiceClient (M2M /
 * customer-org-level / OAuth client_credentials consumer) — see mig 048
 * docstring for the rationale.
 */

export interface OrgApiKey {
  id: string;
  orgId: string;
  name: string;
  /** Public prefix (e.g. "ck_a4f9b2") shown in lists. Safe to display. */
  keyPrefix: string;
  createdByUserId: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface OrgApiKeyRow {
  id: string;
  org_id: string;
  name: string;
  key_prefix: string;
  key_secret_hash: string;
  created_by_user_id: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateApiKeyInputs {
  orgId: string;
  name: string;
  createdByUserId: string;
}

/**
 * Return shape for create(). plaintextKey is the ONLY surface that ever
 * carries the secret in plaintext — once consumed, it cannot be re-
 * fetched. Caller MUST show it to the user once + then drop it.
 */
export interface CreatedApiKey {
  apiKey: OrgApiKey;
  /**
   * Full plaintext secret: `<keyPrefix>_<random>`. Returned ONCE from
   * create; never persisted in plaintext; no other method or endpoint
   * exposes this value after create. Sign-axis discipline.
   */
  plaintextKey: string;
}

const PREFIX_NAMESPACE = 'ck'; // "conduit-key" — distinct from svc_ M2M tokens
const PREFIX_RANDOM_BYTES = 6; // 6 chars after the "ck_" namespace
const SECRET_RANDOM_BYTES = 48; // ~288 bits of entropy

function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export class OrgApiKeyService {
  private get sql(): Sql {
    return getSql();
  }

  /**
   * Mint a new API key for the org. Returns the persistable metadata +
   * the one-time plaintext value. Caller MUST surface the plaintext to
   * the user immediately + then drop it; no other method retrieves it.
   */
  async create(inputs: CreateApiKeyInputs): Promise<CreatedApiKey> {
    const id = `apikey_${nanoid()}`;
    const prefix = `${PREFIX_NAMESPACE}_${nanoid(PREFIX_RANDOM_BYTES).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const random = nanoid(SECRET_RANDOM_BYTES);
    const plaintextKey = `${prefix}_${random}`;
    const keySecretHash = hashSecret(plaintextKey);

    const rows = await this.sql<OrgApiKeyRow[]>`
      INSERT INTO org_api_keys (
        id, org_id, name, key_prefix, key_secret_hash, created_by_user_id
      )
      VALUES (
        ${id}, ${inputs.orgId}, ${inputs.name}, ${prefix}, ${keySecretHash}, ${inputs.createdByUserId}
      )
      RETURNING *
    `;
    return { apiKey: this.toEntity(rows[0]), plaintextKey };
  }

  async listForOrg(orgId: string): Promise<OrgApiKey[]> {
    const rows = await this.sql<OrgApiKeyRow[]>`
      SELECT * FROM org_api_keys
       WHERE org_id = ${orgId}
       ORDER BY created_at DESC
    `;
    return rows.map((r) => this.toEntity(r));
  }

  async getById(id: string): Promise<OrgApiKey | null> {
    const rows = await this.sql<OrgApiKeyRow[]>`
      SELECT * FROM org_api_keys WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  /**
   * Soft revoke (sets revoked_at = NOW()). Keeps the row for audit trail
   * + last_used_at history. Idempotent — repeat calls on an already-
   * revoked row no-op.
   */
  async revoke(id: string): Promise<OrgApiKey | null> {
    const rows = await this.sql<OrgApiKeyRow[]>`
      UPDATE org_api_keys
         SET revoked_at = NOW()
       WHERE id = ${id}
         AND revoked_at IS NULL
       RETURNING *
    `;
    if (rows.length === 0) return this.getById(id);
    return this.toEntity(rows[0]);
  }

  /**
   * Verify a plaintext key against the org_api_keys table. Returns the
   * matching key entity when valid + not revoked, null otherwise. Also
   * stamps last_used_at on success so the admin can see activity.
   *
   * Note: the auth-substrate that consumes this lives at the Track C
   * management API gateway (not this slice's scope) — v1 wires the
   * verify path so it's ready when the API gateway slice lands.
   */
  async verify(plaintextKey: string): Promise<OrgApiKey | null> {
    if (!plaintextKey || typeof plaintextKey !== 'string') return null;
    const hash = hashSecret(plaintextKey);
    const rows = await this.sql<OrgApiKeyRow[]>`
      UPDATE org_api_keys
         SET last_used_at = NOW()
       WHERE key_secret_hash = ${hash}
         AND revoked_at IS NULL
       RETURNING *
    `;
    return rows[0] ? this.toEntity(rows[0]) : null;
  }

  private toEntity(row: OrgApiKeyRow): OrgApiKey {
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      createdByUserId: row.created_by_user_id,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }
}
