import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';
import type postgres from 'postgres';

interface FakeQueryResult {
  count?: number;
  [key: string]: unknown;
}

function makeFakeSql() {
  const calls: { kind: string; payload: unknown }[] = [];
  const appliedRows: { filename: string }[] = [];

  const sqlFn = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<FakeQueryResult[]> => {
    const text = strings.join('?');
    calls.push({ kind: 'sql', payload: { text, values } });

    if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(text)) {
      return Promise.resolve([]);
    }
    if (/SELECT filename FROM schema_migrations/.test(text)) {
      return Promise.resolve([...appliedRows]);
    }
    if (/INSERT INTO schema_migrations/.test(text)) {
      const filename = values[0] as string;
      appliedRows.push({ filename });
      return Promise.resolve([{ count: 1 }]);
    }
    return Promise.resolve([{ count: 1 }]);
  };

  // sql.begin runs the callback with a tx that has the same shape, plus tx.unsafe
  const beginFn = async <T>(cb: (tx: typeof sqlFn & { unsafe: (s: string) => Promise<unknown> }) => Promise<T>): Promise<T> => {
    const tx = sqlFn as typeof sqlFn & { unsafe: (s: string) => Promise<unknown> };
    tx.unsafe = (body: string) => {
      calls.push({ kind: 'unsafe', payload: body });
      return Promise.resolve();
    };
    return cb(tx);
  };

  (sqlFn as unknown as { begin: typeof beginFn }).begin = beginFn;

  return { sql: sqlFn as unknown as postgres.Sql, calls, appliedRows };
}

describe('runMigrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mig-test-'));
  });

  function writeMigration(name: string, body: string): void {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, name), body);
  }

  function silentLog() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it('applies every file once and skips already-applied on re-run', async () => {
    writeMigration('001_first.sql', 'CREATE TABLE foo();');
    writeMigration('002_second.sql', 'CREATE TABLE bar();');

    const { sql, calls, appliedRows } = makeFakeSql();

    const r1 = await runMigrations(sql, { dir: tmpDir, log: silentLog() });
    expect(r1.applied).toEqual(['001_first.sql', '002_second.sql']);
    expect(r1.skipped).toEqual([]);
    expect(appliedRows).toHaveLength(2);

    // Both unsafe bodies were submitted
    const unsafeBodies = calls.filter((c) => c.kind === 'unsafe').map((c) => c.payload);
    expect(unsafeBodies).toContain('CREATE TABLE foo();');
    expect(unsafeBodies).toContain('CREATE TABLE bar();');

    // Re-run sees the ledger and skips both
    const r2 = await runMigrations(sql, { dir: tmpDir, log: silentLog() });
    expect(r2.applied).toEqual([]);
    expect(r2.skipped).toEqual(['001_first.sql', '002_second.sql']);
  });

  it('strips BEGIN/COMMIT before submitting body', async () => {
    writeMigration(
      '001_with_tx.sql',
      'BEGIN;\nALTER TABLE foo ADD COLUMN bar TEXT;\nCOMMIT;',
    );

    const { sql, calls } = makeFakeSql();
    await runMigrations(sql, { dir: tmpDir, log: silentLog() });

    const submitted = calls.find((c) => c.kind === 'unsafe')?.payload as string;
    expect(submitted).not.toMatch(/^\s*BEGIN/m);
    expect(submitted).not.toMatch(/^\s*COMMIT/m);
    expect(submitted).toMatch(/ALTER TABLE foo/);
  });

  it('applies in lexical order', async () => {
    writeMigration('010_late.sql', 'select 10');
    writeMigration('002_early.sql', 'select 2');
    writeMigration('001_first.sql', 'select 1');

    const { sql } = makeFakeSql();
    const r = await runMigrations(sql, { dir: tmpDir, log: silentLog() });

    expect(r.applied).toEqual(['001_first.sql', '002_early.sql', '010_late.sql']);
  });

  it('throws on a failing migration', async () => {
    writeMigration('001_bad.sql', 'broken sql goes here');

    const { sql } = makeFakeSql();
    type BeginCb<T> = (tx: { unsafe: (s: string) => Promise<unknown> }) => Promise<T>;
    (sql as unknown as { begin: <T>(cb: BeginCb<T>) => Promise<T> }).begin = async <T>(
      cb: BeginCb<T>,
    ) => {
      const tx = {
        unsafe: (body: string) => {
          if (body.includes('broken sql')) {
            return Promise.reject(new Error('syntax error'));
          }
          return Promise.resolve();
        },
      };
      return cb(tx);
    };

    await expect(runMigrations(sql, { dir: tmpDir, log: silentLog() })).rejects.toThrow(
      /001_bad\.sql failed/,
    );
  });

  it('warns and returns empty when migrations dir is missing', async () => {
    const { sql } = makeFakeSql();
    const log = silentLog();
    const r = await runMigrations(sql, { dir: join(tmpDir, 'nope'), log });
    expect(r.applied).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  // Cleanup
  it('cleanup', () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
