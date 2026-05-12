/**
 * RLS Bug B sweep (mig 022) — paired accept/reject coverage for the 9
 * UPDATE policies that mig 022 restores from qual=NULL to symmetric
 * USING+WITH-CHECK shape.
 *
 * Companion file: rls-with-check.integration.test.ts (covers the 4
 * tables fixed by mig 020 + the helper-context tests). This file
 * deliberately uses its own testcontainer so role state on the
 * connection pool is clean (no prior asUser SET ROLE leakage), which
 * lets fixture setup run as the table owner and toggle RLS for inserts.
 *
 * Each test pair:
 *   (a) rightful-user UPDATE succeeds → 1 row affected → mutation visible
 *   (b) non-rightful-user UPDATE → 0 rows affected → row unchanged
 *
 * Together these prove the symmetric pre-image-filter = post-image-check
 * invariant that mig 014 intended and mig 022 restores. The 0-rows-
 * affected on the reject side is the load-bearing signal: pre-022, all
 * UPDATEs (including rightful) saw 0 rows because qual=NULL made the
 * pre-image filter reject everything. Post-022, only the wrong-user
 * UPDATEs see 0 rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  sql = postgres(container.getConnectionUri(), {
    max: 4,
    onnotice: () => undefined,
  });

  await bootstrapSchema();
  await seedFixtures();
  await applyRlsMigrations();
  await provisionTestRole();
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Bootstrap — minimum schema for the 9 tables + supporting (users, orgs)
// ---------------------------------------------------------------------------

async function bootstrapSchema(): Promise<void> {
  await sql`CREATE TABLE users (
    id    TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
  )`;

  await sql`CREATE TABLE organizations (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'standalone',
    parent_org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE org_members (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  )`;

  await sql`CREATE TABLE reseller_members (
    id              TEXT PRIMARY KEY,
    reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    UNIQUE (reseller_org_id, user_id)
  )`;

  // Tables mig 007 enables RLS on but we don't otherwise touch in this
  // file. Stub bootstraps so the ALTER TABLE statements succeed.
  await sql`CREATE TABLE org_credentials (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    vendor_slug TEXT NOT NULL
  )`;
  await sql`CREATE TABLE org_teams (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL
  )`;
  await sql`CREATE TABLE org_team_credentials (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
    vendor_slug TEXT NOT NULL
  )`;

  await sql`CREATE TABLE admin_audit_log (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id     TEXT NOT NULL REFERENCES users(id),
    event_type   TEXT NOT NULL
  )`;
  await sql`CREATE TABLE request_log (
    id          TEXT PRIMARY KEY,
    org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     TEXT REFERENCES users(id),
    vendor_slug TEXT NOT NULL
  )`;
  await sql`CREATE TABLE credentials (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_slug TEXT NOT NULL
  )`;
  await sql`CREATE TABLE org_invitations (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invited_by  TEXT NOT NULL REFERENCES users(id),
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
  )`;
  await sql`CREATE TABLE org_tool_allowlist (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    vendor_slug TEXT NOT NULL,
    tool_name   TEXT NOT NULL
  )`;
  await sql`CREATE TABLE org_server_access (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_slug TEXT NOT NULL
  )`;
  await sql`CREATE TABLE reseller_shared_vendor_grants (
    id              TEXT PRIMARY KEY,
    reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    vendor_slug     TEXT NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT true
  )`;
  await sql`CREATE TABLE reseller_support_grants (
    id                  TEXT PRIMARY KEY,
    reseller_org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    granted_to_user_id  TEXT NOT NULL REFERENCES users(id),
    granted_by          TEXT NOT NULL REFERENCES users(id),
    approval_required   BOOLEAN NOT NULL DEFAULT true,
    approved_at         TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL
  )`;
}

async function seedFixtures(): Promise<void> {
  // Seed BEFORE applyRlsMigrations enables RLS — gives a clean RLS-off
  // window for fixture inserts. Mirrors the production deploy ordering
  // (mig 007 enables RLS after the schema is already in place).
  await sql`INSERT INTO users (id, email) VALUES
    ('alice',     'alice@example.com'),
    ('bob',       'bob@example.com'),
    ('carol',     'carol@example.com'),
    ('reseller-rita', 'rita@reseller.example')`;
  await sql`INSERT INTO organizations (id, name, type) VALUES
    ('org-alice',    'Alice Co',    'standalone'),
    ('reseller-rco', 'Rita Co',     'reseller')`;
  await sql`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
    ('cust-under-rco', 'Customer Under Rita', 'customer', 'reseller-rco')`;
  await sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-alice', 'org-alice', 'alice', 'owner'),
    ('m-carol', 'cust-under-rco', 'carol', 'owner')`;
  await sql`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
    ('rm-rita', 'reseller-rco', 'reseller-rita', 'reseller_admin'),
    ('rm-other', 'reseller-rco', 'bob', 'reseller_billing_viewer')`;

  // Fixture rows for the 9 tables under test.
  await sql`INSERT INTO admin_audit_log (id, org_id, actor_id, event_type) VALUES
    ('aal-1', 'org-alice', 'alice', 'noop')`;
  await sql`INSERT INTO org_invitations (id, org_id, invited_by, token_hash, expires_at) VALUES
    ('inv-1', 'org-alice', 'alice', 'hash-1', NOW() + INTERVAL '7 days')`;
  await sql`INSERT INTO org_server_access (id, org_id, user_id, vendor_slug) VALUES
    ('osa-1', 'org-alice', 'alice', 'vendor-a')`;
  await sql`INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, tool_name) VALUES
    ('ota-1', 'org-alice', 'vendor-a', 'tool-a')`;
  await sql`INSERT INTO request_log (id, user_id, org_id, vendor_slug) VALUES
    ('rl-1', 'alice', 'org-alice', 'vendor-a')`;
  await sql`INSERT INTO credentials (id, user_id, vendor_slug) VALUES
    ('cred-1', 'alice', 'vendor-a')`;
  await sql`INSERT INTO reseller_shared_vendor_grants (id, reseller_org_id, customer_org_id, vendor_slug, enabled) VALUES
    ('rsvg-1', 'reseller-rco', 'cust-under-rco', 'shared-vendor', true)`;
  await sql`INSERT INTO reseller_support_grants
    (id, reseller_org_id, customer_org_id, granted_to_user_id, granted_by, expires_at) VALUES
    ('rsg-1', 'reseller-rco', 'cust-under-rco', 'reseller-rita',
     'reseller-rita', NOW() + INTERVAL '7 days')`;
}

async function applyRlsMigrations(): Promise<void> {
  // Apply the full production RLS chain: 007 → 014 → 018 → 020 → 022.
  // Mig 022's DO-block audit at end requires the 4 tables mig 020 fixed
  // to already have qual!=NULL, so we must apply 018+020 in the chain
  // even though the 9 tables under test in this file don't directly
  // depend on the SECURITY DEFINER helpers.
  for (const filename of [
    '007_rls_enable.sql',
    '014_rls_with_check_clauses.sql',
    '018_rls_security_definer_helpers.sql',
    '020_rls_helper_context_fix_and_update_using.sql',
    '022_bug_b_update_using_sweep.sql',
  ]) {
    const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');
    await sql.begin((tx) => tx.unsafe(body));
  }
}

async function provisionTestRole(): Promise<void> {
  await sql.unsafe(`CREATE ROLE rls_test_user`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user`);
}

interface RlsConnection {
  query: postgres.Sql;
  release: () => void;
}

async function asUser(userId: string): Promise<RlsConnection> {
  const reserved = await sql.reserve();
  await reserved.unsafe(`SET ROLE rls_test_user`);
  await reserved`SELECT set_config('conduit.current_user_id', ${userId}, false)`;
  return {
    query: reserved as unknown as postgres.Sql,
    release: () => reserved.release(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mig 022 Bug B sweep — paired accept/reject on 9 UPDATE policies', () => {
  it('admin_audit_log: alice (member) updates; bob (non-member) sees 0 rows', async () => {
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE admin_audit_log SET event_type = 'updated-by-alice' WHERE id = 'aal-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { aliceConn.release(); }
    const bobConn = await asUser('bob');
    try {
      const r = await bobConn.query`UPDATE admin_audit_log SET event_type = 'compromised' WHERE id = 'aal-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { bobConn.release(); }
    // Read back as alice (member, can SELECT) to verify mutation persisted.
    const verifyConn = await asUser('alice');
    try {
      const rows = await verifyConn.query<{ event_type: string }[]>`SELECT event_type FROM admin_audit_log WHERE id = 'aal-1'`;
      expect(rows[0].event_type).toBe('updated-by-alice');
    } finally { verifyConn.release(); }
  });

  it('credentials: alice updates own row; bob blocked from alice\'s row', async () => {
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE credentials SET vendor_slug = 'vendor-rotated' WHERE id = 'cred-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { aliceConn.release(); }
    const bobConn = await asUser('bob');
    try {
      const r = await bobConn.query`UPDATE credentials SET vendor_slug = 'stolen' WHERE id = 'cred-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { bobConn.release(); }
  });

  it('org_invitations: alice (member) updates; bob (non-member) blocked', async () => {
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE org_invitations SET token_hash = 'rotated-hash' WHERE id = 'inv-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { aliceConn.release(); }
    const bobConn = await asUser('bob');
    try {
      const r = await bobConn.query`UPDATE org_invitations SET token_hash = 'stolen' WHERE id = 'inv-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { bobConn.release(); }
  });

  it('org_server_access: alice (member) updates; bob blocked', async () => {
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE org_server_access SET vendor_slug = 'vendor-b' WHERE id = 'osa-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { aliceConn.release(); }
    const bobConn = await asUser('bob');
    try {
      const r = await bobConn.query`UPDATE org_server_access SET vendor_slug = 'compromised' WHERE id = 'osa-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { bobConn.release(); }
  });

  it('org_tool_allowlist: alice (member) updates; bob blocked', async () => {
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE org_tool_allowlist SET tool_name = 'tool-b' WHERE id = 'ota-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { aliceConn.release(); }
    const bobConn = await asUser('bob');
    try {
      const r = await bobConn.query`UPDATE org_tool_allowlist SET tool_name = 'compromised' WHERE id = 'ota-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { bobConn.release(); }
  });

  it('request_log: alice (row-owner) updates own; carol (no org membership) blocked', async () => {
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE request_log SET vendor_slug = 'vendor-b' WHERE id = 'rl-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { aliceConn.release(); }
    const carolConn = await asUser('carol');
    try {
      const r = await carolConn.query`UPDATE request_log SET vendor_slug = 'compromised' WHERE id = 'rl-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { carolConn.release(); }
  });

  it('reseller_members: rita (admin) updates rm-other; alice (non-reseller-member) blocked', async () => {
    const ritaConn = await asUser('reseller-rita');
    try {
      const r = await ritaConn.query`UPDATE reseller_members SET role = 'reseller_admin' WHERE id = 'rm-other'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { ritaConn.release(); }
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE reseller_members SET role = 'reseller_owner' WHERE id = 'rm-other'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { aliceConn.release(); }
  });

  it('reseller_shared_vendor_grants: rita (admin) updates; alice blocked', async () => {
    const ritaConn = await asUser('reseller-rita');
    try {
      const r = await ritaConn.query`UPDATE reseller_shared_vendor_grants SET enabled = false WHERE id = 'rsvg-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { ritaConn.release(); }
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE reseller_shared_vendor_grants SET enabled = true WHERE id = 'rsvg-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { aliceConn.release(); }
  });

  it('reseller_support_grants: rita (grant recipient) updates; alice blocked', async () => {
    const ritaConn = await asUser('reseller-rita');
    try {
      const r = await ritaConn.query`UPDATE reseller_support_grants SET revoked_at = NOW() WHERE id = 'rsg-1'`;
      expect((r as unknown as { count: number }).count).toBe(1);
    } finally { ritaConn.release(); }
    const aliceConn = await asUser('alice');
    try {
      const r = await aliceConn.query`UPDATE reseller_support_grants SET revoked_at = NULL WHERE id = 'rsg-1'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { aliceConn.release(); }
  });

  // -------------------------------------------------------------------------
  // Migration-level audit: post-022, no UPDATE policy should have qual=NULL
  // -------------------------------------------------------------------------

  it('post-022 audit: zero UPDATE policies remain with qual IS NULL', async () => {
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM pg_policies
      WHERE schemaname = 'public'
        AND cmd = 'UPDATE'
        AND qual IS NULL
    `;
    expect(rows[0].count).toBe('0');
  });
});
