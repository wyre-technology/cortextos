/**
 * Migration 052 — widen RLS reseller-clause to member-of-parent across 7
 * customer-facing tables (LAYER-B subtenant-RLS fix per boss msg-1781725590563).
 *
 * Test surface:
 *   1. SET-COMPLETENESS (warden HARD-REQ-b) — all 8 customer-facing tables
 *      (7 from mig 052 + request_log already widened by mig 030) have the
 *      `conduit_is_reseller_member_of_parent` clause on their SELECT policy.
 *      Enumeration is handler-grounded (not migration-derived) and asserted
 *      by querying pg_policies post-migration-apply.
 *
 *   2. POSITIVE (the regression the bug surfaced) — reseller_admin acting on
 *      a customer-org row can SELECT + INSERT + DELETE (org_members + org_credentials).
 *      Pre-mig-052 these would fail; post-mig-052 they succeed.
 *
 *   3. NEGATIVE — cross-reseller defense-in-depth (warden HARD-REQ-f).
 *      Reseller-A (no reseller_members row linking to customer-B's parent)
 *      sees ZERO rows on customer-B's tables even though the GUC is set.
 *      The point of Option-2 (RLS-widening) over a runAsSystem-bypass:
 *      RLS still enforces tenant isolation.
 *
 *   4. SOFT-DELETE / ACTIVE-ONLY (warden HARD-REQ-e) — removing the reseller_members
 *      row revokes access. Substrate uses hard delete (reseller_members has no
 *      deleted_at column on main); the test removes the row + asserts RLS rejects.
 *      If a future mig adds deleted_at, the helper body would need updating to
 *      preserve the test's intent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const REQUEST_ROLE = 'conduit_request_test_052';
const REQUEST_ROLE_PW = 'testpw';

/**
 * Handler-grounded SET-COMPLETENESS list. Every table touched by a customer-
 * detail read OR write that goes through the request-path RLS connection.
 * If a future PR adds a customer-detail handler that queries a NEW table,
 * THAT table MUST be added here + a new clause added to the migration.
 *
 * SOURCE-OF-TRUTH cross-link (analyst NIT-1, #440 fold-in): the table-set is
 * derived from the customer-detail handler-map enumerated at
 * `pearl/deliverables/subtenant-write-buildscope.md`. When LAYER-C handler-
 * growth adds a customer-detail handler that queries a NEW table (e.g.,
 * `org_consents` for an MSA-display tab, `subscriptions` for a billing-detail
 * tab, etc.), update BOTH this array AND the corresponding migration clause
 * SIMULTANEOUSLY. A programmatic handler-SQL-introspection test (auto-detect
 * orphan tables by grepping handler sources) is the next-iteration
 * automation, banked as analyst defer-future per #440 triangle.
 */
