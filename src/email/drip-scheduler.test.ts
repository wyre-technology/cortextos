import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for the drip-email scheduler (WYREAI-94, sub-issue 76.2).
 *
 * Ported from mcp-gateway/src/email/drip-scheduler.test.ts with three
 * test-infrastructure adaptations (same conduit DI seam as PR A's
 * vendor-state-store.test.ts, plus the conduit-specific send-abstraction
 * signature):
 *
 *  1. db/context: gateway injects postgres.Sql via constructor; conduit
 *     resolves sql via getSql() against an async-context (mig 029 spine).
 *     The scheduler runs background (boot + setInterval) so DB calls
 *     wrap in runAsSystem(). Tests mock both via vi.mock('../db/context.js')
 *     — getSql returns the per-test mock sql, runAsSystem passes through.
 *
 *  2. send abstraction: gateway calls sendEmail({to,subject,html}); conduit
 *     calls sendTransactionalEmail(log, email). Mock + assertions adapt.
 *
 *  3. Constructor: scheduler takes only the logger (no sql arg). Each test
 *     sets `currentSql = createSqlMock(...)` before `new DripScheduler(log)`
 *     so the mocked getSql() returns the per-test mock.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentSql: any = null;

vi.mock('../db/context.js', () => ({
  getSql: () => {
    if (!currentSql) {
      throw new Error('test bug: currentSql not set before getSql() call');
    }
    return currentSql;
  },
  runAsSystem: <T,>(fn: () => Promise<T>) => fn(),
}));

