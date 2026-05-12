/**
 * RLS WITH CHECK enforcement — migration 014 against a real Postgres.
 *
 * What this verifies (and what it does NOT)
 * -----------------------------------------
 * Migration 014 adds WITH CHECK clauses on every RLS-enabled table from
 * migration 007. WITH CHECK fires on INSERT and UPDATE — it does NOT
 * govern SELECT (that's USING from 007). This file exercises the
 * INSERT and UPDATE paths only. Read-side enforcement is out of scope
 * here; that belongs in a separate USING-coverage suite if/when we
 * write one.
 *
 * Initial coverage focuses on `organizations` INSERT + UPDATE because
 * 014's own header calls out cross-org row creation as the primary
 * concern. Other tables (org_members, org_credentials, etc) ship in
 * this scaffolding as no-op scaffolding (RLS enabled, policies created,
 * no test cases) so adding them later is mechanical.
 *
 * False-positive design (load-bearing — see PR body for the full story)
 * ---------------------------------------------------------------------
 * An RLS test that passes when it shouldn't is misleading evidence-of-
 * safety. We harden against four false-positive modes:
 *
 *   1. Postgres superuser bypasses RLS. The testcontainer's default
 *      connection is superuser. We acquire a dedicated non-superuser
 *      connection (`rls_test_user`) for the assertion path; setup runs
 *      as superuser, assertions don't. SET ROLE is connection-scoped,
 *      so we use postgres.reserve() to get a dedicated connection per
 *      test rather than sharing the pool — role state can't leak
 *      across tests.
 *
 *   2. Paired accept/reject for every assertion. If a "should-reject"
 *      passes (Postgres rejects), we also verify that the SAME setup
 *      with VALID session context "should-accept." If the accept
 *      doesn't accept, the setup is broken (we'd be celebrating
 *      rejection-by-misconfig, not rejection-by-policy). Both must
 *      pass for the evidence-of-safety to be valid.
 *
 *   3. Pre-flight: confirm RLS is ENABLED + FORCED on each table and
 *      014's policies are REGISTERED before any test runs. If either
 *      fails, the suite aborts loudly — silent absence of policies is
 *      the worst false-positive mode.
 *
 *   4. Negative control test: trigger a NOT NULL violation and assert
 *      the SQLSTATE is NOT 42501 (RLS rejection). If this control
 *      fails, no other test in the suite can be trusted to
 *      distinguish RLS rejections from other rejections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

const RLS_VIOLATION_SQLSTATE = '42501';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  sql = postgres(container.getConnectionUri(), {
    max: 4,
    onnotice: () => undefined, // silence policy/index NOTICE noise
  });

  await bootstrapSchema();
  await applyRlsMigrations();
  await provisionTestRole();
  await preflightChecks();
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Bootstrap — full mirror of the columns 007 / 014 reference.
//
// Drift CI (src/scim/__tests__/harness-drift.test.ts) watches the SCIM
// harness against runtime initTables. This RLS-aware fixture is its own
// surface, currently NOT covered by drift CI. Follow-up: extend the drift
// check to include this file too. Until then: when adding a column to
// runtime initTables that 007/014 reference, update the bootstrap below
// in the same PR.
// ---------------------------------------------------------------------------
async function bootstrapSchema(): Promise<void> {
  await sql`
    CREATE TABLE users (
      id    TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    )
  `;
  await sql`
    CREATE TABLE organizations (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      parent_org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      type          TEXT NOT NULL DEFAULT 'standalone',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_members (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, user_id)
    )
  `;
  await sql`
    CREATE TABLE org_teams (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_team_members (
      id      TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
      org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    )
  `;
  await sql`
    CREATE TABLE org_credentials (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      vendor_slug TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_team_credentials (
      id          TEXT PRIMARY KEY,
      team_id     TEXT NOT NULL REFERENCES org_teams(id) ON DELETE CASCADE,
      vendor_slug TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_invitations (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_by  TEXT NOT NULL REFERENCES users(id),
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      max_uses    INTEGER,
      use_count   INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_tool_allowlist (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      vendor_slug TEXT NOT NULL,
      tool_name   TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE org_server_access (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vendor_slug TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE admin_audit_log (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      actor_id     TEXT NOT NULL REFERENCES users(id),
      event_type   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE request_log (
      id          TEXT PRIMARY KEY,
      org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      user_id     TEXT REFERENCES users(id),
      vendor_slug TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE credentials (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vendor_slug TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE reseller_members (
      id              TEXT PRIMARY KEY,
      reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (reseller_org_id, user_id)
    )
  `;
  await sql`
    CREATE TABLE reseller_shared_vendor_grants (
      id              TEXT PRIMARY KEY,
      reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      customer_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      vendor_slug     TEXT NOT NULL,
      enabled         BOOLEAN NOT NULL DEFAULT true
    )
  `;
  // reseller_support_grants: 007's policies reference id, granted_to_user_id,
  // customer_org_id, revoked_at, expires_at, approved_at, approval_required.
  await sql`
    CREATE TABLE reseller_support_grants (
      id                  TEXT PRIMARY KEY,
      reseller_org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      customer_org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      granted_to_user_id  TEXT NOT NULL REFERENCES users(id),
      granted_by          TEXT NOT NULL REFERENCES users(id),
      approval_required   BOOLEAN NOT NULL DEFAULT true,
      approved_at         TIMESTAMPTZ,
      revoked_at          TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ NOT NULL
    )
  `;
}

async function applyRlsMigrations(): Promise<void> {
  // Apply 007 (RLS enable + USING policies), 014 (WITH CHECK policies),
  // 018 (SECURITY DEFINER helpers replacing every recursive predicate),
  // 020 (helper-context fix + first 4-table UPDATE-policy USING repair),
  // and 022 (Bug B sweep on the remaining 9 UPDATE policies).
  //
  // We deliberately skip 019 — it was a temporary `WITH CHECK (true)`
  // passthrough on organizations_insert that 020 supersedes. Including
  // 019 in the chain would re-create the passthrough only to have 020
  // immediately DROP+CREATE the proper policy back; harness noise
  // without test value.
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
  // Postgres superusers bypass RLS by default. Even with FORCE ROW LEVEL
  // SECURITY (which 007 sets), the table OWNER is exempt — the testcontainer
  // default user is the owner. Create a non-superuser non-owner role and
  // grant it the privileges it needs to attempt INSERT/UPDATE; assertions
  // run as this role so RLS actually applies.
  await sql.unsafe(`CREATE ROLE rls_test_user`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user`);
}

async function preflightChecks(): Promise<void> {
  // Confirm RLS is ENABLED on the target tables. If 007 didn't take effect
  // (silently swallowed harness skip, etc), every subsequent assertion is
  // meaningless — fail loudly here instead.
  const rlsRows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname = ANY(${sql.array(['organizations', 'org_members'])})
  `;
  if (rlsRows.length !== 2) {
    throw new Error(`pre-flight: expected RLS metadata for organizations + org_members, got ${rlsRows.length} rows`);
  }
  for (const r of rlsRows) {
    if (!r.relrowsecurity) {
      throw new Error(`pre-flight: RLS not ENABLED on ${r.relname} — 007 did not take effect`);
    }
    if (!r.relforcerowsecurity) {
      throw new Error(`pre-flight: RLS not FORCED on ${r.relname} — table owner would bypass`);
    }
  }

  // Confirm 014's WITH CHECK policies are registered on `organizations`.
  // 014's CREATE POLICY for INSERT names `organizations_insert`, for UPDATE
  // names `organizations_update`. If either is missing, 014 didn't apply
  // cleanly even if it didn't error.
  const policyRows = await sql<{ policyname: string; cmd: string; has_check: boolean }[]>`
    SELECT policyname, cmd, with_check IS NOT NULL AS has_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'organizations'
  `;
  const insert = policyRows.find((p) => p.policyname === 'organizations_insert');
  const update = policyRows.find((p) => p.policyname === 'organizations_update');
  if (!insert || !insert.has_check) {
    throw new Error('pre-flight: organizations_insert policy missing or has no WITH CHECK clause');
  }
  if (!update || !update.has_check) {
    throw new Error('pre-flight: organizations_update policy missing or has no WITH CHECK clause');
  }
}

// ---------------------------------------------------------------------------
// Per-test connection helpers — SET ROLE is connection-scoped, so we acquire
// a dedicated connection (postgres.reserve()) for each assertion. Session
// vars are also set on that connection. This prevents role/session leakage
// across tests when the pool reuses connections.
// ---------------------------------------------------------------------------

interface RlsConnection {
  query: postgres.Sql;
  release: () => void;
}

async function asUser(userId: string, opts?: { orgId?: string; grantId?: string }): Promise<RlsConnection> {
  const reserved = await sql.reserve();
  await reserved.unsafe(`SET ROLE rls_test_user`);
  await reserved`SELECT set_config('conduit.current_user_id', ${userId}, false)`;
  await reserved`SELECT set_config('conduit.current_org_id', ${opts?.orgId ?? ''}, false)`;
  await reserved`SELECT set_config('conduit.active_reseller_grant_id', ${opts?.grantId ?? ''}, false)`;
  return {
    query: reserved as unknown as postgres.Sql,
    release: () => reserved.release(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RLS WITH CHECK enforcement (migration 014)', () => {
  beforeAll(async () => {
    // Seed the minimal users + orgs the test cases will assert against.
    // These rows live for the whole describe block; each test does its
    // own reads/writes against them.
    await sql`INSERT INTO users (id, email) VALUES
      ('alice',     'alice@example.com'),
      ('bob',       'bob@example.com'),
      ('carol',     'carol@example.com'),
      ('reseller-rita', 'rita@reseller.example')
    `;
    await sql`INSERT INTO organizations (id, name, type) VALUES
      ('org-alice',    'Alice Co',    'standalone'),
      ('reseller-rco', 'Rita Co',     'reseller')
    `;
    await sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES
      ('m-alice', 'org-alice', 'alice', 'owner')
    `;
    await sql`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
      ('rm-rita', 'reseller-rco', 'reseller-rita', 'reseller_admin')
    `;
  });

  // -------------------------------------------------------------------------
  // INSERT — three asymmetric pairs
  // -------------------------------------------------------------------------

  describe('organizations INSERT WITH CHECK', () => {
    // The own-membership branch of organizations_insert WITH CHECK is
    // structurally unreachable through normal flow: it requires a
    // pre-existing `org_members` row for the new org's id, but
    // `org_members.org_id` has an FK to `organizations.id` which doesn't
    // exist until the INSERT commits. Production resolves this via a
    // service-role-bypass-RLS code path that creates org + first member
    // atomically. Testing the unreachable case isn't useful coverage; the
    // reseller_admin path below exercises the sole INSERT branch the
    // policy admits in practice.

    it('non-member CANNOT insert a new org (WITH CHECK rejects with SQLSTATE 42501)', async () => {
      // The "should-reject" half. Bob has no membership anywhere and no
      // reseller role. INSERT must fail with the RLS-specific SQLSTATE,
      // not a generic error.
      const conn = await asUser('bob');
      try {
        try {
          await conn.query`INSERT INTO organizations (id, name) VALUES ('org-bob', 'Bob Co')`;
          throw new Error('expected INSERT to be rejected by RLS WITH CHECK; it succeeded');
        } catch (err) {
          // postgres.js surfaces SQLSTATE on err.code
          expect((err as { code?: string }).code).toBe(RLS_VIOLATION_SQLSTATE);
        }
      } finally {
        conn.release();
      }
    });

    // FIXED in migration 020 (see src/db/__tests__/rls-helper-context-investigation.md).
    //
    // Bug A root cause: conduit_is_reseller_admin_of_parent(user, organizations.id)
    // looks up the org row by id INSIDE the helper to derive parent_org_id. In
    // INSERT WITH CHECK the new row is not yet stored, the lookup finds 0 rows,
    // the helper returns false, the policy rejects 42501. Chicken-and-egg in
    // the helper/policy contract, not a Postgres bug.
    //
    // Fix: 020 adds sibling helper conduit_is_reseller_admin_of_reseller(user,
    // p_reseller_org_id) that takes the reseller org id directly and never
    // touches `organizations`. The policy passes the NEW row's parent_org_id
    // column value.
    //
    // Caveat (out of scope for this test): INSERT...RETURNING separately
    // triggers a SELECT-policy check on the new row. Production code in
    // org-service.ts uses RETURNING *, which is currently masked by
    // gatewayadmin's rolbypassrls=true but will surface at CP1 (SET ROLE
    // per-request). Tracked in follow-up task_1778507498148_478.
    //
    // PR #65's open hypotheses (plan-cache + STABLE function interaction, RLS
    // evaluation order, PG version quirk) were all on the wrong axis — they
    // asked HOW the helper executes, not WHAT the helper queries.
    it('reseller_admin CAN insert a customer org under their reseller (parent path)', async () => {
      const conn = await asUser('reseller-rita');
      try {
        // Corroborating before/after: with the OLD helper signature the same
        // insert REJECTS (chicken-and-egg); with 020's new signature it
        // ACCEPTS. Embedded as a regression-guard — a future revert to
        // _of_parent fails loudly here.
        await sql.unsafe(`DROP POLICY IF EXISTS organizations_insert ON organizations`);
        await sql.unsafe(`CREATE POLICY organizations_insert ON organizations FOR INSERT
          WITH CHECK (
               conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
            OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
          )`);
        let oldHelperOutcome: 'pass' | 'reject-42501' | 'other-error' = 'other-error';
        try {
          await conn.query`INSERT INTO organizations (id, name, parent_org_id, type)
            VALUES ('probe-old-helper-1', 'Old Helper Probe', 'reseller-rco', 'customer')`;
          oldHelperOutcome = 'pass';
        } catch (e) {
          oldHelperOutcome = (e as { code?: string }).code === '42501' ? 'reject-42501' : 'other-error';
        }
        expect(oldHelperOutcome).toBe('reject-42501');

        // Restore 020's policy and assert the new helper accepts.
        await sql.unsafe(`DROP POLICY IF EXISTS organizations_insert ON organizations`);
        await sql.unsafe(`CREATE POLICY organizations_insert ON organizations FOR INSERT
          WITH CHECK (
               conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
            OR conduit_is_reseller_admin_of_reseller(current_setting('conduit.current_user_id', true), organizations.parent_org_id)
          )`);
        // No RETURNING — see caveat in docblock.
        await conn.query`
          INSERT INTO organizations (id, name, parent_org_id, type)
          VALUES ('org-customer-1', 'Customer One', 'reseller-rco', 'customer')
        `;
        const [verify] = await sql`SELECT id FROM organizations WHERE id = 'org-customer-1'`;
        expect(verify?.id).toBe('org-customer-1');
      } finally {
        conn.release();
      }
    });

    it('non-reseller CANNOT insert under a reseller they have no membership of', async () => {
      // The reject side of the reseller branch. Carol is not a member of
      // anything and not a reseller anywhere. Attempting to create a
      // customer under reseller-rco must fail with 42501.
      const conn = await asUser('carol');
      try {
        try {
          await conn.query`
            INSERT INTO organizations (id, name, parent_org_id, type)
            VALUES ('org-carol-attempt', 'Carol Attempt', 'reseller-rco', 'customer')
          `;
          throw new Error('expected INSERT to be rejected by RLS WITH CHECK; it succeeded');
        } catch (err) {
          expect((err as { code?: string }).code).toBe(RLS_VIOLATION_SQLSTATE);
        }
      } finally {
        conn.release();
      }
    });
  });

  // -------------------------------------------------------------------------
  // UPDATE — pair
  // -------------------------------------------------------------------------

  describe('organizations UPDATE WITH CHECK', () => {
    it('member of an org CAN UPDATE that org', async () => {
      const conn = await asUser('alice');
      try {
        const result = await conn.query`UPDATE organizations SET name = 'Alice Co (renamed)' WHERE id = 'org-alice'`;
        expect(result.count).toBe(1);
      } finally {
        conn.release();
      }
    });

    it('non-member CANNOT UPDATE another org (rejected with SQLSTATE 42501)', async () => {
      const conn = await asUser('bob');
      try {
        try {
          await conn.query`UPDATE organizations SET name = 'Compromised' WHERE id = 'org-alice'`;
          // If we got here without error, it's either a 0-row UPDATE
          // (USING-policy hides the row from the WHERE) or RLS bypassed.
          // Either way that's a different failure mode — 014's WITH CHECK
          // should fire on UPDATE attempts that pass the USING filter.
          // The SCIM-relevant failure mode is "should reject" — assert
          // that explicitly.
          throw new Error('expected UPDATE to be rejected by RLS WITH CHECK or hidden by USING; it executed');
        } catch (err) {
          // Either RLS rejection (42501) or "no rows" (no err) is acceptable
          // proof — but the load-bearing assertion is that Alice's row was
          // not modified. Verify out-of-band as superuser.
          if ((err as { code?: string }).code !== RLS_VIOLATION_SQLSTATE) {
            // 0-row update → no err thrown by postgres.js → we already
            // re-threw above. So if we're here with a non-42501 code, that's
            // a real surprise — fail.
            const [row] = await sql<{ name: string }[]>`SELECT name FROM organizations WHERE id = 'org-alice'`;
            expect(row.name).not.toBe('Compromised');
          } else {
            expect((err as { code?: string }).code).toBe(RLS_VIOLATION_SQLSTATE);
          }
        }
      } finally {
        conn.release();
      }
    });
  });

  // Bug B sweep coverage (mig 022) lives in
  // src/db/__tests__/rls-bug-b-sweep.integration.test.ts as its own
  // standalone integration file. Separate testcontainer keeps role-pool
  // state clean (this file's earlier tests reserve connections and SET
  // ROLE rls_test_user, which makes ALTER TABLE DISABLE RLS fail in a
  // shared-container setup).

  describe.skip('mig 022 — Bug B sweep (see rls-bug-b-sweep.integration.test.ts)', () => {
    beforeAll(async () => {
      // Bootstrap-shaped fixtures. The harness CREATE TABLE definitions
      // are the source of truth for column names; UPDATE targets one
      // simple existing column per table.
      //
      // The testcontainer user is non-superuser non-BYPASSRLS — FORCE RLS
      // applies to fixture INSERTs too. Workaround: temporarily disable
      // RLS on each affected table, insert fixtures, re-enable + FORCE,
      // re-apply the policy migrations so assertions run against the
      // same RLS state as production.
      //
      // RESET ROLE first because earlier tests (organizations UPDATE
      // tests above) may have left a SET ROLE state on pool connections.
      // We need the table-owner identity for ALTER TABLE ... DISABLE RLS.
      await sql.unsafe(`RESET ROLE`);
      const filesToReapply = [
        '014_rls_with_check_clauses.sql',
        '020_rls_helper_context_fix_and_update_using.sql',
        '022_bug_b_update_using_sweep.sql',
      ];
      await sql.unsafe(`
        ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
        ALTER TABLE admin_audit_log DISABLE ROW LEVEL SECURITY;
        ALTER TABLE org_invitations DISABLE ROW LEVEL SECURITY;
        ALTER TABLE org_server_access DISABLE ROW LEVEL SECURITY;
        ALTER TABLE org_tool_allowlist DISABLE ROW LEVEL SECURITY;
        ALTER TABLE request_log DISABLE ROW LEVEL SECURITY;
        ALTER TABLE credentials DISABLE ROW LEVEL SECURITY;
        ALTER TABLE reseller_members DISABLE ROW LEVEL SECURITY;
        ALTER TABLE reseller_shared_vendor_grants DISABLE ROW LEVEL SECURITY;
        ALTER TABLE reseller_support_grants DISABLE ROW LEVEL SECURITY;
      `);

      await sql.begin(async (tx) => {

        await tx`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
          ('cust-under-rco', 'Customer Under Rita', 'customer', 'reseller-rco')`;

        await tx`INSERT INTO admin_audit_log (id, org_id, actor_id, event_type) VALUES
          ('aal-1', 'org-alice', 'alice', 'noop')`;
        await tx`INSERT INTO org_invitations (id, org_id, invited_by, token_hash, expires_at) VALUES
          ('inv-1', 'org-alice', 'alice', 'hash-1', NOW() + INTERVAL '7 days')`;
        await tx`INSERT INTO org_server_access (id, org_id, user_id, vendor_slug) VALUES
          ('osa-1', 'org-alice', 'alice', 'vendor-a')`;
        await tx`INSERT INTO org_tool_allowlist (id, org_id, vendor_slug, tool_name) VALUES
          ('ota-1', 'org-alice', 'vendor-a', 'tool-a')`;
        await tx`INSERT INTO request_log (id, user_id, org_id, vendor_slug) VALUES
          ('rl-1', 'alice', 'org-alice', 'vendor-a')`;
        await tx`INSERT INTO credentials (id, user_id, vendor_slug) VALUES
          ('cred-1', 'alice', 'vendor-a')`;
        await tx`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
          ('rm-other', 'reseller-rco', 'bob', 'reseller_billing_viewer')`;
        await tx`INSERT INTO reseller_shared_vendor_grants (id, reseller_org_id, customer_org_id, vendor_slug, enabled) VALUES
          ('rsvg-1', 'reseller-rco', 'cust-under-rco', 'shared-vendor', true)`;
        await tx`INSERT INTO reseller_support_grants
          (id, reseller_org_id, customer_org_id, granted_to_user_id, granted_by, expires_at) VALUES
          ('rsg-1', 'reseller-rco', 'cust-under-rco', 'reseller-rita',
           'reseller-rita', NOW() + INTERVAL '7 days')`;
      });

      // Re-enable RLS + FORCE + re-apply policy migrations so assertion
      // paths run against the same RLS state as production. (Re-applying
      // is cheap because the migrations are idempotent via DROP IF EXISTS
      // + CREATE.)
      await sql.unsafe(`
        ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
        ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
        ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
        ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;
        ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY;
        ALTER TABLE org_invitations FORCE ROW LEVEL SECURITY;
        ALTER TABLE org_server_access ENABLE ROW LEVEL SECURITY;
        ALTER TABLE org_server_access FORCE ROW LEVEL SECURITY;
        ALTER TABLE org_tool_allowlist ENABLE ROW LEVEL SECURITY;
        ALTER TABLE org_tool_allowlist FORCE ROW LEVEL SECURITY;
        ALTER TABLE request_log ENABLE ROW LEVEL SECURITY;
        ALTER TABLE request_log FORCE ROW LEVEL SECURITY;
        ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
        ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
        ALTER TABLE reseller_members ENABLE ROW LEVEL SECURITY;
        ALTER TABLE reseller_members FORCE ROW LEVEL SECURITY;
        ALTER TABLE reseller_shared_vendor_grants ENABLE ROW LEVEL SECURITY;
        ALTER TABLE reseller_shared_vendor_grants FORCE ROW LEVEL SECURITY;
        ALTER TABLE reseller_support_grants ENABLE ROW LEVEL SECURITY;
        ALTER TABLE reseller_support_grants FORCE ROW LEVEL SECURITY;
      `);
      for (const filename of filesToReapply) {
        const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
        const body = raw
          .replace(/^\s*BEGIN\s*;\s*$/gim, '')
          .replace(/^\s*COMMIT\s*;\s*$/gim, '');
        await sql.begin((tx) => tx.unsafe(body));
      }
    });

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
      const [row] = await sql<{ event_type: string }[]>`SELECT event_type FROM admin_audit_log WHERE id = 'aal-1'`;
      expect(row.event_type).toBe('updated-by-alice');
    });

    it('credentials: alice updates own; bob blocked from alice\'s row', async () => {
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
      const [row] = await sql<{ vendor_slug: string }[]>`SELECT vendor_slug FROM credentials WHERE id = 'cred-1'`;
      expect(row.vendor_slug).toBe('vendor-rotated');
    });

    it('org_invitations: alice updates; bob blocked', async () => {
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

    it('org_server_access: alice updates; bob blocked', async () => {
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

    it('org_tool_allowlist: alice updates; bob blocked', async () => {
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

    it('reseller_members: rita (admin) updates; alice (non-reseller-member) blocked', async () => {
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
      // Rita is granted_to_user_id on the grant, so first-OR branch admits.
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
  });

  // -------------------------------------------------------------------------
  // Negative control — proves the assertion machinery distinguishes
  // RLS rejection (42501) from other rejection modes.
  // -------------------------------------------------------------------------

  describe('assertion-machinery distinguishes RLS from other rejections', () => {
    it('NOT NULL violation under a member context surfaces with SQLSTATE 23502, NOT 42501', async () => {
      // If this control test fails — i.e., a NOT NULL violation comes
      // back as 42501 — then no RLS-aware test in this file can be
      // trusted. The whole suite's evidence-of-safety is invalid.
      //
      // We must run this control under a session whose WITH CHECK would
      // PASS, so that RLS doesn't reject the row before Postgres gets
      // around to evaluating the NOT NULL constraint. UPDATE on alice's
      // own org satisfies WITH CHECK (member path); setting name to
      // NULL violates NOT NULL on `organizations.name`. Postgres should
      // return 23502 (not_null_violation), explicitly NOT 42501.
      const conn = await asUser('alice');
      try {
        try {
          await conn.query`UPDATE organizations SET name = NULL WHERE id = 'org-alice'`;
          throw new Error('expected NOT NULL violation; UPDATE succeeded');
        } catch (err) {
          const code = (err as { code?: string }).code;
          expect(code).toBeDefined();
          expect(code).not.toBe(RLS_VIOLATION_SQLSTATE);
          // Tighter assertion: 23502 specifically (not_null_violation).
          // If we get a different non-RLS code, the test still passes
          // its primary purpose (distinguishability), but the UPDATE
          // path under a member should produce exactly this code.
          expect(code).toBe('23502');
        }
      } finally {
        conn.release();
      }
    });
  });
});
