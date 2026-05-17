/**
 * Static schema-vs-harness drift gate — the migration / ALLOWED_SKIPS axis.
 *
 * Companion to harness-drift.test.ts. That file checks the COLUMN axis
 * (a runtime initTables column the harness bootstrap fails to mirror). This
 * file checks the TABLE axis: a migration that operates on a table the SCIM
 * integration harness neither bootstraps nor allowlists.
 *
 * Failure mode this catches (the mig-030 regression): migration 030 does
 * DROP/CREATE POLICY ON request_log. request_log is not in the harness
 * applyBootstrap(), and 030 was not in ALLOWED_SKIPS — so the integration
 * harness threw "relation request_log does not exist" and conduit main went
 * integration-red. The runtime harness DOES detect this (applyMigrations
 * throws on an unallowed "does not exist"), but only when the full
 * container-backed integration suite runs. #136 merged without that job
 * confirmed green, so the drift reached main.
 *
 * This module is a pure, static, container-free MIRROR of the
 * applyMigrations() ALLOWED_SKIPS rule, so the same drift is caught at PR
 * time by a fast job that needs no Postgres and no docker. The container
 * integration suite remains the thorough downstream backstop; this gate is
 * the fast, unmissable front line.
 *
 * Design rule — FAIL LOUD, never silent-pass. A static SQL parser cannot be
 * perfect. When it meets a top-level statement shape it does not model, it
 * does NOT wave the migration through — it flags the migration for review
 * and the gate fails. A check that exists but quietly fails to catch is the
 * mig-030 failure mode rebuilt. The container job backstops a false flag, so
 * erring toward "flag for a human" costs a glance, never a missed regression.
 *
 * All functions here are pure (no fs, no paths). The test file does the file
 * I/O and passes content in — see migration-harness-drift.test.ts.
 *
 * Known limitations — two, both consciously accepted, both backstopped by the
 * container `integration` job (real Postgres, real migration apply):
 *
 *  1. DO-block bodies. A DO block is plpgsql (IF/LOOP/PERFORM/EXECUTE), not a
 *     splittable statement list, so its body is mined best-effort by global
 *     pattern (extractDoBlockRefs) rather than classified — it is NOT
 *     fail-loud. A table-referencing construct inside a DO body outside that
 *     pattern set is best-effort-missed, not flagged.
 *
 *  2. Quoted identifiers. The parser assumes unquoted identifiers (conduit
 *     migrations are unquoted snake_case, 30/30 by convention). A quoted name
 *     in a leading table position makes the branch regex fail and falls to
 *     fail-loud (correct). A quoted name in a DML FROM/JOIN position is a
 *     silent miss — pre-existing, not introduced here. tableId() can never
 *     mangle a quoted name: QUALIFIED is built from IDENT, which has no quote
 *     in its char class, so a quoted identifier structurally cannot be
 *     captured. Fully parsing quoted-dotted identifiers is out of scope.
 */

const IDENT = '[a-zA-Z_][a-zA-Z0-9_]*';

/**
 * A possibly schema-qualified table name — an optional `schema.` prefix in
 * front of the table identifier. Capture the whole thing and pass it through
 * tableId() to reduce it to the bare table. Without this, a reference to
 * `public.foo` would capture `public` as the table name and false-flag the
 * migration.
 */
const QUALIFIED = `(?:${IDENT}\\.)?${IDENT}`;

/** Lower-case a (possibly schema-qualified) name and reduce it to the bare table. */
function tableId(raw: string): string {
  const parts = raw.toLowerCase().split('.');
  return parts[parts.length - 1];
}

/** A single migration file parsed into the tables it creates and requires. */
export interface MigrationParse {
  file: string;
  /** Tables this migration CREATEs (become available to later migrations). */
  creates: string[];
  /** Tables this migration requires to already exist when it runs. */
  uses: string[];
  /**
   * Normalised fragments of top-level statements the parser could not
   * classify. A non-empty list means the migration must be flagged for
   * human review rather than passed.
   */
  unparseable: string[];
}

/** Result of a full drift check across the migration set. */
export interface DriftResult {
  ok: boolean;
  errors: string[];
}

