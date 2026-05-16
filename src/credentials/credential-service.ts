import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { encrypt as encryptPayload, decrypt as decryptPayload } from './crypto.js';

/** Public interface for a stored vendor credential (camelCase). */
export interface StoredVendorCredential {
  id: string;
  scopeId: string; // userId for personal creds, orgId for org creds
  vendorSlug: string;
  encryptedData: string; // base64
  iv: string; // base64
  authTag: string; // base64
  salt: string; // base64
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Raw row shape coming out of PostgreSQL (snake_case column names). */
interface CredentialRow {
  id: string;
  user_id: string;
  vendor_slug: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
  created_at: string;
  updated_at: string;
}

/** Raw row shape for org_credentials table. */
interface OrgCredentialRow {
  id: string;
  org_id: string;
  vendor_slug: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Raw row shape for org_team_credentials table. */
interface TeamCredentialRow {
  id: string;
  team_id: string;
  org_id: string;
  vendor_slug: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Raw row shape for reseller_shared_vendor_grants table. */
interface ResellerSharedVendorGrantRow {
  id: string;
  reseller_org_id: string;
  customer_org_id: string;
  vendor_slug: string;
  enabled: boolean;
}

/**
 * Result of resolving a credential for an org+vendor request.
 *
 * Includes provenance — whether the credential is owned by the requesting
 * customer org directly, or accessed via a reseller's shared grant — so that
 * downstream callers can emit audit records distinguishing the two paths.
 */
export interface ResolvedCredential {
  /** Decrypted credential key/value pairs. */
  data: Record<string, string>;
  /** Vendor the credential belongs to. */
  vendorSlug: string;
  /** The org_id whose stored org_credentials row supplied the data. */
  ownerOrgId: string;
  /** How the credential was resolved. */
  source: 'customer' | 'reseller_grant';
  /**
   * Grant row ID when `source === 'reseller_grant'`, otherwise null.
   * Required for audit logging of cross-org credential usage.
   */
  grantId: string | null;
}

/** Raw row shape for service_client_credentials table. */
interface ServiceClientCredentialRow {
  id: string;
  client_id: string;
  org_id: string;
  vendor_slug: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
  salt: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Service for encrypting, storing, and retrieving vendor API credentials.
 *
 * Each credential set is encrypted with AES-256-GCM using a per-user key
 * derived from the application master key via PBKDF2.
 */
export class CredentialService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  private masterKey: Buffer;

  constructor() {
    this.masterKey = Buffer.from(config.masterKey, 'hex');
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  async initTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS credentials (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        vendor_slug    TEXT NOT NULL,
        encrypted_data TEXT NOT NULL,
        iv             TEXT NOT NULL,
        auth_tag       TEXT NOT NULL,
        salt           TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, vendor_slug)
      )
    `;
  }

  async initTeamCredentialTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS org_team_credentials (
        id             TEXT PRIMARY KEY,
        team_id        TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
        org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vendor_slug    TEXT NOT NULL,
        encrypted_data TEXT NOT NULL,
        iv             TEXT NOT NULL,
        auth_tag       TEXT NOT NULL,
        salt           TEXT NOT NULL,
        created_by     TEXT NOT NULL REFERENCES users(id),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(team_id, vendor_slug)
      )
    `;
  }

