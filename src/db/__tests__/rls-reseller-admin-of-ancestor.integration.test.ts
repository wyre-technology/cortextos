/**
 * Migration 023 — conduit_is_reseller_admin_of_ancestor SECURITY DEFINER
 * helper for bounded-depth-3 ancestor lookup.
 *
 * Paired accept/reject coverage at each depth + boundary case at depth 3
 * (helper must bound walk and refuse to recognize ancestors beyond
 * mig-021's MAX_ORG_DEPTH=3 cap).
 *
 * Companion file: rls-with-check.integration.test.ts (mig 014/020 +
 * helper-context tests) and rls-bug-b-sweep.integration.test.ts (mig
 * 022). This file uses its own testcontainer so the connection pool's
 * role state is clean.
 *
 * Test cases:
 *   - Depth 0 accept: target is reseller-self, user is reseller_admin
 *   - Depth 1 accept: target is customer, ancestor is reseller, user is admin
 *   - Depth 2 accept: target is sub-customer, ancestor (grandparent) is reseller, user is admin
 *   - Depth 3 reject: synthetic depth-3 walk (bypasses trigger to fixture),
 *                     helper's bound stops walk before reaching ancestor
 *   - Wrong-reseller reject: depth 2 chain rooted at reseller-A,
 *                            user is admin of reseller-B (no relationship)
 *   - Non-admin reject: depth 2 chain, user holds reseller_billing_viewer
 *                       (not owner/admin)
 *   - Defensive NULL inputs: NULL user_id or NULL target_org_id returns false
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
  await applyHelperMigrations();
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Bootstrap — minimum schema for ancestor walks
// ---------------------------------------------------------------------------

async function bootstrapSchema(): Promise<void> {
  await sql`CREATE TABLE users (
    id    TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
  )`;

  // No enforce_org_hierarchy trigger here — fixtures inject the
  // depth-3 chain (and the synthetic depth-4 case) directly. The
  // helper's bound (not the trigger) is what we're testing.
  await sql`CREATE TABLE organizations (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'standalone',
    parent_org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE org_members (
    id      TEXT PRIMARY KEY,
    org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  )`;

  await sql`CREATE TABLE reseller_members (
    id              TEXT PRIMARY KEY,
    reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    UNIQUE (reseller_org_id, user_id)
  )`;
}

// ---------------------------------------------------------------------------
// Seed — two reseller hierarchies plus a synthetic depth-4 chain
//
//   reseller-A (id=res-a) ← rita (reseller_admin), vera (billing_viewer)
//     └── cust-a (id=cust-a) ← carol (owner of cust-a; depth-1 from res-a)
//           └── sub-cust-a (id=sub-cust-a) ← sam (owner; depth-2 from res-a)
//                 └── sub-sub-cust-a (id=sub-sub-cust-a; depth-3 synthetic,
//                                     would be rejected by mig 021 trigger
//                                     in production; helper-bound test)
//
//   reseller-B (id=res-b) ← bob (reseller_admin)
//     └── cust-b (id=cust-b)
// ---------------------------------------------------------------------------

async function seedFixtures(): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES
    ('rita', 'rita@reseller-a.example'),
    ('vera', 'vera@reseller-a.example'),
    ('bob',  'bob@reseller-b.example'),
    ('carol', 'carol@cust-a.example'),
    ('sam',  'sam@sub-cust-a.example')`;

  // Two separate reseller trees + one synthetic depth-4 chain on tree A.
  await sql`INSERT INTO organizations (id, name, type) VALUES
    ('res-a', 'Reseller A', 'reseller'),
    ('res-b', 'Reseller B', 'reseller')`;
  await sql`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
    ('cust-a',          'Customer A',            'customer', 'res-a'),
    ('cust-b',          'Customer B',            'customer', 'res-b'),
    ('sub-cust-a',      'Sub-Customer A',        'customer', 'cust-a'),
    ('sub-sub-cust-a',  'Sub-Sub-Customer A',    'customer', 'sub-cust-a')`;

  await sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-carol', 'cust-a',     'carol', 'owner'),
    ('m-sam',   'sub-cust-a', 'sam',   'owner')`;

  await sql`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
    ('rm-rita', 'res-a', 'rita', 'reseller_admin'),
    ('rm-vera', 'res-a', 'vera', 'reseller_billing_viewer'),
    ('rm-bob',  'res-b', 'bob',  'reseller_admin')`;
}

async function applyHelperMigrations(): Promise<void> {
  // Apply only mig 023. The new helper depends on the organizations +
  // reseller_members tables (both bootstrapped above); it does NOT
  // depend on the other helpers in mig 018/020 or on any RLS policies.
  //
  // Skipping 018/020 keeps the test surface minimal — those migrations
  // create policies for org_teams, org_credentials, etc. that we don't
  // bootstrap and don't need to exercise here. Helper-function tests
  // should be isolatable from full RLS-policy stack tests.
  for (const filename of ['023_reseller_admin_of_ancestor_helper.sql']) {
    const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
    // Strip outer BEGIN/COMMIT — sql.begin() wraps in its own transaction.
    // Same shape as rls-bug-b-sweep.integration.test.ts.
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');
    await sql.begin((tx) => tx.unsafe(body));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function callHelper(userId: string | null, targetOrgId: string | null): Promise<boolean> {
  const result = await sql<{ ok: boolean }[]>`
    SELECT conduit_is_reseller_admin_of_ancestor(${userId}, ${targetOrgId}) AS ok
  `;
  return result[0].ok;
}

describe('conduit_is_reseller_admin_of_ancestor (mig 023)', () => {
  describe('accept cases — user is reseller_admin of an ancestor in chain', () => {
    it('depth 0: target is reseller-self, user is admin of that reseller', async () => {
      // rita is admin of res-a; target = res-a itself (no walk needed).
      expect(await callHelper('rita', 'res-a')).toBe(true);
    });

    it('depth 1: target is customer, user is admin of parent reseller', async () => {
      // rita is admin of res-a; target = cust-a (1 walk up to res-a).
      expect(await callHelper('rita', 'cust-a')).toBe(true);
    });

    it('depth 2: target is sub-customer, user is admin of grandparent reseller', async () => {
      // rita is admin of res-a; target = sub-cust-a (2 walks up to res-a).
      expect(await callHelper('rita', 'sub-cust-a')).toBe(true);
    });
  });

  describe('reject cases — boundary / mismatch', () => {
    it('depth 3 reject: synthetic chain exceeds bound; helper stops before reaching ancestor', async () => {
      // sub-sub-cust-a is depth-3 from res-a (3 walks up). Helper bound
      // is `c.depth < 2` in the recursive step, so the walk visits
      // depths 0, 1, 2 only. res-a sits at depth 3 from sub-sub-cust-a
      // and is NOT visited; helper returns false even though rita is
      // legitimately admin of res-a.
      //
      // This case shouldn't exist in production (mig 021 trigger rejects
      // INSERT). Test exists to pin the helper's bound, not to validate
      // a real production scenario.
      expect(await callHelper('rita', 'sub-sub-cust-a')).toBe(false);
    });

    it('wrong-reseller reject: chain rooted at res-a; user is admin of res-b only', async () => {
      // bob is admin of res-b; target = sub-cust-a (rooted at res-a).
      // No path from bob's reseller-admin role to any ancestor of
      // sub-cust-a.
      expect(await callHelper('bob', 'sub-cust-a')).toBe(false);
    });

    it('non-admin reject: user has reseller_billing_viewer role, not owner/admin', async () => {
      // vera has reseller_billing_viewer on res-a; target = sub-cust-a
      // (legitimate reseller_admin would accept). Helper restricts to
      // owner/admin only.
      expect(await callHelper('vera', 'sub-cust-a')).toBe(false);
    });

    it('non-member reject: user has no reseller_members row at all', async () => {
      // carol is org-owner of cust-a but has no reseller_members row.
      // Helper requires reseller-admin role to accept.
      expect(await callHelper('carol', 'sub-cust-a')).toBe(false);
    });
  });

  describe('defensive — NULL inputs', () => {
    it('NULL user_id returns false (does not raise)', async () => {
      expect(await callHelper(null, 'res-a')).toBe(false);
    });

    it('NULL target_org_id returns false (does not raise)', async () => {
      expect(await callHelper('rita', null)).toBe(false);
    });

    it('both NULL returns false (does not raise)', async () => {
      expect(await callHelper(null, null)).toBe(false);
    });
  });

  describe('non-existent target', () => {
    it('returns false for unknown target_org_id (no chain to walk)', async () => {
      expect(await callHelper('rita', 'nonexistent-org')).toBe(false);
    });
  });
});
