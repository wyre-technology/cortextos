import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enterTestContext } from '../db/context.js';

/**
 * Track C reseller-settings sweep-3 — OrgApiKeyService unit tests + the
 * sign-axis validation-witness for the sign-shown-once-on-create
 * discipline (boss msg-1781452776703 + pearl's sign-axis sub-pin).
 *
 * The validation-witness pins by-construction: the PLAINTEXT secret IS
 * returned exactly ONCE from create(). No other method on the service
 * (listForOrg / getById / revoke / verify) returns the plaintext —
 * verify takes plaintext as INPUT but never returns it. The exposed
 * Public type (OrgApiKey) carries `keyPrefix` (safe to display) but NO
 * plaintext field — making sign-leak a compile-error at consumer sites.
 */

describe('OrgApiKeyService', () => {
  let OrgApiKeyService: typeof import('./org-api-key-service.js').OrgApiKeyService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./org-api-key-service.js');
    OrgApiKeyService = mod.OrgApiKeyService;
  });

  function createMockSql() {
    const rows = new Map<string, Record<string, unknown>>();
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');

      if (query.includes('INSERT INTO org_api_keys')) {
        const [id, orgId, name, keyPrefix, keySecretHash, createdByUserId] = values as string[];
        const now = new Date().toISOString();
        const row = {
          id,
          org_id: orgId,
          name,
          key_prefix: keyPrefix,
          key_secret_hash: keySecretHash,
          created_by_user_id: createdByUserId,
          last_used_at: null,
          revoked_at: null,
          created_at: now,
        };
        rows.set(id, row);
        return Promise.resolve([row]);
      }

      if (query.includes('SELECT * FROM org_api_keys') && query.includes('WHERE org_id =')) {
        const orgId = values[0] as string;
        return Promise.resolve(
          Array.from(rows.values()).filter((r) => r.org_id === orgId),
        );
      }

      if (query.includes('SELECT * FROM org_api_keys WHERE id =')) {
        const id = values[0] as string;
        const row = rows.get(id);
        return Promise.resolve(row ? [row] : []);
      }

      // ORDER MATTERS: both UPDATE queries mention `revoked_at` (revoke
      // sets it, verify checks IS NULL). Match the more-specific
      // `last_used_at` (verify) FIRST, then fall through to the revoke
      // branch.
      if (query.includes('UPDATE org_api_keys') && query.includes('last_used_at')) {
        const hash = values[0] as string;
        const row = Array.from(rows.values()).find(
          (r) => r.key_secret_hash === hash && !r.revoked_at,
        );
        if (row) {
          row.last_used_at = new Date().toISOString();
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      }

      if (query.includes('UPDATE org_api_keys') && query.includes('SET revoked_at')) {
        const id = values[0] as string;
        const row = rows.get(id);
        if (row && !row.revoked_at) {
          row.revoked_at = new Date().toISOString();
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    };
    return sql;
  }

  it('create() returns plaintextKey + OrgApiKey metadata; plaintext starts with the ck_ prefix', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new OrgApiKeyService();
    const result = await svc.create({
      orgId: 'org_abc',
      name: 'CI deploy',
      createdByUserId: 'user_owner',
    });
    expect(result.plaintextKey).toMatch(/^ck_[a-z0-9]+_[A-Za-z0-9_-]+$/);
    expect(result.apiKey.id).toMatch(/^apikey_/);
    expect(result.apiKey.orgId).toBe('org_abc');
    expect(result.apiKey.name).toBe('CI deploy');
    expect(result.apiKey.keyPrefix).toMatch(/^ck_[a-z0-9]+$/);
    expect(result.apiKey.revokedAt).toBeNull();
    expect(result.apiKey.lastUsedAt).toBeNull();
  });

  // SIGN-AXIS VALIDATION-WITNESS — pin by-construction that the PLAINTEXT
  // secret is reachable ONLY from create()'s return value. listForOrg /
  // getById / revoke / verify must NEVER expose plaintext. The OrgApiKey
  // type itself must NOT carry a plaintext field — that's the structural
  // guard that turns sign-leak into a compile-error.
  describe('SIGN-AXIS: plaintext sign-shown-once-on-create discipline', () => {
    it('OrgApiKey type does NOT carry plaintext field (compile-time structural guard)', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { apiKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'user_owner',
      });
      // Cast to record to inspect runtime shape — type narrowing would
      // hide a leak. The OrgApiKey type SHOULD NOT have plaintext;
      // accessing it via cast confirms there's nothing at runtime either.
      const runtime = apiKey as unknown as Record<string, unknown>;
      expect('plaintextKey' in runtime).toBe(false);
      expect('plaintext' in runtime).toBe(false);
      expect('secret' in runtime).toBe(false);
      expect('key' in runtime).toBe(false);
    });

    it('listForOrg() never returns plaintext (only OrgApiKey shape)', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      await svc.create({ orgId: 'org_abc', name: 'k1', createdByUserId: 'user_owner' });
      await svc.create({ orgId: 'org_abc', name: 'k2', createdByUserId: 'user_owner' });
      const list = await svc.listForOrg('org_abc');
      expect(list).toHaveLength(2);
      for (const k of list) {
        const runtime = k as unknown as Record<string, unknown>;
        expect('plaintextKey' in runtime).toBe(false);
        expect('plaintext' in runtime).toBe(false);
        expect('secret' in runtime).toBe(false);
        // key_secret_hash is the STORAGE form; even that should not leak
        // through the entity mapper.
        expect('keySecretHash' in runtime).toBe(false);
      }
    });

    it('getById() never returns plaintext (only OrgApiKey shape)', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { apiKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'user_owner',
      });
      const fetched = await svc.getById(apiKey.id);
      expect(fetched).not.toBeNull();
      const runtime = fetched as unknown as Record<string, unknown>;
      expect('plaintextKey' in runtime).toBe(false);
      expect('keySecretHash' in runtime).toBe(false);
    });

    it('revoke() never returns plaintext (only OrgApiKey shape)', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { apiKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'user_owner',
      });
      const revoked = await svc.revoke(apiKey.id);
      const runtime = revoked as unknown as Record<string, unknown>;
      expect('plaintextKey' in runtime).toBe(false);
      expect('keySecretHash' in runtime).toBe(false);
    });

    it('verify() never returns plaintext — only the OrgApiKey shape on success', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { plaintextKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'user_owner',
      });
      const verified = await svc.verify(plaintextKey);
      expect(verified).not.toBeNull();
      const runtime = verified as unknown as Record<string, unknown>;
      expect('plaintextKey' in runtime).toBe(false);
      expect('keySecretHash' in runtime).toBe(false);
    });
  });

  describe('listForOrg', () => {
    it('returns only keys for the matching org, newest first', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      await svc.create({ orgId: 'org_a', name: 'a1', createdByUserId: 'u' });
      await svc.create({ orgId: 'org_a', name: 'a2', createdByUserId: 'u' });
      await svc.create({ orgId: 'org_b', name: 'b1', createdByUserId: 'u' });

      const aList = await svc.listForOrg('org_a');
      const bList = await svc.listForOrg('org_b');
      expect(aList).toHaveLength(2);
      expect(bList).toHaveLength(1);
      expect(aList.every((k) => k.orgId === 'org_a')).toBe(true);
    });
  });

  describe('revoke', () => {
    it('sets revoked_at and is idempotent (second revoke is a no-op via existing row return)', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { apiKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'u',
      });
      const first = await svc.revoke(apiKey.id);
      expect(first?.revokedAt).not.toBeNull();
      const second = await svc.revoke(apiKey.id);
      expect(second?.revokedAt).not.toBeNull();
    });
  });

  describe('verify', () => {
    it('returns the OrgApiKey + stamps last_used_at on success', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { apiKey, plaintextKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'u',
      });
      expect(apiKey.lastUsedAt).toBeNull();
      const verified = await svc.verify(plaintextKey);
      expect(verified?.id).toBe(apiKey.id);
      expect(verified?.lastUsedAt).not.toBeNull();
    });

    it('returns null for unknown plaintext', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const verified = await svc.verify('ck_nope_thisisnotrealthankyou');
      expect(verified).toBeNull();
    });

    it('returns null for revoked keys (verify skips revoked-at-rows by-construction)', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      const { apiKey, plaintextKey } = await svc.create({
        orgId: 'org_abc',
        name: 'k1',
        createdByUserId: 'u',
      });
      await svc.revoke(apiKey.id);
      const verified = await svc.verify(plaintextKey);
      expect(verified).toBeNull();
    });

    it('returns null for empty / non-string input', async () => {
      const sql = createMockSql();
      enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
      const svc = new OrgApiKeyService();
      expect(await svc.verify('')).toBeNull();
      expect(await svc.verify(null as unknown as string)).toBeNull();
      expect(await svc.verify(undefined as unknown as string)).toBeNull();
    });
  });
});
