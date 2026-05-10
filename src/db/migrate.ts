/**
 * Migration runner.
 *
 * Reads `migrations/*.sql` in lexical order, applies any not yet recorded in
 * `schema_migrations`, and inserts a row per successful application. Each
 * migration runs inside a single `sql.begin(...)` transaction. Files are
 * applied wrapped in our own transaction; the file's own `BEGIN;` / `COMMIT;`
 * are stripped because postgres.js refuses multi-statement scripts unless the
 * pool is `max: 1`, and ours isn't.
 *
 * Idempotent and safe to run on every boot: already-applied files are
 * fingerprinted by filename and skipped.
 *
 * Migration files MUST be named `NNN_description.sql`. The numeric prefix is
 * enforced by `assertNumericContiguity` below — the runner refuses to start
 * if files have no numeric prefix, the sequence skips a number, two files
 * share the same number, or the sequence doesn't start at 1. This catches
 * the class of bug that produced the 013/014/015 gap that broke the June
 * 2026 ship: PRs were merged out of order via squash, the runner skipped by
 * filename presence in `schema_migrations` with no gap check, and 016/017
 * reached main without their prerequisites.
 *
 * Renaming an already-applied migration is a foot-gun — use a new file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

interface MigrationsRunOptions {
  /** Directory containing the SQL files. Defaults to `<repo>/migrations`. */
  dir?: string;
  /** Logger. Defaults to console. */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

const NUMERIC_PREFIX = /^(\d+)_/;

/**
 * Refuse to boot if `migrations/` has a numeric-sequence problem. The
 * runner's idempotent-by-filename behaviour means a missing migration
 * survives silently — `schema_migrations` simply doesn't contain it and
 * the runner doesn't know to expect it. This assert is the loud check
 * that earlier such gaps lacked.
 *
 * Rules:
 *   - Every `.sql` file MUST have a leading numeric prefix matching `^\d+_`.
 *   - Numbers MUST start at 1 (no `000_`, no `002_` as the first file).
 *   - Numbers MUST be contiguous (no gaps).
 *   - Numbers MUST be unique (no two files share the same prefix).
 *
 * Throws on any violation; the message lists every offending file so the
 * operator can fix the directory before redeploying.
 */
export function assertNumericContiguity(files: readonly string[]): void {
  if (files.length === 0) return; // empty migrations dir is a valid clean slate

  const noPrefix: string[] = [];
  const numbered: { num: number; name: string }[] = [];
  for (const f of files) {
    const match = f.match(NUMERIC_PREFIX);
    if (!match) {
      noPrefix.push(f);
    } else {
      numbered.push({ num: Number.parseInt(match[1], 10), name: f });
    }
  }
  if (noPrefix.length > 0) {
    throw new Error(
      `migration filenames missing numeric prefix (expected NNN_description.sql): ${noPrefix.join(', ')}`,
    );
  }

  numbered.sort((a, b) => (a.num !== b.num ? a.num - b.num : a.name.localeCompare(b.name)));

  // Duplicates (e.g., 014a + 014b). Detected before the gap check so the
  // error message names the offenders rather than tripping a misleading
  // "expected N+1" complaint.
  const duplicates: { num: number; names: string[] }[] = [];
  for (let i = 1; i < numbered.length; i += 1) {
    if (numbered[i].num === numbered[i - 1].num) {
      const last = duplicates[duplicates.length - 1];
      if (last && last.num === numbered[i].num) {
        last.names.push(numbered[i].name);
      } else {
        duplicates.push({ num: numbered[i].num, names: [numbered[i - 1].name, numbered[i].name] });
      }
    }
  }
  if (duplicates.length > 0) {
    const detail = duplicates.map((d) => `${d.num} (${d.names.join(' + ')})`).join('; ');
    throw new Error(`duplicate migration numbers: ${detail}`);
  }

  // Sequence must start at 1 and be contiguous.
  if (numbered[0].num !== 1) {
    throw new Error(
      `migration sequence must start at 001; first file is ${numbered[0].name} (${numbered[0].num})`,
    );
  }
  for (let i = 0; i < numbered.length; i += 1) {
    const expected = i + 1;
    if (numbered[i].num !== expected) {
      const expectedStr = String(expected).padStart(3, '0');
      throw new Error(
        `migration sequence gap: expected ${expectedStr}_*.sql but found ${numbered[i].name} ` +
          `(sequence: ${numbered.map((n) => n.name).join(', ')})`,
      );
    }
  }
}

const DEFAULT_DIR = join(process.cwd(), 'migrations');

const DEFAULT_LOG = {
  info: (msg: string) => console.log(`[migrate] ${msg}`),
  warn: (msg: string) => console.warn(`[migrate] ${msg}`),
  error: (msg: string) => console.error(`[migrate] ${msg}`),
};

export async function runMigrations(
  sql: postgres.Sql,
  opts: MigrationsRunOptions = {},
): Promise<{ applied: string[]; skipped: string[] }> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const log = opts.log ?? DEFAULT_LOG;

  // Ledger table — stores which migrations have run.
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`migrations dir ${dir} unreadable (${msg}); skipping runner`);
    return { applied: [], skipped: [] };
  }

  // Refuse to boot on a malformed sequence. Surfaces gaps / duplicates /
  // missing-prefix files BEFORE any DB-side work, with an error message
  // that names the offenders.
  assertNumericContiguity(files);

  const appliedRows = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations
  `;
  const alreadyApplied = new Set(appliedRows.map((r) => r.filename));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }

    const raw = readFileSync(join(dir, file), 'utf8');
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
      });
      log.info(`applied ${file}`);
      applied.push(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`FAILED ${file}: ${msg}`);
      throw new Error(`migration ${file} failed: ${msg}`);
    }
  }

  log.info(`done: ${applied.length} applied, ${skipped.length} already up to date`);
  return { applied, skipped };
}
