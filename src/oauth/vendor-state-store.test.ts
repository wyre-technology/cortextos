import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Tests for VendorOAuthStateStore.
 *
 * Uses an in-memory mock of the postgres.js tagged-template SQL client. The
 * mock recognizes the specific INSERT/DELETE/SELECT patterns that the store
 * issues — it does NOT execute SQL.
 *
 * DI adaptation note (WYREAI-75 PR A canary, test-infra-not-feature-surface):
 * gateway's VendorOAuthStateStore takes sql via constructor; conduit's resolves
 * sql via getSql() against the async request-context (src/db/context.ts —
 * request-path vs system-path connection-class architecture from mig 029).
 * Test ASSERTIONS port verbatim from gateway; test SETUP adapts by mocking
 * the getSql() module-level so each test can swap the mock SQL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentMockSql: any = null;

vi.mock('../db/context.js', () => ({
  getSql: () => {
    if (!currentMockSql) {
      throw new Error('test bug: currentMockSql not set before getSql() call');
    }
    return currentMockSql;
  },
}));

describe('VendorOAuthStateStore', () => {
  let VendorOAuthStateStore: typeof import('./vendor-state-store.js').VendorOAuthStateStore;
  const masterKey = randomBytes(32);

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('MASTER_KEY', masterKey.toString('hex'));
    vi.stubEnv('JWT_SECRET', randomBytes(32).toString('hex'));
    currentMockSql = null;
    const mod = await import('./vendor-state-store.js');
    VendorOAuthStateStore = mod.VendorOAuthStateStore;
  });

  interface StoredRow {
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
    extras: Record<string, unknown> | null;
    expires_at: string;
  }

  function createMockSql() {
    const rows = new Map<string, StoredRow>();

    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');

      if (/CREATE TABLE/i.test(query) || /CREATE INDEX/i.test(query) || /ALTER TABLE/i.test(query)) {
        return Promise.resolve([]);
      }

      if (/INSERT INTO vendor_oauth_flow_states/i.test(query)) {
        // Conduit's INSERT shape (11 values, no extras column) — see
        // src/oauth/vendor-state-store.ts:create(). Gateway's tests had
        // a 12-value destructure with an extras slot; conduit's create()
        // doesn't populate extras at INSERT time, so the destructure here
        // matches conduit's actual emit-order.
        const [
          stateToken,
          userId,
          vendorSlug,
          ct,
          iv,
          tag,
          salt,
          orgId,
          teamId,
          oauthSession,
          expiresAt,
        ] = values as unknown[];
        rows.set(stateToken as string, {
          state_token: stateToken as string,
          user_id: userId as string,
          vendor_slug: vendorSlug as string,
          code_verifier_ciphertext: ct as string,
          code_verifier_iv: iv as string,
          code_verifier_auth_tag: tag as string,
          code_verifier_salt: salt as string,
          org_id: orgId as string | null,
          team_id: teamId as string | null,
          oauth_session: oauthSession as string | null,
          extras: null,
          expires_at: expiresAt as string,
        });
        return Promise.resolve([]);
      }

      if (/DELETE FROM vendor_oauth_flow_states\s+WHERE state_token/i.test(query)) {
        const [stateToken] = values as string[];
        const row = rows.get(stateToken);
        if (row) {
          rows.delete(stateToken);
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      }

      if (/DELETE FROM vendor_oauth_flow_states WHERE expires_at/i.test(query)) {
        const now = Date.now();
        let count = 0;
        for (const [k, v] of rows) {
          if (new Date(v.expires_at).getTime() <= now) {
            rows.delete(k);
            count++;
          }
        }
        const result: unknown[] = [];
        (result as unknown as { count: number }).count = count;
        return Promise.resolve(result);
      }

      throw new Error(`Unexpected query: ${query}`);
    };

    // postgres.js exposes sql.json() as a helper that returns a tagged
    // value the driver later serializes as JSONB. Mimic with a {value} box
    // the INSERT path unwraps.
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({ value: v });
    // Expose internal rows for inspection
    (sql as unknown as { __rows: Map<string, StoredRow> }).__rows = rows;
    return sql as unknown as import('postgres').Sql;
  }

  it('create then consume returns the original verifier', async () => {
    const sql = createMockSql();
    currentMockSql = sql; const store = new VendorOAuthStateStore(masterKey);

    await store.create({
      stateToken: 'state-1',
      userId: 'user-1',
      vendorSlug: 'xero',
      codeVerifier: 'super-secret-verifier',
      orgId: 'org-1',
    });

    const result = await store.consume('state-1');
    expect(result).not.toBeNull();
    expect(result?.codeVerifier).toBe('super-secret-verifier');
    expect(result?.userId).toBe('user-1');
    expect(result?.vendorSlug).toBe('xero');
    expect(result?.orgId).toBe('org-1');
  });

  it('consume is single-use', async () => {
    const sql = createMockSql();
    currentMockSql = sql; const store = new VendorOAuthStateStore(masterKey);
    await store.create({
      stateToken: 's2',
      userId: 'u',
      vendorSlug: 'qbo',
      codeVerifier: 'v',
    });

    const first = await store.consume('s2');
    expect(first).not.toBeNull();
    const second = await store.consume('s2');
    expect(second).toBeNull();
  });

  it('expired states return null from consume', async () => {
    const sql = createMockSql();
    currentMockSql = sql; const store = new VendorOAuthStateStore(masterKey);
    await store.create({
      stateToken: 's3',
      userId: 'u',
      vendorSlug: 'm365',
      codeVerifier: 'v',
      ttlSeconds: -1, // already expired
    });

    const result = await store.consume('s3');
    expect(result).toBeNull();
  });

  it('sweepExpired deletes expired rows', async () => {
    const sql = createMockSql();
    currentMockSql = sql; const store = new VendorOAuthStateStore(masterKey);
    await store.create({
      stateToken: 'fresh',
      userId: 'u',
      vendorSlug: 'xero',
      codeVerifier: 'v',
      ttlSeconds: 600,
    });
    await store.create({
      stateToken: 'stale',
      userId: 'u',
      vendorSlug: 'xero',
      codeVerifier: 'v',
      ttlSeconds: -1,
    });

    const count = await store.sweepExpired();
    expect(count).toBe(1);
    // Fresh entry still consumable
    expect(await store.consume('fresh')).not.toBeNull();
    expect(await store.consume('stale')).toBeNull();
  });

  it('encryption is per-record (different IVs and ciphertexts)', async () => {
    const sql = createMockSql();
    currentMockSql = sql; const store = new VendorOAuthStateStore(masterKey);
    await store.create({ stateToken: 'a', userId: 'u', vendorSlug: 'x', codeVerifier: 'same' });
    await store.create({ stateToken: 'b', userId: 'u', vendorSlug: 'x', codeVerifier: 'same' });

    const internalRows = (sql as unknown as { __rows: Map<string, StoredRow> }).__rows;
    const a = internalRows.get('a')!;
    const b = internalRows.get('b')!;
    expect(a.code_verifier_iv).not.toBe(b.code_verifier_iv);
    expect(a.code_verifier_salt).not.toBe(b.code_verifier_salt);
    expect(a.code_verifier_ciphertext).not.toBe(b.code_verifier_ciphertext);
  });

  it('tampered ciphertext is rejected', async () => {
    const sql = createMockSql();
    currentMockSql = sql; const store = new VendorOAuthStateStore(masterKey);
    await store.create({ stateToken: 't', userId: 'u', vendorSlug: 'x', codeVerifier: 'real' });

    const internalRows = (sql as unknown as { __rows: Map<string, StoredRow> }).__rows;
    const row = internalRows.get('t')!;
    // Flip a byte in the ciphertext
    const buf = Buffer.from(row.code_verifier_ciphertext, 'base64');
    buf[0] ^= 0xff;
    row.code_verifier_ciphertext = buf.toString('base64');

    const result = await store.consume('t');
    expect(result).toBeNull();
  });
});
