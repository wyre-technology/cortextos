/**
 * Schema-vs-harness drift check.
 *
 * Failure mode this catches: PR #46 added `stripe_subscription_id` (and
 * four other columns) to `OrgService.initTables`'s `organizations` CREATE
 * TABLE, but the SCIM integration harness's mirror at
 * `integration-harness.ts:53` was never updated. Migration 017's seat-
 * billing backfill (UPDATE … WHERE stripe_subscription_id IS NOT NULL)
 * subsequently failed cryptically against the test DB — the column
 * didn't exist there. The CI gate has no view of "this should mirror
 * that," so the regression survived merge.
 *
 * Prevention: parse runtime `initTables` CREATE TABLE statements from
 * service source files, parse the harness's bootstrap, diff column
 * sets per table, fail this test if the harness is missing any column
 * the runtime defines.
 *
 * Asymmetry by design: the harness MAY define columns the runtime
 * doesn't (typically migration-added columns the runtime gets via
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS` later). The check only
 * flags columns present in runtime initTables that are absent from
 * the harness. Harness ⊇ runtime is the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// Source files whose initTables defines the canonical CREATE TABLE for
// runtime-bootstrapped tables. The harness is expected to mirror these.
const SOURCE_FILES = [
  'src/org/org-service.ts',
  'src/org/team-service.ts',
  'src/auth/auth0.ts',
];

const HARNESS_FILE = 'src/scim/__tests__/integration-harness.ts';

interface ParsedTable {
  name: string;
  columns: Set<string>;
  /** For diagnostics: where the CREATE TABLE was found. */
  source: string;
}

/**
 * Extract `CREATE TABLE IF NOT EXISTS <name> (...)` blocks from a
 * TypeScript source file containing postgres.js tagged template
 * literals. Looks for the table name and captures everything up to the
 * matching close paren of the column list.
 *
 * Limitations (intentional, scoped to this codebase's actual style):
 *   - Assumes the column list closes on a line ending with `)` followed
 *     by an optional whitespace + closing backtick on a subsequent line.
 *   - Does NOT handle nested parens at the top level of a column
 *     definition (no CHECK constraints with parens at column level in
 *     this codebase as of writing). If that pattern is added later, the
 *     parser needs updating — and this test will fail loudly when its
 *     output starts looking wrong.
 */
function parseCreateTables(content: string, source: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const pattern = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)/g;
  for (const match of content.matchAll(pattern)) {
    const [, name, body] = match;
    const columns = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      // Skip table-level constraints (UNIQUE(...), PRIMARY KEY(...), CHECK(...)).
      if (/^(UNIQUE|PRIMARY\s+KEY|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(line)) continue;
      // First identifier on the line is the column name.
      const columnMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (columnMatch) {
        columns.add(columnMatch[1]);
      }
    }
    tables.push({ name, columns, source });
  }
  return tables;
}

function readSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('schema-vs-harness drift', () => {
  it('parser extracts the harness CREATE TABLE blocks', () => {
    const harnessTables = parseCreateTables(readSource(HARNESS_FILE), HARNESS_FILE);
    const names = new Set(harnessTables.map((t) => t.name));
    expect(names.has('users')).toBe(true);
    expect(names.has('organizations')).toBe(true);
    expect(names.has('org_members')).toBe(true);
    expect(names.has('org_invitations')).toBe(true);
  });

  it('parser extracts runtime initTables CREATE TABLE blocks', () => {
    const sourceTables = SOURCE_FILES.flatMap((f) => parseCreateTables(readSource(f), f));
    const names = new Set(sourceTables.map((t) => t.name));
    expect(names.has('organizations')).toBe(true);
    expect(names.has('org_members')).toBe(true);
    expect(names.has('org_invitations')).toBe(true);
  });

  it('harness mirrors every runtime-defined column for every table it bootstraps', () => {
    const harnessTables = parseCreateTables(readSource(HARNESS_FILE), HARNESS_FILE);
    const sourceTables = SOURCE_FILES.flatMap((f) => parseCreateTables(readSource(f), f));

    // Build runtime view: table -> set of column names. If a table appears
    // in multiple source files, union the columns.
    const runtimeColumns = new Map<string, Set<string>>();
    const runtimeSource = new Map<string, string[]>();
    for (const t of sourceTables) {
      const existing = runtimeColumns.get(t.name);
      if (existing) {
        for (const c of t.columns) existing.add(c);
        runtimeSource.get(t.name)!.push(t.source);
      } else {
        runtimeColumns.set(t.name, new Set(t.columns));
        runtimeSource.set(t.name, [t.source]);
      }
    }

    const drift: string[] = [];
    for (const ht of harnessTables) {
      const runtimeCols = runtimeColumns.get(ht.name);
      if (!runtimeCols) {
        // Harness creates this table but no runtime initTables defines it.
        // Fine — it's a migration-only table the harness bootstraps for
        // test isolation.
        continue;
      }
      const missing = [...runtimeCols].filter((c) => !ht.columns.has(c));
      if (missing.length > 0) {
        const src = runtimeSource.get(ht.name)!.join(', ');
        drift.push(
          `${ht.name}: harness is missing column(s) ${missing.join(', ')} ` +
            `(runtime defines them in ${src})`,
        );
      }
    }

    if (drift.length > 0) {
      throw new Error(
        'schema-vs-harness drift detected. The integration test harness at ' +
          `${HARNESS_FILE} no longer mirrors runtime initTables. Add the missing ` +
          'columns to the harness CREATE TABLE blocks (or, if the column was ' +
          'added by a migration that the harness also runs, that\'s expected — ' +
          'the migration\'s ADD COLUMN will populate it). Drift:\n  - ' +
          drift.join('\n  - '),
      );
    }
  });
});