  async initServiceClientCredentialTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS service_client_credentials (
        id             TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL REFERENCES service_clients(client_id) ON DELETE CASCADE,
        org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vendor_slug    TEXT NOT NULL,
        encrypted_data TEXT NOT NULL,
        iv             TEXT NOT NULL,
        auth_tag       TEXT NOT NULL,
        salt           TEXT NOT NULL,
        created_by     TEXT NOT NULL REFERENCES users(id),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(client_id, vendor_slug)
      )
    `;
  }

  // ---------------------------------------------------------------------------
  // Crypto helpers — thin wrappers over src/credentials/crypto.ts so that
  // OAuth flow-state storage and credential storage share the same envelope.
  // ---------------------------------------------------------------------------

  /** Encrypt arbitrary credential data with AES-256-GCM, scope-bound to userId/orgId. */
  private encrypt(
    data: Record<string, string>,
    scopeId: string,
  ): { encryptedData: string; iv: string; authTag: string; salt: string } {
    const payload = encryptPayload(this.masterKey, scopeId, JSON.stringify(data));
    return {
      encryptedData: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.authTag,
      salt: payload.salt,
    };
  }

  /** Decrypt a stored credential back to its original key/value pairs. */
  private decrypt(stored: StoredVendorCredential): Record<string, string> | null {
    try {
      const plaintext = decryptPayload(this.masterKey, stored.scopeId, {
        ciphertext: stored.encryptedData,
        iv: stored.iv,
        authTag: stored.authTag,
        salt: stored.salt,
      });
      return JSON.parse(plaintext) as Record<string, string>;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Row mapping
  // ---------------------------------------------------------------------------

  /** Map a snake_case PostgreSQL row to the camelCase public interface. */
  private toCredential(row: CredentialRow): StoredVendorCredential {
    return {
      id: row.id,
      scopeId: row.user_id, // user_id is the scope for personal credentials
      vendorSlug: row.vendor_slug,
      encryptedData: row.encrypted_data,
      iv: row.iv,
      authTag: row.auth_tag,
      salt: row.salt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Store or update credentials for a user + vendor combination.
   *
   * If credentials already exist they are re-encrypted with a fresh salt/IV
   * and the row is upserted in place.
   *
   * @returns The credential row ID (existing or newly generated).
   */
  async store(
    userId: string,
    vendorSlug: string,
    data: Record<string, string>,
  ): Promise<string> {
    const { encryptedData, iv, authTag, salt } = this.encrypt(data, userId);
    const id = nanoid();

    const result = await this.sql<{ id: string }[]>`
      INSERT INTO credentials (id, user_id, vendor_slug, encrypted_data, iv, auth_tag, salt)
      VALUES (${id}, ${userId}, ${vendorSlug}, ${encryptedData}, ${iv}, ${authTag}, ${salt})
      ON CONFLICT (user_id, vendor_slug) DO UPDATE SET
        encrypted_data = EXCLUDED.encrypted_data,
        iv             = EXCLUDED.iv,
        auth_tag       = EXCLUDED.auth_tag,
        salt           = EXCLUDED.salt,
        updated_at     = NOW()
      RETURNING id
    `;

    return result[0].id;
  }

  /**
   * Retrieve and decrypt credentials for a user + vendor combination.
   *
   * @returns The decrypted key/value pairs, or `null` if no credentials exist.
   */
  async get(userId: string, vendorSlug: string): Promise<Record<string, string> | null> {
    const rows = await this.sql<CredentialRow[]>`
      SELECT * FROM credentials WHERE user_id = ${userId} AND vendor_slug = ${vendorSlug}
    `;

    const row = rows[0];
    if (!row) {
      return null;
    }

    return this.decrypt(this.toCredential(row));
  }

  /**
   * List all vendor slugs for which a user has stored credentials.
   *
   * No decryption is performed.
   */
  async listVendors(userId: string): Promise<string[]> {
    const rows = await this.sql<{ vendor_slug: string }[]>`
      SELECT vendor_slug FROM credentials WHERE user_id = ${userId} ORDER BY vendor_slug
    `;

    return rows.map((r) => r.vendor_slug);
  }

  /**
   * Delete credentials for a user + vendor combination.
   *
   * @returns `true` if a row was deleted, `false` if nothing matched.
   */
  async delete(userId: string, vendorSlug: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM credentials WHERE user_id = ${userId} AND vendor_slug = ${vendorSlug}
    `;

    return result.count > 0;
  }

  /**
   * Check whether credentials exist for a user + vendor combination.
   */
  async has(userId: string, vendorSlug: string): Promise<boolean> {
    const [{ count }] = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM credentials WHERE user_id = ${userId} AND vendor_slug = ${vendorSlug}
    `;

    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // Org credentials — same encryption model, scoped by orgId
  // ---------------------------------------------------------------------------

  private toOrgCredential(row: OrgCredentialRow): StoredVendorCredential {
    return {
      id: row.id,
      scopeId: row.org_id, // org_id is the scope for org credentials
      vendorSlug: row.vendor_slug,
      encryptedData: row.encrypted_data,
      iv: row.iv,
      authTag: row.auth_tag,
      salt: row.salt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async storeOrgCredential(
    orgId: string,
    vendorSlug: string,
    data: Record<string, string>,
    createdBy: string,
  ): Promise<string> {
    const { encryptedData, iv, authTag, salt } = this.encrypt(data, orgId);
    const id = nanoid();

    const result = await this.sql<{ id: string }[]>`
      INSERT INTO org_credentials (id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt, created_by)
      VALUES (${id}, ${orgId}, ${vendorSlug}, ${encryptedData}, ${iv}, ${authTag}, ${salt}, ${createdBy})
      ON CONFLICT (org_id, vendor_slug) DO UPDATE SET
        encrypted_data = EXCLUDED.encrypted_data,
        iv             = EXCLUDED.iv,
        auth_tag       = EXCLUDED.auth_tag,
        salt           = EXCLUDED.salt,
        created_by     = EXCLUDED.created_by,
        updated_at     = NOW()
      RETURNING id
    `;

    return result[0].id;
  }

  async getOrgCredential(orgId: string, vendorSlug: string): Promise<Record<string, string> | null> {
    const rows = await this.sql<OrgCredentialRow[]>`
      SELECT * FROM org_credentials WHERE org_id = ${orgId} AND vendor_slug = ${vendorSlug}
    `;

    const row = rows[0];
    if (!row) return null;

    return this.decrypt(this.toOrgCredential(row));
  }

  async deleteOrgCredential(orgId: string, vendorSlug: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_credentials WHERE org_id = ${orgId} AND vendor_slug = ${vendorSlug}
    `;
    return result.count > 0;
  }

