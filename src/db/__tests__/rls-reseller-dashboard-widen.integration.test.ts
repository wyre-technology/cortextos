/**
 * Migration 030 — request_log_select widened to any reseller role.
 *
 * Track C S2 (the reseller-scoped customer dashboard) authorizes ANY reseller
 * role at the app layer, but request_log_select gated the reseller branch on
 * conduit_is_reseller_admin_of_parent (owner/admin only). A
 * reseller_support_agent / reseller_billing_viewer therefore got a 200 page
 * with silently-empty data. Aaron ruled WIDEN; migration 030 swaps that one
 * policy's reseller branch to conduit_is_reseller_member_of_parent (any role).
 *
 * This is the regression guard for that divergence. It is NOT mocked — it
 * runs dashboardService against request_log on the request-path RLS
 * connection (the NOBYPASSRLS pool, real RLS), AS each reseller role, and
 * asserts what they actually see:
 *
 *   - reseller_support_agent of the parent  -> sees the customer's rows
 *   - reseller_billing_viewer of the parent -> sees the customer's rows
 *   - reseller_admin of the parent          -> still sees them (widen is a
 *                                              superset — prior grant intact)
 *   - reseller_admin of a DIFFERENT reseller -> sees zero (paired negative;
 *                                              tenant isolation is intact)
 *
 * The mocked unit test in src/reseller/routes.test.ts could not catch this —
 * it stubbed dashboardService, so it never hit the RLS path that diverged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPools, runInRequestContext, closePools } from '../context.js';
import { DashboardService } from '../../dashboard/dashboard-service.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const REQUEST_ROLE = 'conduit_request_test';
const REQUEST_ROLE_PW = 'testpw';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
const dashboard = new DashboardService();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // --- schema ---------------------------------------------------------------
  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'standalone',
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
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      vendor_slug TEXT NOT NULL, tool_name TEXT, status_code INTEGER NOT NULL,
      response_time_ms INTEGER, source TEXT DEFAULT 'mcp',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  // conduit_is_member_of_org — migration 018's helper. request_log_select
  // (rebuilt by mig 030 below) calls it; define it before applying 030.
  await admin`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$
      SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = p_user_id);
    $$`;

  // --- RLS on request_log + apply the REAL migration 030 --------------------
  await admin`ALTER TABLE request_log ENABLE ROW LEVEL SECURITY`;
  await admin`ALTER TABLE request_log FORCE ROW LEVEL SECURITY`;
  const mig030 = readFileSync(
    join(REPO_ROOT, 'migrations', '030_widen_request_log_reseller_read.sql'),
    'utf8',
  )
    .replace(/^\s*BEGIN\s*;\s*$/gim, '')
    .replace(/^\s*COMMIT\s*;\s*$/gim, '');
  await admin.begin((tx) => tx.unsafe(mig030));

  // --- request-path role: NOBYPASSRLS so RLS genuinely enforces -------------
  await admin.unsafe(
    `CREATE ROLE ${REQUEST_ROLE} LOGIN PASSWORD '${REQUEST_ROLE_PW}' NOBYPASSRLS`,
  );
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${REQUEST_ROLE}`);
  await admin.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${REQUEST_ROLE}`,
  );

  // --- seed: reseller-A owns customer-A; reseller-B is unrelated ------------
  await admin`INSERT INTO users (id, email) VALUES
    ('sage', 'sage@res-a.example'), ('val', 'val@res-a.example'),
    ('rita', 'rita@res-a.example'), ('bob', 'bob@res-b.example'),
    ('carol', 'carol@cust-a.example')`;
  await admin`INSERT INTO organizations (id, name, type) VALUES
    ('res-a', 'Reseller A', 'reseller'), ('res-b', 'Reseller B', 'reseller')`;
  await admin`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
    ('cust-a', 'Customer A', 'customer', 'res-a')`;
  await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-carol', 'cust-a', 'carol', 'owner')`;
  await admin`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
    ('rm-sage', 'res-a', 'sage', 'reseller_support_agent'),
    ('rm-val',  'res-a', 'val',  'reseller_billing_viewer'),
    ('rm-rita', 'res-a', 'rita', 'reseller_admin'),
    ('rm-bob',  'res-b', 'bob',  'reseller_admin')`;
  // request_log rows for customer-A — explicit org_id (the dominant dataset).
  for (let i = 0; i < 4; i++) {
    await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
      VALUES (${'rl-' + i}, 'carol', 'cust-a', 'datto-rmm', 'devices.list', 200, 100)`;
  }

  initPools({ systemUrl: superuserUri, requestUrl: requestUri(superuserUri) });
}, 120_000);

afterAll(async () => {
  await closePools();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

function requestUri(superuserUri: string): string {
  const u = new URL(superuserUri);
  u.username = REQUEST_ROLE;
  u.password = REQUEST_ROLE_PW;
  return u.toString();
}

/** Customer-A's vendor breakdown as seen by `userId` on the request path. */
function vendorBreakdownAs(userId: string) {
  return runInRequestContext(userId, () => dashboard.getVendorBreakdown('cust-a'));
}

describe('migration 030 — reseller dashboard read widen', () => {
  it('reseller_support_agent of the parent sees the customer request_log', async () => {
    const rows = await vendorBreakdownAs('sage');
    // The regression: pre-030 this collapsed to [] (empty-200). Now it is real.
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ vendor: 'datto-rmm', totalCalls: 4 });
  });

  it('reseller_billing_viewer of the parent sees the customer request_log', async () => {
    const rows = await vendorBreakdownAs('val');
    expect(rows.length).toBe(1);
    expect(rows[0].totalCalls).toBe(4);
  });

  it('reseller_admin of the parent still sees it — the widen is a superset', async () => {
    const rows = await vendorBreakdownAs('rita');
    expect(rows.length).toBe(1);
    expect(rows[0].totalCalls).toBe(4);
  });

  it('a reseller_admin of a DIFFERENT reseller sees zero — tenant isolation intact', async () => {
    // Paired negative: the widen must not let an unrelated reseller in.
    const rows = await vendorBreakdownAs('bob');
    expect(rows.length).toBe(0);
  });
});