const CUSTOMER_FACING_TABLES = [
  'organizations',          // mig 052
  'org_members',            // mig 052
  'org_credentials',        // mig 052
  'org_invitations',        // mig 052
  'org_tool_allowlist',     // mig 052
  'org_server_access',      // mig 052
  'admin_audit_log',        // mig 052
  'request_log',            // mig 030 (already widened — included for SET-COMPLETENESS witness)
] as const;

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let requestPool: postgres.Sql;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // Minimum schema to apply mig 030 + 052 against.
  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'standalone',
      parent_org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE
    )`;
  await admin`
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, UNIQUE (org_id, user_id)
    )`;
  await admin`
    CREATE TABLE reseller_members (
      id TEXT PRIMARY KEY, reseller_org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, UNIQUE (reseller_org_id, user_id)
    )`;
  await admin`
    CREATE TABLE org_credentials (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, vendor_slug TEXT NOT NULL,
      payload TEXT NOT NULL
    )`;
  await admin`
    CREATE TABLE org_invitations (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL
    )`;
  await admin`
    CREATE TABLE org_tool_allowlist (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, vendor_slug TEXT NOT NULL
    )`;
  await admin`
    CREATE TABLE org_server_access (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      vendor_slug TEXT NOT NULL
    )`;
  await admin`
    CREATE TABLE admin_audit_log (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT,
      event_type TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      vendor_slug TEXT NOT NULL, status_code INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  // Helpers from mig 018 (minimum set referenced by mig 052's clauses).
  await admin`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$
      SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = p_user_id);
    $$`;
  await admin`
    CREATE OR REPLACE FUNCTION conduit_is_reseller_admin_of_parent(p_user_id text, p_child_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$
      SELECT EXISTS (
        SELECT 1 FROM organizations o
        JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
        WHERE o.id = p_child_org_id
          AND rm.user_id = p_user_id
          AND rm.role IN ('reseller_owner','reseller_admin')
      );
    $$`;
  // Stub helpers referenced by some policies but not load-bearing for this test.
  await admin`
    CREATE OR REPLACE FUNCTION conduit_is_reseller_member_of(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$ SELECT FALSE $$`;
  await admin`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_child_under(p_user_id text, p_root_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$ SELECT FALSE $$`;
  await admin`
    CREATE OR REPLACE FUNCTION conduit_has_active_support_grant_for(p_user_id text, p_grant_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$ SELECT FALSE $$`;

  // Apply mig 030 + 052.
  const stripTx = (sql: string): string =>
    sql.replace(/^\s*BEGIN\s*;\s*$/gim, '').replace(/^\s*COMMIT\s*;\s*$/gim, '');
  const mig030 = stripTx(readFileSync(join(REPO_ROOT, 'migrations', '030_widen_request_log_reseller_read.sql'), 'utf8'));
  await admin.begin((tx) => tx.unsafe(mig030));
  const mig052 = stripTx(readFileSync(join(REPO_ROOT, 'migrations', '052_widen_reseller_member_clause_all_customer_tables.sql'), 'utf8'));
  await admin.begin((tx) => tx.unsafe(mig052));

  // Enable RLS on all 8 tables.
  for (const t of CUSTOMER_FACING_TABLES) {
    await admin.unsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await admin.unsafe(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  }

  // Create the request-path role (NOBYPASSRLS — RLS genuinely enforces).
  await admin.unsafe(`CREATE ROLE ${REQUEST_ROLE} LOGIN PASSWORD '${REQUEST_ROLE_PW}' NOBYPASSRLS`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${REQUEST_ROLE}`);
  await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${REQUEST_ROLE}`);

  const requestUri = superuserUri
    .replace(/postgres:\/\/[^@]+@/, `postgres://${REQUEST_ROLE}:${REQUEST_ROLE_PW}@`);
  requestPool = postgres(requestUri, { max: 4, onnotice: () => undefined });
}, 120_000);

