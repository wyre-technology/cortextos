/**
 * #88 — audit personal-credential entries are scoped to the membership
 * window. Real-Postgres guard.
 *
 * AuditService.query(orgId) returns org entries PLUS personal-credential
 * entries (org_id IS NULL) from the org's members. The bug: it pulled a
 * member's personal entries with no time bound — so a user who used
 * personal credentials elsewhere BEFORE joining had that historic,
 * unrelated activity become visible to the org's admins the moment they
 * accepted the invite. The fix adds `AND joined_at <= r.created_at` to the
 * org_members subquery: a personal entry is visible to the org only if it
 * was created after the user joined.
 *
 * The filter is SQL — the unit suite's mock-SQL harness cannot exercise
 * it — so this guard runs the real query against a real Postgres.
 *
 * Verified fail-on-regression: drop the joined_at predicate and the
 * pre-join entry leaks into the result; with it, only the post-join
 * personal entry and the org entry are visible.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

import { AuditService } from '../audit-service.js';
import { enterTestContext } from '../../db/context.js';

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;
let audit: AuditService;

const JOINED_AT = '2026-03-01T00:00:00Z';
const BEFORE_JOIN = '2026-02-01T12:00:00Z';
const AFTER_JOIN = '2026-04-01T12:00:00Z';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => undefined });

  await sql`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '')`;
  await sql`
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', joined_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (org_id, user_id)
    )`;
  await sql`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      vendor_slug TEXT NOT NULL, tool_name TEXT,
      tool_arguments JSONB, prompt_context TEXT, source TEXT,
      status_code INTEGER NOT NULL, response_time_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL
    )`;

  // user-x joined org-1 on 2026-03-01.
  await sql`INSERT INTO users (id, email) VALUES ('user-x', 'x@acme.com')`;
  await sql`INSERT INTO org_members (id, org_id, user_id, joined_at)
    VALUES ('m-x', 'org-1', 'user-x', ${JOINED_AT})`;

  // Three request_log rows for user-x:
  //  (1) personal creds, BEFORE joining — must NOT be visible to org-1.
  //  (2) personal creds, AFTER joining  — visible to org-1.
  //  (3) org-1 creds                    — always visible to org-1.
  await sql`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, created_at) VALUES
    ('rl-pre',  'user-x', NULL,    'datto-rmm', 'devices.list', 200, 100, ${BEFORE_JOIN}),
    ('rl-post', 'user-x', NULL,    'datto-rmm', 'devices.list', 200, 100, ${AFTER_JOIN}),
    ('rl-org',  'user-x', 'org-1', 'datto-rmm', 'devices.list', 200, 100, ${AFTER_JOIN})`;

  enterTestContext(sql);
  audit = new AuditService();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

describe('#88 — audit query scopes personal entries to the membership window', () => {
  it('a pre-join personal-credential entry is NOT visible to the org', async () => {
    const { entries } = await audit.query({ orgId: 'org-1' });
    const ids = entries.map((e) => e.id);
    // The leak: rl-pre was created before user-x joined org-1.
    expect(ids).not.toContain('rl-pre');
  });

  it('post-join personal + org entries ARE visible to the org', async () => {
    // Positive control: the joined_at bound must not over-filter.
    const { entries } = await audit.query({ orgId: 'org-1' });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('rl-post');
    expect(ids).toContain('rl-org');
    expect(entries).toHaveLength(2);
  });
});
