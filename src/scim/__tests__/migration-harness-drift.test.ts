/**
 * Schema-vs-harness drift gate — the migration / ALLOWED_SKIPS axis.
 *
 * The headline test ("no migration drifts from the SCIM harness") is the CI
 * gate: it statically mirrors the applyMigrations() ALLOWED_SKIPS rule, so a
 * mig-030-class regression (a migration touching a table the harness neither
 * bootstraps nor allowlists) fails fast at PR time — no Postgres, no docker —
 * instead of surfacing as a downstream integration-red on main.
 *
 * The remaining tests pin the parser's behaviour, including the fail-loud
 * contract: un-modelled SQL is flagged for review, never waved through.
 *
 * See migration-drift-check.ts for the design rationale.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  splitStatements,
  parseMigration,
  parseBootstrapTables,
  parseAllowedSkips,
  checkDrift,
} from './migration-drift-check.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const HARNESS_FILE = join(REPO_ROOT, 'src/scim/__tests__/integration-harness.ts');

/** Migrations in apply order — the same order applyMigrations() uses. */
function loadMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }));
}

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not split on a semicolon inside a dollar-quoted body', () => {
    const sql = 'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nSELECT 9;';
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('PERFORM 1; PERFORM 2;');
    expect(stmts[1]).toBe('SELECT 9');
  });

  it('does not split on a semicolon inside a single-quoted string', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      'SELECT 1',
    ]);
  });

  it('strips line and block comments outside quotes', () => {
    const sql = '-- a comment\nSELECT 1; /* block */ SELECT 2;';
    expect(splitStatements(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('parseMigration — table-creating and table-using shapes', () => {
  it('records CREATE TABLE as a created table', () => {
    const p = parseMigration('x.sql', 'CREATE TABLE IF NOT EXISTS widgets (id TEXT);');
    expect(p.creates).toContain('widgets');
    expect(p.unparseable).toEqual([]);
  });

  it('records ALTER TABLE / CREATE POLICY / CREATE INDEX targets as used', () => {
    const sql = `
      ALTER TABLE request_log ADD COLUMN x TEXT;
      CREATE POLICY p ON audit_log FOR SELECT USING (true);
      CREATE INDEX IF NOT EXISTS idx ON sessions (id);
    `;
    const p = parseMigration('x.sql', sql);
    expect(p.uses).toEqual(expect.arrayContaining(['request_log', 'audit_log', 'sessions']));
    expect(p.unparseable).toEqual([]);
  });

  it('records FK REFERENCES targets as used, excluding self-references', () => {
    const sql =
      'CREATE TABLE node (id TEXT PRIMARY KEY, parent TEXT REFERENCES node(id), ' +
      'org_id TEXT REFERENCES organizations(id));';
    const p = parseMigration('x.sql', sql);
    expect(p.creates).toContain('node');
    expect(p.uses).toContain('organizations');
    expect(p.uses).not.toContain('node');
  });

  it('records ALTER TABLE … ADD CONSTRAINT … REFERENCES targets as used', () => {
    // Regression guard: the ALTER branch must extract the FK target, not just
    // the altered table — `b` here would otherwise be silently dropped.
    const p = parseMigration(
      'x.sql',
      'ALTER TABLE child ADD CONSTRAINT fk FOREIGN KEY (parent_id) REFERENCES parent (id);',
    );
    expect(p.uses).toEqual(expect.arrayContaining(['child', 'parent']));
    expect(p.unparseable).toEqual([]);
  });

  it('extracts CREATE POLICY / CREATE INDEX targets from inside a DO block', () => {
    // Regression guard: the DO-block miner must see DDL beyond ALTER/CREATE
    // TABLE — a policy or index on a table inside a DO block is a real use.
    const sql =
      'DO $$ BEGIN ' +
      'CREATE POLICY p ON request_log FOR SELECT USING (true); ' +
      'CREATE INDEX idx ON audit_events (id); ' +
      'END $$;';
    const p = parseMigration('x.sql', sql);
    expect(p.uses).toEqual(expect.arrayContaining(['request_log', 'audit_events']));
    expect(p.unparseable).toEqual([]);
  });

  it('does not mis-read a GRANT privilege list inside a DO block as table refs', () => {
    // migration 029 shape: the DO-block DML miner is anchored (UPDATE needs a
    // trailing SET, DELETE needs FROM, INSERT needs INTO) so `UPDATE, DELETE`
    // in a GRANT list is not captured as tables named "delete"/"update".
    const sql =
      'DO $$ BEGIN ' +
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO r; ' +
      'END $$;';
    const p = parseMigration('x.sql', sql);
    expect(p.uses).toEqual([]);
    expect(p.unparseable).toEqual([]);
  });

  it('skips CREATE OR REPLACE FUNCTION bodies — plpgsql is not apply-time validated', () => {
    const sql =
      'CREATE OR REPLACE FUNCTION f() RETURNS BOOLEAN AS $$ BEGIN ' +
      'PERFORM 1 FROM nonexistent_table; RETURN true; END; $$ LANGUAGE plpgsql;';
    const p = parseMigration('x.sql', sql);
    expect(p.uses).not.toContain('nonexistent_table');
    expect(p.unparseable).toEqual([]);
  });

  it('mines ALTER TABLE out of a DO block body', () => {
    const sql =
      'DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = $c$c$c$) ' +
      'THEN ALTER TABLE organizations ADD CONSTRAINT c CHECK (true); END IF; END $$;';
    const p = parseMigration('x.sql', sql);
    expect(p.uses).toContain('organizations');
    expect(p.unparseable).toEqual([]);
  });
});

describe('parseMigration — DML / CTE reference sweep', () => {
  it('extracts real tables from a WITH-CTE-fronted DELETE and subtracts CTE aliases', () => {
    const sql = `
      WITH ranked AS (SELECT id FROM users),
           dupes  AS (SELECT id FROM ranked GROUP BY id)
      DELETE FROM users u USING dupes d WHERE u.id = d.id;
    `;
    const p = parseMigration('x.sql', sql);
    expect(p.uses).toContain('users');
    // CTE aliases are not tables.
    expect(p.uses).not.toContain('ranked');
    expect(p.uses).not.toContain('dupes');
  });
});

describe('parseMigration — fail-loud contract', () => {
  it('flags an un-modelled top-level statement as unparseable', () => {
    // A statement shape the classifier does not model.
    const p = parseMigration('weird.sql', 'CLUSTER organizations USING idx;');
    expect(p.unparseable.length).toBeGreaterThan(0);
    expect(p.unparseable[0]).toContain('CLUSTER');
  });

  it('does not flag the recognised statement shapes', () => {
    const sql =
      'BEGIN; SET x = 1; GRANT USAGE ON SCHEMA public TO r; ' +
      'CREATE EXTENSION IF NOT EXISTS pg_trgm; ' +
      'CREATE OR REPLACE FUNCTION f() RETURNS INT AS $b$ SELECT 1 $b$ LANGUAGE sql; ' +
      'COMMIT;';
    expect(parseMigration('x.sql', sql).unparseable).toEqual([]);
  });

  it('fails loud on table-referencing forms that are deliberately not modelled', () => {
    // ANALYZE <table>, COPY, MERGE, LOCK TABLE, CREATE RULE, DROP TABLE etc.
    // can all name a table; rather than half-model them, they hit fail-loud.
    for (const sql of [
      'ANALYZE organizations;',
      'COPY users FROM STDIN;',
      'MERGE INTO accounts a USING staging s ON a.id = s.id;',
      'LOCK TABLE organizations IN EXCLUSIVE MODE;',
      'DROP TABLE legacy_sessions;',
    ]) {
      expect(parseMigration('x.sql', sql).unparseable.length).toBeGreaterThan(0);
    }
  });
});

describe('parseMigration — enumeration-surfaced shapes (PR #146 re-review)', () => {
  it('UPDATE inside a DO block resolves the table through an alias', () => {
    // `UPDATE t SET`, `UPDATE t x SET`, `UPDATE t AS x SET` must all resolve t.
    for (const form of ['UPDATE accounts SET', 'UPDATE accounts a SET', 'UPDATE accounts AS a SET']) {
      const p = parseMigration('x.sql', `DO $$ BEGIN ${form} flag = true; END $$;`);
      expect(p.uses).toContain('accounts');
    }
  });

  it('extracts every table from a multi-table TRUNCATE with an identity/cascade tail', () => {
    const p = parseMigration(
      'x.sql',
      'TRUNCATE TABLE org_members, org_invitations, users RESTART IDENTITY CASCADE;',
    );
    expect(p.uses).toEqual(expect.arrayContaining(['org_members', 'org_invitations', 'users']));
    expect(p.unparseable).toEqual([]);
  });

  it('extracts the table from COMMENT ON TABLE / COLUMN / POLICY', () => {
    expect(parseMigration('x.sql', "COMMENT ON TABLE request_log IS 'x';").uses).toContain(
      'request_log',
    );
    expect(parseMigration('x.sql', "COMMENT ON COLUMN request_log.org_id IS 'x';").uses).toContain(
      'request_log',
    );
    expect(
      parseMigration('x.sql', "COMMENT ON POLICY p ON request_log IS 'x';").uses,
    ).toContain('request_log');
  });

  it('treats COMMENT ON FUNCTION / SCHEMA as table-free', () => {
    expect(parseMigration('x.sql', "COMMENT ON FUNCTION f(text) IS 'x';").uses).toEqual([]);
    expect(parseMigration('x.sql', "COMMENT ON SCHEMA public IS 'x';").uses).toEqual([]);
  });

  it('extracts the tables a CREATE VIEW query selects from', () => {
    const p = parseMigration(
      'x.sql',
      'CREATE OR REPLACE VIEW active_orgs AS SELECT o.* FROM organizations o JOIN org_members m ON m.org_id = o.id;',
    );
    expect(p.uses).toEqual(expect.arrayContaining(['organizations', 'org_members']));
    expect(p.unparseable).toEqual([]);
  });

  it('extracts a specific-table GRANT but not GRANT ON ALL TABLES / ON FUNCTION', () => {
    expect(parseMigration('x.sql', 'GRANT SELECT ON request_log TO r;').uses).toContain(
      'request_log',
    );
    expect(
      parseMigration('x.sql', 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO r;').uses,
    ).toEqual([]);
    expect(parseMigration('x.sql', 'GRANT EXECUTE ON FUNCTION f(text) TO r;').uses).toEqual([]);
  });

  it('resolves schema-qualified table names to the bare table — no false flag on `public.x`', () => {
    // A schema-qualified ref must resolve to the bare table, not capture the
    // schema segment as a phantom table. Covered across the capture sites.
    expect(parseMigration('x.sql', 'ALTER TABLE public.request_log ADD COLUMN c TEXT;').uses).toEqual(
      ['request_log'],
    );
    expect(
      parseMigration('x.sql', 'CREATE POLICY p ON conduit.request_log FOR SELECT USING (true);').uses,
    ).toEqual(['request_log']);
    expect(
      parseMigration('x.sql', 'DELETE FROM public.users u WHERE u.stale;').uses,
    ).toEqual(['users']);
    const fk = parseMigration(
      'x.sql',
      'CREATE TABLE t (id TEXT, org_id TEXT REFERENCES public.organizations(id));',
    );
    expect(fk.uses).toEqual(['organizations']);
    // COMMENT ON COLUMN schema.table.col → the table segment, not the schema.
    expect(
      parseMigration('x.sql', "COMMENT ON COLUMN public.request_log.org_id IS 'x';").uses,
    ).toEqual(['request_log']);
  });
});

describe('parseBootstrapTables / parseAllowedSkips', () => {
  it('parses every CREATE TABLE IF NOT EXISTS name from harness source', () => {
    const src = `
      await sql\`CREATE TABLE IF NOT EXISTS users (id TEXT)\`;
      await sql\`CREATE TABLE IF NOT EXISTS org_members (id TEXT)\`;
    `;
    expect(parseBootstrapTables(src)).toEqual(new Set(['users', 'org_members']));
  });

  it('parses the ALLOWED_SKIPS file list from harness source', () => {
    const src = `
      const ALLOWED_SKIPS = [
        { file: '007_rls_enable.sql', reason: 'x' },
        { file: '030_widen.sql', reason: 'y' },
      ];
    `;
    expect(parseAllowedSkips(src)).toEqual(
      new Set(['007_rls_enable.sql', '030_widen.sql']),
    );
  });
});

describe('checkDrift — synthetic scenarios', () => {
  const bootstrap = new Set(['users', 'organizations']);

  it('passes when every used table is bootstrapped, created, or allowlisted', () => {
    const r = checkDrift({
      migrations: [
        { file: '001.sql', sql: 'ALTER TABLE users ADD COLUMN x TEXT;' },
        { file: '002.sql', sql: 'CREATE TABLE teams (id TEXT); ALTER TABLE teams ADD COLUMN n TEXT;' },
      ],
      bootstrapTables: bootstrap,
      allowedSkips: new Set(),
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('fails — with the actionable two-way-out message — on a non-bootstrapped, non-skipped table', () => {
    const r = checkDrift({
      migrations: [{ file: '030_widen.sql', sql: 'CREATE POLICY p ON request_log FOR SELECT USING (true);' }],
      bootstrapTables: bootstrap,
      allowedSkips: new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('request_log');
    expect(r.errors[0]).toContain('applyBootstrap()');
    expect(r.errors[0]).toContain('ALLOWED_SKIPS');
    expect(r.errors[0]).toContain("{ file: '030_widen.sql'");
  });

  it('passes the same migration once it is in ALLOWED_SKIPS', () => {
    const r = checkDrift({
      migrations: [{ file: '030_widen.sql', sql: 'CREATE POLICY p ON request_log FOR SELECT USING (true);' }],
      bootstrapTables: bootstrap,
      allowedSkips: new Set(['030_widen.sql']),
    });
    expect(r.ok).toBe(true);
  });

  it('does not credit CREATEs from an allowlisted (skipped) migration to later migrations', () => {
    const r = checkDrift({
      migrations: [
        { file: '010.sql', sql: 'CREATE TABLE vendor_health (id TEXT);' },
        { file: '011.sql', sql: 'ALTER TABLE vendor_health ADD COLUMN x TEXT;' },
      ],
      bootstrapTables: bootstrap,
      // 010 is skipped wholesale -> vendor_health never lands -> 011 must fail.
      allowedSkips: new Set(['010.sql']),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('vendor_health');
  });

  it('fails on an unparseable migration (fail-loud, not silent-pass)', () => {
    const r = checkDrift({
      migrations: [{ file: 'weird.sql', sql: 'CLUSTER organizations USING idx;' }],
      bootstrapTables: bootstrap,
      allowedSkips: new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('flagged for review');
  });
});

describe('CI GATE — no migration drifts from the SCIM integration harness', () => {
  it('every migration the harness runs operates only on tables it bootstraps', () => {
    const harnessSource = readFileSync(HARNESS_FILE, 'utf8');
    const result = checkDrift({
      migrations: loadMigrations(),
      bootstrapTables: parseBootstrapTables(harnessSource),
      allowedSkips: parseAllowedSkips(harnessSource),
    });

    if (!result.ok) {
      throw new Error(
        'schema-vs-harness drift detected — a migration operates on a table the ' +
          'SCIM integration harness neither bootstraps nor allowlists. This will ' +
          'break the integration suite. Fix before merge:\n\n' +
          result.errors.join('\n\n'),
      );
    }
    expect(result.ok).toBe(true);
  });
});