/**
 * Split a SQL script into top-level statements.
 *
 * Aware of: line comments (`-- …`), block comments, single-quoted strings
 * (with `''` escaping), and dollar-quoted regions (`$$ … $$`, `$tag$ … $tag$`)
 * — so a `;` inside a function body or a quoted string does not split a
 * statement. Splits only on a `;` at paren-depth 0 outside any quote.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let parenDepth = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    const ch = sql[i];

    if (ch === "'") {
      buf += ch;
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          buf += "'";
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }

    if (ch === '$') {
      const tagMatch = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const region = end === -1 ? sql.slice(i) : sql.slice(i, end + tag.length);
        buf += region;
        i += region.length;
        continue;
      }
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);

    if (ch === ';' && parenDepth === 0) {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Extract every real table reference from a DML / CTE statement.
 *
 * Collects identifiers after FROM / JOIN / INTO / UPDATE / USING and after
 * DELETE FROM, then subtracts WITH-defined CTE alias names — a CTE alias is
 * not a table and must not be reported as a missing one.
 */
function extractDmlTableRefs(stmt: string): string[] {
  const refs = new Set<string>();
  for (const m of stmt.matchAll(
    new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|USING)\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'gi'),
  )) {
    refs.add(tableId(m[1]));
  }
  for (const m of stmt.matchAll(
    new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(${QUALIFIED})`, 'gi'),
  )) {
    refs.add(tableId(m[1]));
  }
  // Subtract CTE aliases: `WITH [RECURSIVE] name AS (` and `, name AS (`.
  // A CTE alias is a bare local name, never schema-qualified.
  for (const m of stmt.matchAll(
    new RegExp(`(?:\\bWITH\\s+(?:RECURSIVE\\s+)?|,\\s*)(${IDENT})\\s+AS\\s*\\(`, 'gi'),
  )) {
    refs.delete(m[1].toLowerCase());
  }
  return [...refs];
}

/**
 * Extract FK `REFERENCES <table>` targets from a chunk of SQL — every
 * referenced table must already exist. Self-references (the table being
 * defined or altered) are excluded: that table exists by the time its own
 * constraints are evaluated.
 */
function extractReferences(text: string, selfTable: string): string[] {
  const refs: string[] = [];
  for (const r of text.matchAll(new RegExp(`\\bREFERENCES\\s+(${QUALIFIED})`, 'gi'))) {
    const ref = tableId(r[1]);
    if (ref !== selfTable) refs.push(ref);
  }
  return refs;
}

/**
 * Extract table create/use references from a DO-block body.
 *
 * A DO block runs at apply time and can carry DDL and DML, so it cannot be
 * waved through — but its body is plpgsql (IF/LOOP/PERFORM/RAISE), not a
 * splittable statement list, so it is mined by global pattern match rather
 * than per-statement classification.
 *
 * The DML patterns are deliberately anchored — INSERT requires INTO, DELETE
 * requires FROM, UPDATE requires a trailing SET — so a GRANT privilege list
 * inside a DO block (e.g. migration 029's
 * `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`) is not mis-read as
 * table references. Residual exotic constructs are caught by the container
 * integration job, the documented downstream backstop.
 */
function extractDoBlockRefs(text: string): { creates: string[]; uses: string[] } {
  const creates: string[] = [];
  const uses: string[] = [];
  const addAll = (re: RegExp, into: string[]): void => {
    for (const m of text.matchAll(re)) into.push(tableId(m[1]));
  };

  addAll(new RegExp(`\\bCREATE TABLE (?:IF NOT EXISTS )?(${QUALIFIED})`, 'gi'), creates);
  addAll(new RegExp(`\\bALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QUALIFIED})`, 'gi'), uses);
  addAll(new RegExp(`\\bCREATE POLICY \\S+ ON (?:TABLE )?(${QUALIFIED})`, 'gi'), uses);
  addAll(new RegExp(`\\bDROP POLICY (?:IF EXISTS )?\\S+ ON (?:TABLE )?(${QUALIFIED})`, 'gi'), uses);
  addAll(
    new RegExp(
      `\\bCREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?\\S+ ON (?:ONLY )?(${QUALIFIED})`,
      'gi',
    ),
    uses,
  );
  addAll(
    new RegExp(`\\bCREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER \\S+ .*? ON (${QUALIFIED})`, 'gi'),
    uses,
  );
  addAll(new RegExp(`\\bDROP TRIGGER (?:IF EXISTS )?\\S+ ON (${QUALIFIED})`, 'gi'), uses);
  addAll(new RegExp(`\\bINSERT INTO (${QUALIFIED})`, 'gi'), uses);
  // UPDATE is anchored on a trailing SET so a GRANT privilege list is not
  // mis-read — tolerating an optional `[AS] alias` between table and SET.
  addAll(new RegExp(`\\bUPDATE (${QUALIFIED})(?: (?:AS )?${IDENT})? SET\\b`, 'gi'), uses);
  addAll(new RegExp(`\\bDELETE FROM (?:ONLY )?(${QUALIFIED})`, 'gi'), uses);
  addAll(new RegExp(`\\bTRUNCATE (?:TABLE )?(?:ONLY )?(${QUALIFIED})`, 'gi'), uses);
  for (const r of extractReferences(text, '')) uses.push(r);

  return { creates, uses };
}

/**
 * Classify one top-level statement: the tables it creates, the tables it
 * uses, and whether the parser recognised its shape at all.
 *
 * `recognized: false` is the fail-loud signal — an un-modelled statement.
 */
function classifyStatement(stmt: string): {
  creates: string[];
  uses: string[];
  recognized: boolean;
} {
  const norm = stmt.replace(/\s+/g, ' ').trim();
  const U = norm.toUpperCase();
  const creates: string[] = [];
  const uses: string[] = [];
  const ok = (): { creates: string[]; uses: string[]; recognized: boolean } => ({
    creates,
    uses,
    recognized: true,
  });

  // --- statements that cannot reference a possibly-missing table ---
  // This set is provably table-free: each form addresses transaction state,
  // session config, or a non-table object (role, schema, extension, function
  // body, index name). Forms that CAN name a table — GRANT/REVOKE ON a table,
  // COMMENT ON a table — get a modelled branch below; forms not modelled at
  // all (SEQUENCE, ANALYZE, COPY, MERGE, …) fall through to fail-loud. Nothing
  // table-referencing is silently absorbed here.
  if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/.test(U)) return ok();
  if (/^SET\b/.test(U)) return ok();
  if (/^CREATE EXTENSION\b/.test(U)) return ok();
  if (/^CREATE SCHEMA\b/.test(U)) return ok();
  if (/^(CREATE|DROP|ALTER) ROLE\b/.test(U)) return ok();
  if (/^ALTER DEFAULT PRIVILEGES\b/.test(U)) return ok();
  // Function/procedure bodies are plpgsql — not validated at apply time, so
  // a table referenced inside is not a "does not exist" risk for the runner.
  if (/^CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)\b/.test(U)) return ok();
  if (/^DROP (FUNCTION|PROCEDURE)\b/.test(U)) return ok();
  // Index objects are outside the table model; DROP INDEX names an index.
  if (/^DROP INDEX\b/.test(U)) return ok();

  // --- GRANT / REVOKE: table-free unless it targets a specific table ---
  if (/^(GRANT|REVOKE)\b/.test(U)) {
    const on = norm.match(/\bON\s+(.+?)\s+(?:TO|FROM)\b/i);
    if (on) {
      const target = on[1].trim();
      // `ON ALL …`, `ON SCHEMA/FUNCTION/SEQUENCE/…` do not name a table.
      if (
        !/^(ALL\s+(?:TABLES|SEQUENCES|FUNCTIONS|ROUTINES|PROCEDURES)|SCHEMA|FUNCTION|PROCEDURE|ROUTINE|SEQUENCE|DATABASE|TYPE|DOMAIN|LANGUAGE|TABLESPACE|FOREIGN|LARGE\s+OBJECT|PARAMETER)\b/i.test(
          target,
        )
      ) {
        // `GRANT … ON [TABLE] t1, t2 …` — each names a table that must exist.
        for (const tok of target.replace(/^TABLE\s+/i, '').split(',')) {
          const tm = tok.trim().match(new RegExp(`^(${QUALIFIED})`));
          if (tm) uses.push(tableId(tm[1]));
        }
      }
    }
    return ok();
  }

  // --- COMMENT ON: table-free unless it targets a table / its column /
  //     a policy|constraint|trigger|rule ON a table. COMMENT ON's object
  //     vocabulary is a closed Postgres set; the remaining types (FUNCTION,
  //     SCHEMA, VIEW, INDEX, …) name no table. ---
  if (/^COMMENT ON\b/.test(U)) {
    let cm = norm.match(new RegExp(`^COMMENT ON TABLE (?:ONLY )?(${QUALIFIED})`, 'i'));
    if (cm) {
      uses.push(tableId(cm[1]));
      return ok();
    }
    cm = norm.match(new RegExp(`^COMMENT ON COLUMN (${QUALIFIED})\\.`, 'i'));
    if (cm) {
      uses.push(tableId(cm[1]));
      return ok();
    }
    cm = norm.match(
      new RegExp(
        `^COMMENT ON (?:POLICY|CONSTRAINT|TRIGGER|RULE) \\S+ ON (?:TABLE )?(${QUALIFIED})`,
        'i',
      ),
    );
    if (cm) {
      uses.push(tableId(cm[1]));
      return ok();
    }
    return ok();
  }

  // --- table-creating ---
  let m = norm.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?(${QUALIFIED})`, 'i'));
  if (m) {
    const created = tableId(m[1]);
    creates.push(created);
    // FK targets in the column list must already exist (self-refs excepted).
    uses.push(...extractReferences(norm, created));
    return ok();
  }

  // --- table-using: single-target DDL ---
  m = norm.match(new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QUALIFIED})`, 'i'));
  if (m) {
    const altered = tableId(m[1]);
    uses.push(altered);
    // ALTER TABLE … ADD CONSTRAINT … REFERENCES <other> requires <other> to
    // already exist, just as an inline FK in CREATE TABLE does.
    uses.push(...extractReferences(norm, altered));
    return ok();
  }
  m = norm.match(new RegExp(`^CREATE POLICY \\S+ ON (?:TABLE )?(${QUALIFIED})`, 'i'));
  if (m) {
    uses.push(tableId(m[1]));
    return ok();
  }
  m = norm.match(new RegExp(`^DROP POLICY (?:IF EXISTS )?\\S+ ON (?:TABLE )?(${QUALIFIED})`, 'i'));
  if (m) {
    uses.push(tableId(m[1]));
    return ok();
  }
  m = norm.match(
    new RegExp(
      `^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?\\S+ ON (?:ONLY )?(${QUALIFIED})`,
      'i',
    ),
  );
  if (m) {
    uses.push(tableId(m[1]));
    return ok();
  }
  m = norm.match(
    new RegExp(`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER \\S+ .*? ON (${QUALIFIED})`, 'i'),
  );
  if (m) {
    uses.push(tableId(m[1]));
    return ok();
  }
  m = norm.match(new RegExp(`^DROP TRIGGER (?:IF EXISTS )?\\S+ ON (${QUALIFIED})`, 'i'));
  if (m) {
    uses.push(tableId(m[1]));
    return ok();
  }

  // --- CREATE VIEW: unlike a function body, a view's query IS validated at
  //     apply time, so the tables in its SELECT must already exist. ---
  if (/^CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW\b/.test(U)) {
    uses.push(...extractDmlTableRefs(norm));
    return ok();
  }

  // --- TRUNCATE: one or more tables, with optional identity/cascade tail ---
  if (/^TRUNCATE\b/.test(U)) {
    const list = norm
      .replace(/^TRUNCATE\s+(?:TABLE\s+)?/i, '')
      .replace(/\b(?:RESTART|CONTINUE)\s+IDENTITY\b[\s\S]*$/i, '')
      .replace(/\bCASCADE\b[\s\S]*$/i, '')
      .replace(/\bRESTRICT\b[\s\S]*$/i, '');
    for (const token of list.split(',')) {
      const t = token.trim().replace(/^ONLY\s+/i, '').match(new RegExp(`^(${QUALIFIED})`));
      if (t) uses.push(tableId(t[1]));
    }
    return ok();
  }

  // --- DML / CTE: multi-reference sweep ---
  if (/^(INSERT INTO|UPDATE|DELETE FROM|WITH)\b/.test(U)) {
    uses.push(...extractDmlTableRefs(norm));
    return ok();
  }

  // --- DO block: runs at apply time; mine its body for DDL + DML ---
  if (/^DO\b/.test(U)) {
    const doRefs = extractDoBlockRefs(norm);
    creates.push(...doRefs.creates);
    uses.push(...doRefs.uses);
    return ok();
  }

  // Un-modelled shape — fail loud.
  return { creates, uses, recognized: false };
}

/** Parse one migration file into its created / used / unparseable sets. */
export function parseMigration(file: string, sql: string): MigrationParse {
  const creates: string[] = [];
  const uses: string[] = [];
  const unparseable: string[] = [];

  for (const stmt of splitStatements(sql)) {
    const c = classifyStatement(stmt);
    if (!c.recognized) {
      unparseable.push(stmt.replace(/\s+/g, ' ').trim().slice(0, 120));
      continue;
    }
    creates.push(...c.creates);
    uses.push(...c.uses);
  }

  return { file, creates, uses, unparseable };
}

/**
 * Parse the table names the SCIM harness bootstraps. Matches every
 * `CREATE TABLE IF NOT EXISTS <name>` in the harness source.
 */
export function parseBootstrapTables(harnessSource: string): Set<string> {
  const tables = new Set<string>();
  for (const m of harnessSource.matchAll(
    new RegExp(`CREATE TABLE IF NOT EXISTS\\s+(${QUALIFIED})`, 'gi'),
  )) {
    tables.add(tableId(m[1]));
  }
  return tables;
}

/**
 * Parse the ALLOWED_SKIPS file list from the harness source — every
 * `{ file: '<name>.sql', … }` entry.
 */
export function parseAllowedSkips(harnessSource: string): Set<string> {
  const files = new Set<string>();
  for (const m of harnessSource.matchAll(/file:\s*'([^']+\.sql)'/g)) {
    files.add(m[1]);
  }
  return files;
}

/**
 * Run the drift check. `migrations` must be sorted in apply order — the same
 * order applyMigrations() uses (readdirSync(...).sort()).
 */
export function checkDrift(opts: {
  migrations: ReadonlyArray<{ file: string; sql: string }>;
  bootstrapTables: ReadonlySet<string>;
  allowedSkips: ReadonlySet<string>;
}): DriftResult {
  const errors: string[] = [];
  const available = new Set<string>([...opts.bootstrapTables]);

  for (const { file, sql } of opts.migrations) {
    // An allowlisted migration is skipped wholesale by the harness on its
    // first "does not exist" — model that: it neither runs its USEs nor
    // contributes its CREATEs to later migrations.
    if (opts.allowedSkips.has(file)) continue;

    const parsed = parseMigration(file, sql);

    if (parsed.unparseable.length > 0) {
      errors.push(
        `${file}: the drift parser could not classify the following statement(s) — ` +
          `the migration is flagged for review rather than waved through (the gate ` +
          `fails loud on un-modelled SQL by design). Fragment(s):\n` +
          parsed.unparseable.map((u) => `    ${u}`).join('\n') +
          `\n  Resolve by extending classifyStatement() in migration-drift-check.ts to ` +
          `model this shape, or — if the migration is irrelevant to SCIM tests — by ` +
          `adding it to ALLOWED_SKIPS in integration-harness.ts.`,
      );
      continue;
    }

    // A table created earlier in this same file satisfies a later reference.
    const selfCreates = new Set(parsed.creates);
    const missing = [
      ...new Set(parsed.uses.filter((t) => !available.has(t) && !selfCreates.has(t))),
    ];

    if (missing.length > 0) {
      errors.push(
        `${file}: references table(s) [${missing.join(', ')}] that the SCIM ` +
          `integration harness neither bootstraps nor allowlists. The harness applies ` +
          `every migrations/*.sql against a minimal bootstrap, so this migration will ` +
          `fail with "does not exist". Two ways out (the same choice ` +
          `applyMigrations() surfaces at runtime):\n` +
          `  1. Add the missing table(s) to applyBootstrap() in integration-harness.ts ` +
          `(preferred if SCIM tests exercise this schema), OR\n` +
          `  2. Add { file: '${file}', reason: <why SCIM can skip it> } to ALLOWED_SKIPS ` +
          `in integration-harness.ts (if the migration is irrelevant to SCIM ` +
          `business-logic tests).`,
      );
    }

    for (const t of parsed.creates) available.add(t);
  }

  return { ok: errors.length === 0, errors };
}