vi.mock('./resend.js', () => ({
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

vi.mock('./graph.js', () => ({
  sendEmailViaGraph: vi.fn(async () => {}),
}));

vi.mock('../config.js', () => ({
  config: {
    resendApiKey: 'test-key',
    graphTenantId: 'test-tenant',
    graphClientId: 'test-client',
    graphClientSecret: 'test-secret',
    founderWelcomeFrom: 'aaron@wyre.ai',
  },
}));

import { sendTransactionalEmail } from './resend.js';
import { sendEmailViaGraph } from './graph.js';
import { config } from '../config.js';
import { DripScheduler } from './drip-scheduler.js';

interface SqlCall {
  strings: TemplateStringsArray | null;
  values: unknown[];
}

/**
 * Builds a postgres.js-shaped tagged template stub.
 * `responder` is invoked with the raw SQL text + interpolated values and
 * returns the rows the call should resolve to. Defaults to [] (empty result).
 */
function createSqlMock(
  responder: (sql: string, values: unknown[]) => unknown[] | Promise<unknown[]>,
) {
  const calls: SqlCall[] = [];
  const sql = (...args: unknown[]) => {
    if (Array.isArray(args[0]) && 'raw' in (args[0] as object)) {
      const strings = args[0] as unknown as TemplateStringsArray;
      const values = args.slice(1);
      calls.push({ strings, values });
      const joined = strings.reduce<string>(
        (acc, part, i) => acc + part + (i < values.length ? `$${i}` : ''),
        '',
      );
      return Promise.resolve(responder(joined, values));
    }
    calls.push({ strings: null, values: args });
    return Promise.resolve([]);
  };
  return { sql, calls };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => silentLogger),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  vi.mocked(sendTransactionalEmail).mockClear();
  vi.mocked(sendTransactionalEmail).mockImplementation(async () => undefined);
  vi.mocked(sendEmailViaGraph).mockClear();
  silentLogger.info.mockClear();
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
  delete process.env.DRIP_SCHEDULER_DISABLED;
  delete process.env.DRIP_MAX_PER_TICK;
  currentSql = null;
});

afterEach(() => {
  delete process.env.DRIP_SCHEDULER_DISABLED;
  delete process.env.DRIP_MAX_PER_TICK;
});

describe('DripScheduler', () => {
  it('SELECT queries include the upper-bound created_at clause (regression for backfill blast)', async () => {
    const { sql, calls } = createSqlMock(() => []);
    currentSql = sql;
    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    const selectCalls = calls.filter(
      (c) => c.strings && c.strings.join('').includes('FROM users u'),
    );
    expect(selectCalls.length).toBe(5); // one per drip step

    for (const call of selectCalls) {
      const joined = call.strings!.join('');
      // Must have BOTH bounds — the missing upper bound caused the
      // 2026-05-08 incident where re-enabling Resend blasted ~98 emails to
      // the entire ~30-day backlog of signups in a single tick.
      expect(joined).toMatch(/created_at\s*<=\s*NOW\(\)\s*-/);
      expect(joined).toMatch(/created_at\s*>=\s*NOW\(\)\s*-/);
    }
  });

  it('does not send to users outside the grace window', async () => {
    const { sql } = createSqlMock(() => []);
    currentSql = sql;
    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('sends drip email and writes a marker row for each in-window user', async () => {
    const inWindowUser = { id: 'u1', email: 'user1@example.com', name: 'Alice' };
    const inserts: { user_id: string; email_key: string }[] = [];

    const { sql } = createSqlMock((q, vals) => {
      if (q.includes('SELECT u.id')) {
        return inserts.length === 0 ? [inWindowUser] : [];
      }
      if (q.includes('INSERT INTO drip_emails_sent')) {
        inserts.push({ user_id: vals[0] as string, email_key: vals[1] as string });
        return [];
      }
      return [];
    });
    currentSql = sql;

    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      silentLogger,
      expect.objectContaining({ to: 'user1@example.com' }),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ user_id: 'u1' });
  });

  it('honors the per-tick rate cap (DRIP_MAX_PER_TICK)', async () => {
    process.env.DRIP_MAX_PER_TICK = '3';
    const lots = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      email: `user${i}@example.com`,
      name: null,
    }));
    let firstSelect = true;
    const { sql } = createSqlMock((q) => {
      if (q.includes('SELECT u.id')) {
        if (firstSelect) {
          firstSelect = false;
          return lots;
        }
        return [];
      }
      return [];
    });
    currentSql = sql;

    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(3);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ totalSent: 3, maxPerTick: 3 }),
      expect.stringContaining('rate cap'),
    );
  });

  it('skips entire tick when DRIP_SCHEDULER_DISABLED=true', async () => {
    process.env.DRIP_SCHEDULER_DISABLED = 'true';
    const { sql, calls } = createSqlMock((q) => {
      if (q.includes('SELECT u.id')) {
        return [{ id: 'u1', email: 'u@example.com', name: null }];
      }
      return [];
    });
    currentSql = sql;

    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    // Conduit's scheduler does not call ensureTable() at runtime (migration
    // 039 owns the DDL), so when the kill switch fires before any other
    // db work, NO db calls happen. Same assertion as gateway's "not even
    // ensureTable should run" — the conduit-side reasoning is "no db calls
    // period because the kill switch returns before fetchRecipients()."
    expect(calls).toHaveLength(0);
  });

  it('continues to next user when an individual send fails', async () => {
    const users = [
      { id: 'u1', email: 'fail@example.com', name: null },
      { id: 'u2', email: 'ok@example.com', name: null },
    ];
    let first = true;
    const { sql } = createSqlMock((q) => {
      if (q.includes('SELECT u.id') && first) {
        first = false;
        return users;
      }
      return [];
    });
    currentSql = sql;
    vi.mocked(sendTransactionalEmail)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.stringContaining('Failed to send drip email'),
    );
  });

  it('founder-welcome targets org owners via the organizations join', async () => {
    const owner = { id: 'o1', email: 'owner@acme.com', name: 'Pat', company: 'Acme' };
    let firstOwnerSelect = true;
    const { sql } = createSqlMock((q) => {
      if (q.includes('JOIN organizations o') && firstOwnerSelect) {
        firstOwnerSelect = false;
        return [owner];
      }
      return [];
    });
    currentSql = sql;

    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    expect(sendEmailViaGraph).toHaveBeenCalledTimes(1);
    expect(sendEmailViaGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@acme.com',
        subject: 'Welcome to WYRE Gateway, Pat',
      }),
    );
    // The founder-welcome step never uses the Resend transport.
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('founder-welcome owner query excludes internal WYRE email domains', async () => {
    const { sql, calls } = createSqlMock(() => []);
    currentSql = sql;
    const scheduler = new DripScheduler(silentLogger);
    await scheduler.runOnce();

    const ownerQuery = calls.find(
      (c) => c.strings && c.strings.join('').includes('JOIN organizations o'),
    );
    expect(ownerQuery).toBeDefined();
    const joined = ownerQuery!.strings!.join('');
    expect(joined).toContain("NOT ILIKE '%@wyre.ai'");
    expect(joined).toContain("NOT ILIKE '%@wyretechnology.com'");
  });

  it('skips the founder-welcome step when Graph config is absent', async () => {
    const prevTenant = config.graphTenantId;
    (config as { graphTenantId: string }).graphTenantId = '';
    try {
      const { sql, calls } = createSqlMock(() => []);
      currentSql = sql;
      const scheduler = new DripScheduler(silentLogger);
      await scheduler.runOnce();

      const ownerQueries = calls.filter(
        (c) => c.strings && c.strings.join('').includes('JOIN organizations o'),
      );
      expect(ownerQueries).toHaveLength(0);
      expect(sendEmailViaGraph).not.toHaveBeenCalled();
    } finally {
      (config as { graphTenantId: string }).graphTenantId = prevTenant;
    }
  });
});
