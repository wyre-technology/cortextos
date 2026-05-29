import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations, assertNumericContiguity } from './migrate.js';
import type postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

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
    // Files written out of order; runner sorts and applies 001..003.
    // Sequence is contiguous so the boot-time contiguity assert passes.
    writeMigration('003_late.sql', 'select 3');
    writeMigration('002_middle.sql', 'select 2');
    writeMigration('001_first.sql', 'select 1');

    const { sql } = makeFakeSql();
    const r = await runMigrations(sql, { dir: tmpDir, log: silentLog() });

    expect(r.applied).toEqual(['001_first.sql', '002_middle.sql', '003_late.sql']);
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

  it('refuses to boot when migration sequence has a gap', async () => {
    writeMigration('001_first.sql', 'select 1');
    writeMigration('003_third.sql', 'select 3'); // gap at 002

    const { sql } = makeFakeSql();
    await expect(runMigrations(sql, { dir: tmpDir, log: silentLog() })).rejects.toThrow(
      /sequence gap.*expected 002.*003_third\.sql/,
    );
  });

  // Cleanup
  it('cleanup', () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('assertNumericContiguity', () => {
  it('passes on an empty list (clean-slate deploy)', () => {
    expect(() => assertNumericContiguity([])).not.toThrow();
  });

  it('passes on a single migration starting at 001', () => {
    expect(() => assertNumericContiguity(['001_first.sql'])).not.toThrow();
  });

  it('passes on a contiguous sequence 001..017 (current main shape)', () => {
    const files = Array.from({ length: 17 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      return `${n}_migration.sql`;
    });
    expect(() => assertNumericContiguity(files)).not.toThrow();
  });

  it('throws when the sequence has a single-file gap (the 015-shaped case)', () => {
    // The exact pattern that broke the June 2026 ship: 012 → 016 → 017,
    // missing 013/014/015.
    const files = [
      '001_first.sql',
      '002_second.sql',
      '012_twelfth.sql',
      '016_sixteenth.sql',
      '017_seventeenth.sql',
    ];
    expect(() => assertNumericContiguity(files)).toThrow(/sequence gap/);
  });

  it('error message names the missing-number expected and the file found instead', () => {
    expect(() => assertNumericContiguity(['001_first.sql', '003_third.sql'])).toThrow(
      /expected 002.*found 003_third\.sql/,
    );
  });

  it('throws when a duplicate number is present', () => {
    // Two files share numeric prefix 014 — happens when separate PRs both
    // claim the next number and one ends up with a longer description.
    expect(() =>
      assertNumericContiguity([
        '001_a.sql',
        '014_first.sql',
        '014_second_collision.sql',
      ]),
    ).toThrow(/duplicate migration numbers.*14.*014_first\.sql/);
  });

  it('throws when a file lacks a numeric prefix', () => {
    expect(() =>
      assertNumericContiguity(['001_first.sql', 'add_index.sql']),
    ).toThrow(/missing numeric prefix.*add_index\.sql/);
  });

  it('throws when the sequence does not start at 001', () => {
    expect(() => assertNumericContiguity(['002_second.sql', '003_third.sql'])).toThrow(
      /must start at 001/,
    );
  });

  it('treats 1_foo.sql and 001_foo.sql as the same number (parses leading zeros)', () => {
    // Two files with numeric prefix 1 differing only in zero-padding =
    // duplicate. The error names them.
    expect(() =>
      assertNumericContiguity(['1_short.sql', '001_padded.sql']),
    ).toThrow(/duplicate migration numbers/);
  });
});

// =============================================================================
// Regression-guard: assertNumericContiguity must pass against the REAL
// migrations/ dir shipped with this codebase.
//
// Why this test exists (find-the-answer-at-code-velocity rationale):
//
// On 2026-05-28, two PRs (#271 vendor-registry + #282 org-memory) both
// claimed `035_*.sql` and BOTH merged to main. assertNumericContiguity
// throws on duplicate numbers — meaning the next production deploy via
// runMigrations would have refused to boot — but CI passed cleanly on
// both merges. The unit tests above test the function's SHAPE on
// synthetic arrays (CI-verification-layer); they never exercise the
// assertion against the actual files shipped with this codebase.
// The SCIM integration harness has its own applyMigrations that doesn't
// call the assertion either. The production-runtime path (runMigrations
// on the real migrations/ dir at Fastify boot) was the only place the
// check would fire, and CI never invoked it.
//
// This regression-guard closes the gap structurally: any future PR
// that introduces a duplicate-number / sequence-gap / missing-prefix
// problem against the actual `migrations/` dir will fail this test at
// PR-time, BEFORE the merge that lands the broken state on main.
// Construction-side fix (the test is the gate) over discipline-side
// fix (reviewers remember to check the migration number) — matches
// the codebase's defence-by-construction pattern (mig 029's GRANT
// guards, mig 036's DO-block policy guards, the canonical-key
// UNIQUE INDEX in mig 036, etc.).
//
// Recovery PR: #283 (rename 035 → 036). CI-gap follow-up: this test.
// =============================================================================

describe('assertNumericContiguity — against the real migrations/ dir (regression-guard)', () => {
  it('the production migrations/ dir passes assertNumericContiguity', () => {
    const realMigrationsDir = join(REPO_ROOT, 'migrations');
    const files = readdirSync(realMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    // assertNumericContiguity throws on first violation with an
    // operator-actionable message naming the offending files. If this
    // test ever fails, the error itself names what to fix and the
    // mig-035 incident's recovery PR (#283) is the worked-example
    // template for the renumber-fix shape.
    expect(() => assertNumericContiguity(files)).not.toThrow();
  });
});
