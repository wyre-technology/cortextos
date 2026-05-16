import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdminAuditEntry } from './admin-audit-service.js';
import { runWithSql } from '../db/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'aal_1',
    org_id: 'org_1',
    actor_id: 'user_1',
    actor_email: 'actor@example.com',
    actor_name: 'Actor User',
    target_id: 'user_2',
    target_email: 'target@example.com',
    target_name: 'Target User',
    event_type: 'member_invited',
    metadata: { email: 'test@example.com' },
    created_at: '2026-02-23T12:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock SQL builder
// ---------------------------------------------------------------------------

interface MockSqlOptions {
  rows?: Record<string, unknown>[];
  count?: number;
}

function createMockSql(opts: MockSqlOptions = {}) {
  const { rows = [], count = rows.length } = opts;

  const calls: { query: string; values: unknown[] }[] = [];

  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });

    // COUNT query
    if (query.includes('COUNT(*)')) {
      return Promise.resolve([{ count }]);
    }

    // SELECT a.* data query (with user JOINs)
    if (query.includes('SELECT a.*') && query.includes('admin_audit_log')) {
      return Promise.resolve(rows);
    }

    // INSERT query
    if (query.includes('INSERT INTO')) {
      return Promise.resolve({ count: 1 });
    }

    // DELETE query
    if (query.includes('DELETE FROM')) {
      return Promise.resolve({ count: 5 });
    }

    // Fragment calls (WHERE condition parts)
    return Promise.resolve('__fragment__');
  };

  // Add json() helper used for JSONB inserts
  (sql as unknown as Record<string, unknown>).json = (value: unknown) => value;

  return {
    sql: sql as unknown as import('postgres').Sql,
    calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdminAuditService', () => {
  let AdminAuditService: typeof import('./admin-audit-service.js').AdminAuditService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./admin-audit-service.js');
    AdminAuditService = mod.AdminAuditService;
  });

  // -----------------------------------------------------------------------
  // log()
  // -----------------------------------------------------------------------

  describe('log()', () => {
    it('inserts an audit entry with all fields', async () => {
      const { sql, calls } = createMockSql();
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.log({
        orgId: 'org_1',
        actorId: 'user_1',
        targetId: 'user_2',
        eventType: 'member_invited',
        metadata: { email: 'test@example.com' },
      }));

      const insertCall = calls.find((c) => c.query.includes('INSERT INTO'));
      expect(insertCall).toBeDefined();
      expect(insertCall!.values).toContain('org_1');
      expect(insertCall!.values).toContain('user_1');
      expect(insertCall!.values).toContain('user_2');
      expect(insertCall!.values).toContain('member_invited');
    });

    it('inserts with null targetId and metadata when omitted', async () => {
      const { sql, calls } = createMockSql();
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.log({
        orgId: 'org_1',
        actorId: 'user_1',
        eventType: 'org_updated',
      }));

      const insertCall = calls.find((c) => c.query.includes('INSERT INTO'));
      expect(insertCall).toBeDefined();
      expect(insertCall!.values).toContain(null); // targetId
    });
  });

  // -----------------------------------------------------------------------
  // query()
  // -----------------------------------------------------------------------

  describe('query()', () => {
    it('returns entries with default pagination', async () => {
      const row = makeRow();
      const { sql, calls } = createMockSql({ rows: [row], count: 1 });
      const service = new AdminAuditService();

      const result = await runWithSql(sql, () => service.query({ orgId: 'org_1' }));

      expect(result.entries).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.entries[0]).toEqual<AdminAuditEntry>({
        id: 'aal_1',
        orgId: 'org_1',
        actorId: 'user_1',
        actorEmail: 'actor@example.com',
        actorName: 'Actor User',
        targetId: 'user_2',
        targetEmail: 'target@example.com',
        targetName: 'Target User',
        eventType: 'member_invited',
        metadata: { email: 'test@example.com' },
        createdAt: '2026-02-23T12:00:00Z',
      });

      // The SELECT * call should include LIMIT 50 and OFFSET 0
      const selectCall = calls.find((c) => c.query.includes('SELECT a.*'));
      expect(selectCall).toBeDefined();
      const vals = selectCall!.values;
      expect(vals[vals.length - 2]).toBe(50);
      expect(vals[vals.length - 1]).toBe(0);
    });

    it('respects custom limit and offset', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.query({ orgId: 'org_1', limit: 10, offset: 20 }));

      const selectCall = calls.find((c) => c.query.includes('SELECT a.*'));
      const vals = selectCall!.values;
      expect(vals[vals.length - 2]).toBe(10);
      expect(vals[vals.length - 1]).toBe(20);
    });

    it('clamps limit to max 200', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.query({ orgId: 'org_1', limit: 999 }));

      const selectCall = calls.find((c) => c.query.includes('SELECT a.*'));
      const vals = selectCall!.values;
      expect(vals[vals.length - 2]).toBe(200);
    });

    it('always filters by orgId', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.query({ orgId: 'org_42' }));

      const fragmentCall = calls.find((c) => c.query.includes('a.org_id'));
      expect(fragmentCall).toBeDefined();
      expect(fragmentCall!.values).toContain('org_42');
    });

    it('filters by eventType', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.query({ orgId: 'org_1', eventType: 'member_removed' }));

      const fragmentCall = calls.find((c) => c.query.includes('a.event_type'));
      expect(fragmentCall).toBeDefined();
      expect(fragmentCall!.values).toContain('member_removed');
    });

    it('filters by actorId', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.query({ orgId: 'org_1', actorId: 'user_99' }));

      const fragmentCall = calls.find((c) => c.query.includes('a.actor_id'));
      expect(fragmentCall).toBeDefined();
      expect(fragmentCall!.values).toContain('user_99');
    });

    it('filters by date range', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.query({
        orgId: 'org_1',
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-31T23:59:59Z',
      }));

      const startCall = calls.find((c) => c.query.includes('a.created_at >='));
      expect(startCall).toBeDefined();
      expect(startCall!.values).toContain('2026-01-01T00:00:00Z');

      const endCall = calls.find((c) => c.query.includes('a.created_at <='));
      expect(endCall).toBeDefined();
      expect(endCall!.values).toContain('2026-01-31T23:59:59Z');
    });

    it('returns empty results when no matches', async () => {
      const { sql } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      const result = await runWithSql(sql, () => service.query({ orgId: 'org_1' }));

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // exportCsv()
  // -----------------------------------------------------------------------

  describe('exportCsv()', () => {
    it('returns CSV with header row', async () => {
      const { sql } = createMockSql({ rows: [], count: 0 });
      const service = new AdminAuditService();

      const csv = await runWithSql(sql, () => service.exportCsv({ orgId: 'org_1' }));
      const lines = csv.split('\n');

      expect(lines[0]).toBe('timestamp,org_id,actor,actor_email,target,target_email,event_type,metadata');
    });

    it('includes all entry fields in correct order', async () => {
      const row = makeRow({ metadata: null });
      const { sql } = createMockSql({ rows: [row], count: 1 });
      const service = new AdminAuditService();

      const csv = await runWithSql(sql, () => service.exportCsv({ orgId: 'org_1' }));
      const lines = csv.split('\n');

      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('2026-02-23T12:00:00Z,org_1,user_1,actor@example.com,user_2,target@example.com,member_invited,');
    });

    it('handles null targetId as empty string', async () => {
      const row = makeRow({ target_id: null, target_email: null, target_name: null, metadata: null });
      const { sql } = createMockSql({ rows: [row], count: 1 });
      const service = new AdminAuditService();

      const csv = await runWithSql(sql, () => service.exportCsv({ orgId: 'org_1' }));
      const lines = csv.split('\n');

      expect(lines[1]).toBe('2026-02-23T12:00:00Z,org_1,user_1,actor@example.com,,,member_invited,');
    });

    it('escapes commas in metadata JSON', async () => {
      const row = makeRow({ metadata: { key: 'a,b' } });
      const { sql } = createMockSql({ rows: [row], count: 1 });
      const service = new AdminAuditService();

      const csv = await runWithSql(sql, () => service.exportCsv({ orgId: 'org_1' }));
      const lines = csv.split('\n');

      // Commas in JSON should be replaced with semicolons
      expect(lines[1]).not.toContain('{"key":"a,b"}');
      expect(lines[1]).toContain('{"key":"a;b"}');
    });
  });

  // -----------------------------------------------------------------------
  // cleanupAdminAuditLog()
  // -----------------------------------------------------------------------

  describe('cleanupAdminAuditLog()', () => {
    it('deletes old entries and returns count', async () => {
      const { sql, calls } = createMockSql();
      const service = new AdminAuditService();

      const count = await runWithSql(sql, () => service.cleanupAdminAuditLog(90));

      expect(count).toBe(5);
      const deleteCall = calls.find((c) => c.query.includes('DELETE FROM'));
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.values).toContain('90 days');
    });

    it('uses default 90-day retention', async () => {
      const { sql, calls } = createMockSql();
      const service = new AdminAuditService();

      await runWithSql(sql, () => service.cleanupAdminAuditLog());

      const deleteCall = calls.find((c) => c.query.includes('DELETE FROM'));
      expect(deleteCall!.values).toContain('90 days');
    });
  });
});
