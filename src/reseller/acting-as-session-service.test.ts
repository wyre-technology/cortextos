import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enterTestContext } from '../db/context.js';

/**
 * ActingAsSessionService unit tests — slice 3 LIFECYCLE-BIND substrate.
 *
 * Service-level contract is small but load-bearing: start/getActive/end/
 * revoke + the row-shape ↔ entity mapper. Real-Postgres FK CASCADE + the
 * revoked_reason CHECK constraint exercise at integration-test layer.
 */

describe('ActingAsSessionService', () => {
  let ActingAsSessionService: typeof import('./acting-as-session-service.js').ActingAsSessionService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./acting-as-session-service.js');
    ActingAsSessionService = mod.ActingAsSessionService;
  });

  function createMockSql() {
    const rows = new Map<string, Record<string, unknown>>();
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?');

      if (q.includes('INSERT INTO acting_as_sessions')) {
        const [sid, uid, vid, oid, ip, ua] = values as Array<string | null>;
        const row = {
          session_id: sid,
          user_id: uid,
          via_reseller_org_id: vid,
          on_behalf_of_org_id: oid,
          started_at: new Date().toISOString(),
          ended_at: null,
          revoked_reason: null,
          ip,
          user_agent: ua,
        };
        rows.set(sid as string, row);
        return Promise.resolve([row]);
      }

      // UPDATE branches must precede the SELECT branches because both
      // queries reference "FROM acting_as_sessions" — match the UPDATE
      // first by checking for SET keyword (function-identity-vs-object-
      // identity sub-pin banked 2026-06-13).
      if (q.includes('UPDATE acting_as_sessions') && q.includes('revoked_reason =')) {
        // SQL param order: revoked_reason FIRST (SET clause), session_id
        // SECOND (WHERE clause). Function-identity-vs-object-identity
        // sub-pin: destructure carefully.
        const [reason, sid] = values as string[];
        const row = rows.get(sid);
        if (row && !row.ended_at) {
          row.ended_at = new Date().toISOString();
          row.revoked_reason = reason;
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      }

      if (q.includes('UPDATE acting_as_sessions') && q.includes('ended_at = NOW()')) {
        const sid = values[0] as string;
        const row = rows.get(sid);
        if (row && !row.ended_at) {
          row.ended_at = new Date().toISOString();
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      }

      if (q.includes('SELECT * FROM acting_as_sessions') && q.includes('ended_at IS NULL')) {
        const sid = values[0] as string;
        const row = rows.get(sid);
        if (row && !row.ended_at) return Promise.resolve([row]);
        return Promise.resolve([]);
      }

      if (q.includes('SELECT * FROM acting_as_sessions WHERE session_id =')) {
        const sid = values[0] as string;
        const row = rows.get(sid);
        return Promise.resolve(row ? [row] : []);
      }

      return Promise.resolve([]);
    };
    return sql;
  }

  it('start() inserts row + returns active session entity', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const session = await svc.start({
      userId: 'user_alice',
      viaResellerOrgId: 'org_reseller',
      onBehalfOfOrgId: 'org_customer',
      ip: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
    });
    expect(session.sessionId).toMatch(/^aas_/);
    expect(session.userId).toBe('user_alice');
    expect(session.viaResellerOrgId).toBe('org_reseller');
    expect(session.onBehalfOfOrgId).toBe('org_customer');
    expect(session.endedAt).toBeNull();
    expect(session.revokedReason).toBeNull();
    expect(session.ip).toBe('203.0.113.10');
  });

  it('getActive() returns the row when ended_at IS NULL', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({
      userId: 'u',
      viaResellerOrgId: 'r',
      onBehalfOfOrgId: 'c',
    });
    const fetched = await svc.getActive(created.sessionId);
    expect(fetched?.sessionId).toBe(created.sessionId);
  });

  it('getActive() returns null when session_id is empty / missing / already-ended', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    expect(await svc.getActive('')).toBeNull();
    expect(await svc.getActive('aas_does_not_exist')).toBeNull();

    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });
    await svc.end(created.sessionId);
    expect(await svc.getActive(created.sessionId)).toBeNull();
  });

  it('end() sets ended_at + null revoked_reason (voluntary exit)', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });
    const ended = await svc.end(created.sessionId);
    expect(ended?.endedAt).not.toBeNull();
    expect(ended?.revokedReason).toBeNull();
  });

  it('end() is idempotent (second call returns existing entity unchanged)', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });
    const first = await svc.end(created.sessionId);
    const second = await svc.end(created.sessionId);
    expect(first?.endedAt).toBe(second?.endedAt);
  });

  it('revoke() sets ended_at + revoked_reason (system invalidation)', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });
    const revoked = await svc.revoke(created.sessionId, 'role_demoted_below_admin');
    expect(revoked?.endedAt).not.toBeNull();
    expect(revoked?.revokedReason).toBe('role_demoted_below_admin');
  });

  it('revoke() is idempotent on already-revoked session (returns existing entity unchanged)', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });
    const first = await svc.revoke(created.sessionId, 'role_demoted_below_admin');
    const second = await svc.revoke(created.sessionId, 'customer_archived');
    // Second call doesn't overwrite the reason; the first revoke is the
    // load-bearing one (closer-in-time to the actual authority change).
    expect(second?.revokedReason).toBe('role_demoted_below_admin');
    expect(second?.endedAt).toBe(first?.endedAt);
  });

  // Analyst PR #398 review (msg-1781536425113) item 1: admin_force_revoked
  // discriminator is part of the ratified schema (out-of-band admin tooling
  // path, NOT the 3-check middleware path). Locks the column accepts it.
  it('revoke() supports admin_force_revoked discriminator (out-of-band admin path)', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });
    const revoked = await svc.revoke(created.sessionId, 'admin_force_revoked');
    expect(revoked?.revokedReason).toBe('admin_force_revoked');
    expect(revoked?.endedAt).not.toBeNull();
  });

  // Analyst PR #398 review item 2: concurrent revoke-trigger idempotency.
  // Promise.all fires two revoke calls on the same session_id; the
  // UPDATE ... WHERE ended_at IS NULL clause ensures only the first
  // commits. Unit-level proof via the mock; real-Postgres exclusion
  // semantics covered at integration-test layer.
  it('revoke() concurrent calls — first writer wins; second sees the already-revoked row', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new ActingAsSessionService();
    const created = await svc.start({ userId: 'u', viaResellerOrgId: 'r', onBehalfOfOrgId: 'c' });

    const [a, b] = await Promise.all([
      svc.revoke(created.sessionId, 'role_demoted_below_admin'),
      svc.revoke(created.sessionId, 'customer_archived'),
    ]);

    // Both calls return a non-null entity (idempotent contract). The
    // load-bearing claim: exactly ONE revoke-reason ended up persisted
    // — never a half-state where both wrote partially.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const persistedReason = a?.revokedReason;
    expect([a?.revokedReason, b?.revokedReason]).toEqual([persistedReason, persistedReason]);
  });
});
