import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditEntry } from './audit-service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'log_1',
    user_id: 'user_1',
    user_email: 'user1@example.com',
    user_name: 'User One',
    org_id: 'org_1',
    vendor_slug: 'autotask',
    tool_name: 'search_tickets',
    tool_arguments: null,
    prompt_context: null,
    source: null,
    status_code: 200,
    response_time_ms: 142,
    created_at: '2026-02-17T12:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock SQL builder
// ---------------------------------------------------------------------------
// The AuditService uses sql as a tagged template in two ways:
//   1. Fragment calls for WHERE conditions: sql`org_id = ${val}`
//   2. Full queries: sql<T[]>`SELECT ... ${where} ... LIMIT ${limit} OFFSET ${offset}`
//
// We track all calls. The mock returns predetermined rows for SELECT queries
// and fragment markers for condition-building calls.
// ---------------------------------------------------------------------------

interface MockSqlOptions {
  rows?: Record<string, unknown>[];
  count?: number;
}

function createMockSql(opts: MockSqlOptions = {}) {
  const { rows = [], count = rows.length } = opts;

  // Track calls for assertion purposes
  const calls: { query: string; values: unknown[] }[] = [];

  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    calls.push({ query, values });

    // COUNT query
    if (query.includes('COUNT(*)')) {
      return Promise.resolve([{ count }]);
    }

    // SELECT r.* data query (with user JOIN)
    if (query.includes('SELECT r.*') && query.includes('request_log')) {
      return Promise.resolve(rows);
    }

    // Fragment calls (WHERE condition parts) -- return a marker object.
    // The service composes fragments via reduce; the composed value is then
    // interpolated into the full query as a regular value. We return a
    // lightweight string-like object so it can be passed through without error.
    return Promise.resolve('__fragment__');
  };

  return {
    sql: sql as unknown as import('postgres').Sql,
    calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditService', () => {
  let AuditService: typeof import('./audit-service.js').AuditService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./audit-service.js');
    AuditService = mod.AuditService;
  });

  // -----------------------------------------------------------------------
  // query()
  // -----------------------------------------------------------------------

  describe('query()', () => {
    it('returns entries with default pagination (limit 50, offset 0)', async () => {
      const row = makeRow();
      const { sql, calls } = createMockSql({ rows: [row], count: 1 });
      const service = new AuditService(sql);

      const result = await service.query({});

      expect(result.entries).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.entries[0]).toEqual<AuditEntry>({
        id: 'log_1',
        userId: 'user_1',
        userEmail: 'user1@example.com',
        userName: 'User One',
        orgId: 'org_1',
        vendorSlug: 'autotask',
        toolName: 'search_tickets',
        toolArguments: null,
        promptContext: null,
        source: null,
        statusCode: 200,
        responseTimeMs: 142,
        createdAt: '2026-02-17T12:00:00Z',
      });

      // The SELECT * call should include LIMIT 50 and OFFSET 0
      const selectCall = calls.find((c) => c.query.includes('SELECT r.*'));
      expect(selectCall).toBeDefined();
      // limit and offset are the last two interpolated values
      const vals = selectCall!.values;
      expect(vals[vals.length - 2]).toBe(50);
      expect(vals[vals.length - 1]).toBe(0);
    });

    it('respects custom limit and offset', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({ limit: 10, offset: 20 });

      const selectCall = calls.find((c) => c.query.includes('SELECT r.*'));
      const vals = selectCall!.values;
      expect(vals[vals.length - 2]).toBe(10);
      expect(vals[vals.length - 1]).toBe(20);
    });

    it('clamps limit to max 200', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({ limit: 999 });

      const selectCall = calls.find((c) => c.query.includes('SELECT r.*'));
      const vals = selectCall!.values;
      expect(vals[vals.length - 2]).toBe(200);
    });

    it('filters by orgId (including personal-credential usage)', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({ orgId: 'org_42' });

      // There should be a fragment call with r.org_id and org_members subquery
      const fragmentCall = calls.find((c) => c.query.includes('org_id'));
      expect(fragmentCall).toBeDefined();
      expect(fragmentCall!.values).toContain('org_42');
    });

    it('filters by userId', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({ userId: 'user_99' });

      const fragmentCall = calls.find((c) => c.query.includes('r.user_id'));
      expect(fragmentCall).toBeDefined();
      expect(fragmentCall!.values).toContain('user_99');
    });

    it('filters by vendorSlug', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({ vendorSlug: 'halopsa' });

      const fragmentCall = calls.find((c) => c.query.includes('r.vendor_slug'));
      expect(fragmentCall).toBeDefined();
      expect(fragmentCall!.values).toContain('halopsa');
    });

    it('filters by date range (startDate and endDate)', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-31T23:59:59Z',
      });

      const startCall = calls.find(
        (c) => c.query.includes('r.created_at >='),
      );
      expect(startCall).toBeDefined();
      expect(startCall!.values).toContain('2026-01-01T00:00:00Z');

      const endCall = calls.find(
        (c) => c.query.includes('r.created_at <='),
      );
      expect(endCall).toBeDefined();
      expect(endCall!.values).toContain('2026-01-31T23:59:59Z');
    });

    it('combines multiple filters', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.query({
        orgId: 'org_1',
        userId: 'user_1',
        vendorSlug: 'syncro',
      });

      // Each filter produces a fragment call
      expect(calls.some((c) => c.query.includes('r.org_id') || c.query.includes('org_id'))).toBe(true);
      expect(calls.some((c) => c.query.includes('r.user_id'))).toBe(true);
      expect(calls.some((c) => c.query.includes('r.vendor_slug'))).toBe(true);

      // There should also be a WHERE + AND composition call
      const whereCall = calls.find((c) => c.query.includes('WHERE'));
      expect(whereCall).toBeDefined();
    });

    it('returns empty results when no matches', async () => {
      const { sql } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      const result = await service.query({});

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns correct total count independent of page size', async () => {
      const rows = [makeRow({ id: 'log_1' }), makeRow({ id: 'log_2' })];
      const { sql } = createMockSql({ rows, count: 150 });
      const service = new AuditService(sql);

      const result = await service.query({ limit: 2 });

      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(150);
    });
  });

  // -----------------------------------------------------------------------
  // exportCsv()
  // -----------------------------------------------------------------------

  describe('exportCsv()', () => {
    it('returns CSV with header row', async () => {
      const { sql } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      const csv = await service.exportCsv({});
      const lines = csv.split('\n');

      expect(lines[0]).toBe(
        'timestamp,user_id,user_email,org_id,vendor,tool,source,status,duration_ms,tool_arguments,prompt_context',
      );
    });

    it('includes all entry fields in correct order', async () => {
      const row = makeRow();
      const { sql } = createMockSql({ rows: [row], count: 1 });
      const service = new AuditService(sql);

      const csv = await service.exportCsv({});
      const lines = csv.split('\n');

      expect(lines).toHaveLength(2); // header + 1 data row
      expect(lines[1]).toBe(
        '2026-02-17T12:00:00Z,user_1,user1@example.com,org_1,autotask,search_tickets,,200,142,,',
      );
    });

    it('handles null orgId and toolName as empty strings', async () => {
      const row = makeRow({ org_id: null, tool_name: null });
      const { sql } = createMockSql({ rows: [row], count: 1 });
      const service = new AuditService(sql);

      const csv = await service.exportCsv({});
      const lines = csv.split('\n');

      // org_id and tool_name positions should be empty
      expect(lines[1]).toBe(
        '2026-02-17T12:00:00Z,user_1,user1@example.com,,autotask,,,200,142,,',
      );
    });

    it('handles null responseTimeMs as empty string', async () => {
      const row = makeRow({ response_time_ms: null });
      const { sql } = createMockSql({ rows: [row], count: 1 });
      const service = new AuditService(sql);

      const csv = await service.exportCsv({});
      const lines = csv.split('\n');

      expect(lines[1]).toBe(
        '2026-02-17T12:00:00Z,user_1,user1@example.com,org_1,autotask,search_tickets,,200,,,',
      );
    });

    it('overrides pagination (offset 0, limit clamped to 200 by query)', async () => {
      const { sql, calls } = createMockSql({ rows: [], count: 0 });
      const service = new AuditService(sql);

      await service.exportCsv({ limit: 5, offset: 100 });

      const selectCall = calls.find((c) => c.query.includes('SELECT r.*'));
      const vals = selectCall!.values;
      // exportCsv passes limit: 10000, but query() clamps to Math.min(10000, 200) = 200
      expect(vals[vals.length - 2]).toBe(200);
      // offset is forced to 0 regardless of the caller's value
      expect(vals[vals.length - 1]).toBe(0);
    });
  });
});