afterAll(async () => {
  await requestPool?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

// -----------------------------------------------------------------------
// Helper: run `fn` with the request-path role's session GUC set to the user.
// -----------------------------------------------------------------------
async function asUser<T>(userId: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const result = await requestPool.begin(async (tx) => {
    await tx`SELECT set_config('conduit.current_user_id', ${userId}, true)`;
    return await fn(tx as unknown as postgres.Sql);
  });
  return result as unknown as T;
}

// =============================================================================

describe('mig 052 — SET-COMPLETENESS (warden HARD-REQ-b)', () => {
  it('all 8 customer-facing tables have the conduit_is_reseller_member_of_parent clause on their SELECT policy', async () => {
    // Query pg_policies for the policy definition text + assert the helper
    // is referenced. The DROP+CREATE in the migration means the policy is
    // present iff applied — orphan = no helper-mention.
    const policies = await admin<{ schemaname: string; tablename: string; policyname: string; qual: string | null }[]>`
      SELECT schemaname, tablename, policyname, qual
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = ANY(${CUSTOMER_FACING_TABLES as unknown as string[]})
         AND policyname LIKE '%_select'
    `;

    for (const table of CUSTOMER_FACING_TABLES) {
      const row = policies.find((p) => p.tablename === table);
      expect(row, `SET-COMPLETENESS: ${table} must have a *_select policy referencing conduit_is_reseller_member_of_parent`).toBeDefined();
      expect(row?.qual ?? '', `${table}._select policy: clause must mention conduit_is_reseller_member_of_parent`)
        .toContain('conduit_is_reseller_member_of_parent');
    }
  });

  it('the 7 mig-052 tables also have member-of-parent on their INSERT policy (writes inherit the widening)', async () => {
    const mig052Tables = CUSTOMER_FACING_TABLES.filter((t) => t !== 'request_log');
    const policies = await admin<{ tablename: string; policyname: string; with_check: string | null }[]>`
      SELECT tablename, policyname, with_check
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = ANY(${mig052Tables as unknown as string[]})
         AND policyname LIKE '%_insert'
    `;

    // organizations table doesn't have a *_insert policy widened by mig 052
    // (org creation is a different surface; skip it from this assertion).
    for (const table of mig052Tables.filter((t) => t !== 'organizations')) {
      const row = policies.find((p) => p.tablename === table);
      expect(row, `SET-COMPLETENESS write: ${table} must have a *_insert policy`).toBeDefined();
      expect(row?.with_check ?? '', `${table}._insert WITH CHECK must include conduit_is_reseller_member_of_parent`)
        .toContain('conduit_is_reseller_member_of_parent');
    }
  });
});

// =============================================================================

describe('mig 052 — POSITIVE: reseller-of-parent (any role) reads + writes customer-org rows', () => {
  beforeAll(async () => {
    // Reseller-A org + customer-A-1 (parent_org_id=resellerA)
    await admin`INSERT INTO organizations (id, name, type) VALUES ('reseller-A', 'Reseller A', 'reseller')`;
    await admin`INSERT INTO organizations (id, name, type, parent_org_id) VALUES ('customer-A-1', 'Customer A-1', 'customer', 'reseller-A')`;
    await admin`INSERT INTO users (id, email) VALUES ('op-a-admin', 'op-a-admin@a.test'), ('op-a-support', 'op-a-support@a.test'), ('customer-owner', 'co@a.test')`;
    await admin`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
      ('rma-1', 'reseller-A', 'op-a-admin', 'reseller_admin'),
      ('rma-2', 'reseller-A', 'op-a-support', 'reseller_support_agent')`;
    await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES ('om-c1', 'customer-A-1', 'customer-owner', 'owner')`;
    await admin`INSERT INTO org_credentials (id, org_id, vendor_slug, payload) VALUES ('cred-c1-okta', 'customer-A-1', 'okta', '{}')`;
  });

  it('reseller_admin of customer-A-1.parent (=reseller-A) can SELECT customer-A-1.org_members', async () => {
    const rows = await asUser('op-a-admin', (tx) =>
      tx<{ id: string }[]>`SELECT id FROM org_members WHERE org_id = 'customer-A-1'`
    );
    expect(rows.map((r) => r.id)).toContain('om-c1');
  });

  it('reseller_support_agent of customer-A-1.parent ALSO sees customer-A-1.org_members (mig 052 widens to any-role)', async () => {
    const rows = await asUser('op-a-support', (tx) =>
      tx<{ id: string }[]>`SELECT id FROM org_members WHERE org_id = 'customer-A-1'`
    );
    expect(rows.map((r) => r.id)).toContain('om-c1');
  });

  it('reseller_admin can INSERT a new org_credentials row on customer-A-1 (write-side regression closure)', async () => {
    await asUser('op-a-admin', (tx) => tx`
      INSERT INTO org_credentials (id, org_id, vendor_slug, payload)
      VALUES ('cred-new-by-operator', 'customer-A-1', 'datto-rmm', '{}')
    `);
    const rows = await admin<{ id: string }[]>`SELECT id FROM org_credentials WHERE id = 'cred-new-by-operator'`;
    expect(rows.length).toBe(1);
  });

  it('reseller_admin can DELETE an org_credentials row on customer-A-1', async () => {
    await asUser('op-a-admin', (tx) => tx`DELETE FROM org_credentials WHERE id = 'cred-c1-okta'`);
    const rows = await admin<{ id: string }[]>`SELECT id FROM org_credentials WHERE id = 'cred-c1-okta'`;
    expect(rows.length).toBe(0);
  });

  it('reseller_support_agent CAN insert at the RLS layer (widening is uniform — analyst FIND-1)', async () => {
    // ANALYST FIND-1 fold-in (#440 triangle, boss msg-1781726347940):
    //
    // The RLS-layer widening in mig 052 is UNIFORM across all member-of-parent
    // roles (any role: reseller_owner / reseller_admin / reseller_support_agent
    // / reseller_billing_viewer). At the RLS substrate, support_agent CAN
    // insert into customer-org tables.
    //
    // CONTRACT CROSS-LAYER (documented here for reviewer clarity):
    // LAYER-A (app-layer actingAs binding via mapResellerRoleToCustomerRole)
    // intentionally NARROWS the write-path to reseller_admin-only — only
    // reseller_admin can establish a /switch binding; non-admin roles
    // (support_agent / billing_viewer) get null/reject from the closed-set
    // mapper and never reach the write-path in production. Per boss msg-
    // 1781726347940, that NARROWING is a deliberate app-layer policy on top
    // of the BROAD RLS defense-in-depth. The two layers cooperate by
    // RLS-widen + app-narrow: defense-in-depth at the substrate + policy-
    // tightening at the surface.
    //
    // This test asserts the BROAD RLS layer is uniform (support_agent CAN
    // insert at the RLS substrate). The NARROW app-layer block is verified
    // separately by the reseller-routes test suite (src/reseller/routes.test.ts
    // requireResellerRole('reseller_admin') gates) — not in scope here.
    await asUser('op-a-support', (tx) => tx`
      INSERT INTO org_credentials (id, org_id, vendor_slug, payload)
      VALUES ('cred-by-support-rls-only', 'customer-A-1', 'auvik', '{}')
    `);
    const rows = await admin<{ id: string }[]>`SELECT id FROM org_credentials WHERE id = 'cred-by-support-rls-only'`;
    expect(rows.length).toBe(1);
  });
});

// =============================================================================

describe('mig 052 — NEGATIVE: cross-reseller defense-in-depth (warden HARD-REQ-f)', () => {
  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, type) VALUES ('reseller-B', 'Reseller B', 'reseller')`;
    await admin`INSERT INTO organizations (id, name, type, parent_org_id) VALUES ('customer-B-1', 'Customer B-1', 'customer', 'reseller-B')`;
    await admin`INSERT INTO users (id, email) VALUES ('op-b-admin', 'op-b-admin@b.test'), ('cust-b-owner', 'cbo@b.test')`;
    await admin`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES ('rmb-1', 'reseller-B', 'op-b-admin', 'reseller_admin')`;
    await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES ('om-b1', 'customer-B-1', 'cust-b-owner', 'owner')`;
    await admin`INSERT INTO org_credentials (id, org_id, vendor_slug, payload) VALUES ('cred-b1-okta', 'customer-B-1', 'okta', '{}')`;
  });

  it('reseller-A admin cannot SELECT customer-B-1 rows (different reseller-tree)', async () => {
    const rows = await asUser('op-a-admin', (tx) =>
      tx<{ id: string }[]>`SELECT id FROM org_members WHERE org_id = 'customer-B-1'`
    );
    expect(rows.length).toBe(0);
  });

  it('reseller-A admin cannot INSERT into customer-B-1.org_credentials', async () => {
    await expect(
      asUser('op-a-admin', (tx) => tx`
        INSERT INTO org_credentials (id, org_id, vendor_slug, payload)
        VALUES ('cred-illegal-cross-tenant', 'customer-B-1', 'hacker', '{}')
      `),
    ).rejects.toThrow();
    const rows = await admin<{ id: string }[]>`SELECT id FROM org_credentials WHERE id = 'cred-illegal-cross-tenant'`;
    expect(rows.length).toBe(0);
  });
});

// =============================================================================

describe('mig 052 — ACTIVE-ONLY: revoked reseller_members revokes RLS access (warden HARD-REQ-e)', () => {
  beforeAll(async () => {
    // Use op-a-admin from positive section; ensure their access is intact pre-revoke.
    await admin`INSERT INTO org_credentials (id, org_id, vendor_slug, payload) VALUES ('cred-pre-revoke', 'customer-A-1', 'auvik', '{}')`;
  });

  it('pre-revoke: operator can SELECT', async () => {
    const rows = await asUser('op-a-admin', (tx) =>
      tx<{ id: string }[]>`SELECT id FROM org_credentials WHERE org_id = 'customer-A-1'`
    );
    expect(rows.find((r) => r.id === 'cred-pre-revoke')).toBeDefined();
  });

  it('post-revoke: removing the reseller_members row makes RLS deny', async () => {
    await admin`DELETE FROM reseller_members WHERE user_id = 'op-a-admin' AND reseller_org_id = 'reseller-A'`;
    const rows = await asUser('op-a-admin', (tx) =>
      tx<{ id: string }[]>`SELECT id FROM org_credentials WHERE org_id = 'customer-A-1'`
    );
    expect(rows.length).toBe(0);
  });
});