  async listOrgVendors(orgId: string): Promise<string[]> {
    const rows = await this.sql<{ vendor_slug: string }[]>`
      SELECT vendor_slug FROM org_credentials WHERE org_id = ${orgId} ORDER BY vendor_slug
    `;
    return rows.map((r) => r.vendor_slug);
  }

  // ---------------------------------------------------------------------------
  // Reseller-shared credential resolution (PRD §5.3 / §7)
  //
  // Resolution order for a customer org requesting a vendor credential:
  //   1. The customer's own org_credentials row, if any.
  //   2. The reseller_shared_vendor_grants opt-in, falling through to the
  //      reseller's org_credentials row for the same vendor.
  //   3. null — caller handles the no-credential path.
  //
  // Standalone orgs and reseller orgs have no step-2 path; their own
  // org_credentials row is the only source.
  // ---------------------------------------------------------------------------

  /**
   * Resolve a vendor credential for a given org, following the customer →
   * reseller-grant fallback chain.
   *
   * @returns A {@link ResolvedCredential} describing the provenance and
   *          decrypted data, or `null` if neither the customer nor any
   *          enabled reseller grant supplies one.
   */
  async resolveForOrgAndVendor(
    orgId: string,
    vendorSlug: string,
  ): Promise<ResolvedCredential | null> {
    // Step 1: customer's own org_credentials row.
    const ownRows = await this.sql<OrgCredentialRow[]>`
      SELECT * FROM org_credentials
      WHERE org_id = ${orgId} AND vendor_slug = ${vendorSlug}
    `;

    const ownRow = ownRows[0];
    if (ownRow) {
      const data = this.decrypt(this.toOrgCredential(ownRow));
      if (data) {
        return {
          data,
          vendorSlug,
          ownerOrgId: orgId,
          source: 'customer',
          grantId: null,
        };
      }
    }

    // Step 2: enabled reseller grant for (customer_org_id, vendor_slug).
    const grantRows = await this.sql<ResellerSharedVendorGrantRow[]>`
      SELECT id, reseller_org_id, customer_org_id, vendor_slug, enabled
      FROM reseller_shared_vendor_grants
      WHERE customer_org_id = ${orgId}
        AND vendor_slug = ${vendorSlug}
        AND enabled = TRUE
      LIMIT 1
    `;

    const grant = grantRows[0];
    if (!grant) {
      return null;
    }

    const resellerRows = await this.sql<OrgCredentialRow[]>`
      SELECT * FROM org_credentials
      WHERE org_id = ${grant.reseller_org_id} AND vendor_slug = ${vendorSlug}
    `;

    const resellerRow = resellerRows[0];
    if (!resellerRow) {
      return null;
    }

    const data = this.decrypt(this.toOrgCredential(resellerRow));
    if (!data) {
      return null;
    }

    return {
      data,
      vendorSlug,
      ownerOrgId: grant.reseller_org_id,
      source: 'reseller_grant',
      grantId: grant.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Team credentials — same encryption model, scoped by teamId
  // ---------------------------------------------------------------------------

  private toTeamCredential(row: TeamCredentialRow): StoredVendorCredential {
    return {
      id: row.id,
      scopeId: row.team_id,
      vendorSlug: row.vendor_slug,
      encryptedData: row.encrypted_data,
      iv: row.iv,
      authTag: row.auth_tag,
      salt: row.salt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async storeTeamCredential(
    teamId: string,
    orgId: string,
    vendorSlug: string,
    data: Record<string, string>,
    createdBy: string,
  ): Promise<string> {
    const { encryptedData, iv, authTag, salt } = this.encrypt(data, teamId);
    const id = nanoid();

    const result = await this.sql<{ id: string }[]>`
      INSERT INTO org_team_credentials (id, team_id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt, created_by)
      VALUES (${id}, ${teamId}, ${orgId}, ${vendorSlug}, ${encryptedData}, ${iv}, ${authTag}, ${salt}, ${createdBy})
      ON CONFLICT (team_id, vendor_slug) DO UPDATE SET
        encrypted_data = EXCLUDED.encrypted_data,
        iv             = EXCLUDED.iv,
        auth_tag       = EXCLUDED.auth_tag,
        salt           = EXCLUDED.salt,
        created_by     = EXCLUDED.created_by,
        updated_at     = NOW()
      RETURNING id
    `;

    return result[0].id;
  }

  async getTeamCredential(teamId: string, vendorSlug: string): Promise<Record<string, string> | null> {
    const rows = await this.sql<TeamCredentialRow[]>`
      SELECT * FROM org_team_credentials WHERE team_id = ${teamId} AND vendor_slug = ${vendorSlug}
    `;

    const row = rows[0];
    if (!row) return null;

    return this.decrypt(this.toTeamCredential(row));
  }

  async deleteTeamCredential(teamId: string, vendorSlug: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_team_credentials WHERE team_id = ${teamId} AND vendor_slug = ${vendorSlug}
    `;
    return result.count > 0;
  }

  async listTeamVendors(teamId: string): Promise<string[]> {
    const rows = await this.sql<{ vendor_slug: string }[]>`
      SELECT vendor_slug FROM org_team_credentials WHERE team_id = ${teamId} ORDER BY vendor_slug
    `;
    return rows.map((r) => r.vendor_slug);
  }

  // ---------------------------------------------------------------------------
  // Service client credentials — same encryption model, scoped by clientId
  // ---------------------------------------------------------------------------

  private toServiceClientCredential(row: ServiceClientCredentialRow): StoredVendorCredential {
    return {
      id: row.id,
      scopeId: row.client_id,
      vendorSlug: row.vendor_slug,
      encryptedData: row.encrypted_data,
      iv: row.iv,
      authTag: row.auth_tag,
      salt: row.salt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async storeServiceClientCredential(
    clientId: string,
    orgId: string,
    vendorSlug: string,
    data: Record<string, string>,
    createdBy: string,
  ): Promise<string> {
    const { encryptedData, iv, authTag, salt } = this.encrypt(data, clientId);
    const id = nanoid();

    const result = await this.sql<{ id: string }[]>`
      INSERT INTO service_client_credentials (id, client_id, org_id, vendor_slug, encrypted_data, iv, auth_tag, salt, created_by)
      VALUES (${id}, ${clientId}, ${orgId}, ${vendorSlug}, ${encryptedData}, ${iv}, ${authTag}, ${salt}, ${createdBy})
      ON CONFLICT (client_id, vendor_slug) DO UPDATE SET
        encrypted_data = EXCLUDED.encrypted_data,
        iv             = EXCLUDED.iv,
        auth_tag       = EXCLUDED.auth_tag,
        salt           = EXCLUDED.salt,
        created_by     = EXCLUDED.created_by,
        updated_at     = NOW()
      RETURNING id
    `;

    return result[0].id;
  }

  async getServiceClientCredential(clientId: string, vendorSlug: string): Promise<Record<string, string> | null> {
    const rows = await this.sql<ServiceClientCredentialRow[]>`
      SELECT * FROM service_client_credentials WHERE client_id = ${clientId} AND vendor_slug = ${vendorSlug}
    `;

    const row = rows[0];
    if (!row) return null;

    return this.decrypt(this.toServiceClientCredential(row));
  }

  async deleteServiceClientCredential(clientId: string, vendorSlug: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM service_client_credentials WHERE client_id = ${clientId} AND vendor_slug = ${vendorSlug}
    `;
    return result.count > 0;
  }

  async listServiceClientVendors(clientId: string): Promise<string[]> {
    const rows = await this.sql<{ vendor_slug: string }[]>`
      SELECT vendor_slug FROM service_client_credentials WHERE client_id = ${clientId} ORDER BY vendor_slug
    `;
    return rows.map((r) => r.vendor_slug);
  }
}
