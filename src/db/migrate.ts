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
 * Migration files MUST be named `NNN_description.sql` (any leading-digit
 * prefix sorts correctly; the project uses 001..017 today). Renaming an
 * already-applied migration is a foot-gun — use a new file instead.
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
