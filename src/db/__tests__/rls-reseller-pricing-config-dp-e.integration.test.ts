/**
 * Migration 028 — DP-E current-only + created_by column-strip follow-up to
 * mig 027.
 *
 * Two mechanisms, each does ONE thing (per Aaron 2026-05-15 disambiguation
 * + boss-greenlit shape):
 *   (i)  Base SELECT policy NOT-EXISTS filter on subtenant branch →
 *        subtenant sees only the latest-effective row per
 *        (reseller_org_id, subtenant_org_id) pair; reseller-admin
 *        unchanged (full history visible).
 *   (ii) reseller_pricing_config_view projects created_by conditionally
 *        via CASE → reseller-admins see real value, subtenant sees NULL.
 *
 * Paired coverage:
 *   - subtenant: only-latest row visible / older rows hidden
 *   - reseller-admin: all history visible
 *   - view: created_by nullified for subtenant
 *   - view: created_by preserved for reseller-admin
 *   - getCurrentPricing through view: composes row-gating + column-strip
 *
 * Companion: rls-reseller-pricing-config.integration.test.ts (mig 027
 * foundation). Same testcontainer + rls_test_user reserved-connection
 * pattern (test-environment-substitution-fidelity discipline — local-pass
 * proves nothing unless the test-actor matches production-privilege-class).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResellerPricingService } from '../../billing/reseller-pricing-service.js';

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
  await applyMigrations();
  await seedFixtures();
  await provisionTestRole();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  await sql`TRUNCATE reseller_pricing_config`;
});

async function bootstrapSchema(): Promise<void> {
  await sql`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
  )`;

  await sql`CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'standalone',
    parent_org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`CREATE TABLE org_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  )`;

  await sql`CREATE TABLE reseller_members (
    id TEXT PRIMARY KEY,
    reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    UNIQUE (reseller_org_id, user_id)
  )`;

  await sql`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE
    AS $$
      SELECT EXISTS (
        SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = p_user_id
      )
    $$
  `;
}

async function applyMigrations(): Promise<void> {
  for (const filename of [
    '023_reseller_admin_of_ancestor_helper.sql',
    '027_reseller_pricing_config.sql',
    '028_reseller_pricing_config_dp_e_and_created_by_strip.sql',
  ]) {
    const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');
    await sql.unsafe(body);
  }
}

async function seedFixtures(): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES
    ('rita',  'rita@reseller-a.example'),
    ('bob',   'bob@reseller-b.example'),
    ('carol', 'carol@cust-a.example'),
    ('sam',   'sam@sub-cust-a.example')`;

  await sql`INSERT INTO organizations (id, name, type) VALUES
    ('res-a', 'Reseller A', 'reseller'),
    ('res-b', 'Reseller B', 'reseller')`;
  await sql`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
    ('cust-a',     'Customer A',     'customer', 'res-a'),
    ('cust-b',     'Customer B',     'customer', 'res-b'),
    ('sub-cust-a', 'Sub-Customer A', 'customer', 'cust-a')`;

  await sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-carol', 'cust-a',     'carol', 'owner'),
    ('m-sam',   'sub-cust-a', 'sam',   'owner')`;

  await sql`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
    ('rm-rita', 'res-a', 'rita', 'reseller_admin'),
    ('rm-bob',  'res-b', 'bob',  'reseller_admin')`;
}

async function provisionTestRole(): Promise<void> {
  await sql.unsafe(`CREATE ROLE rls_test_user`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT ON reseller_pricing_config_view TO rls_test_user`);
}

interface RlsConnection {
  query: postgres.Sql;
  release: () => Promise<void>;
}

async function asUser(userId: string | null): Promise<RlsConnection> {
  const reserved = await sql.reserve();
  await reserved.unsafe(`SET ROLE rls_test_user`);
  await reserved`SELECT set_config('conduit.current_user_id', ${userId ?? ''}, false)`;
  return {
    query: reserved as unknown as postgres.Sql,
    release: async () => {
      try {
        await reserved.unsafe(`RESET ROLE`);
        await reserved`SELECT set_config('conduit.current_user_id', '', false)`;
      } finally {
        reserved.release();
      }
    },
  };
}

/**
 * Seed two configs for (res-a, cust-a) with deterministic effective_at
 * ordering (cfg-old at NOW(), cfg-new at NOW() + 1s). Bypasses RLS via
 * superuser so test setup is independent of policy correctness.
 */
async function seedTwoConfigs() {
  await sql`
    INSERT INTO reseller_pricing_config (
      id, reseller_org_id, subtenant_org_id, mode,
      rate_basis_points, currency, effective_at, created_by
    ) VALUES
      ('cfg-old', 'res-a', 'cust-a', 'percentage', 500,  'USD', NOW(),                     'rita'),
      ('cfg-new', 'res-a', 'cust-a', 'percentage', 1000, 'USD', NOW() + INTERVAL '1 second', 'rita')
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mig 028 — DP-E current-only on base table SELECT policy', () => {
  beforeEach(seedTwoConfigs);

  it('subtenant sees ONLY the latest-effective row (older row hidden)', async () => {
    const conn = await asUser('carol'); // owner of cust-a
    try {
      const rows = await conn.query<{ id: string }[]>`
        SELECT id FROM reseller_pricing_config ORDER BY id
      `;
      expect(rows.map((r) => r.id)).toEqual(['cfg-new']);
    } finally { await conn.release(); }
  });

  it('reseller-admin sees FULL history (both rows)', async () => {
    const conn = await asUser('rita');
    try {
      const rows = await conn.query<{ id: string }[]>`
        SELECT id FROM reseller_pricing_config ORDER BY id
      `;
      expect(rows.map((r) => r.id)).toEqual(['cfg-new', 'cfg-old']);
    } finally { await conn.release(); }
  });

  it('cross-reseller admin sees nothing (unchanged from mig 027)', async () => {
    const conn = await asUser('bob');
    try {
      const rows = await conn.query`SELECT id FROM reseller_pricing_config`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });

  it('subtenant of sibling org cannot see neighbor\'s config', async () => {
    const conn = await asUser('sam'); // owner of sub-cust-a, not cust-a
    try {
      const rows = await conn.query`SELECT id FROM reseller_pricing_config`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });
});

describe('mig 028 — view column-strip on created_by', () => {
  beforeEach(seedTwoConfigs);

  it('subtenant SELECT via view returns created_by = NULL on the current row', async () => {
    const conn = await asUser('carol');
    try {
      const rows = await conn.query<{ id: string; created_by: string | null }[]>`
        SELECT id, created_by FROM reseller_pricing_config_view ORDER BY id
      `;
      expect(rows).toEqual([{ id: 'cfg-new', created_by: null }]);
    } finally { await conn.release(); }
  });

  it('reseller-admin SELECT via view returns real created_by values', async () => {
    const conn = await asUser('rita');
    try {
      const rows = await conn.query<{ id: string; created_by: string | null }[]>`
        SELECT id, created_by FROM reseller_pricing_config_view ORDER BY id
      `;
      expect(rows).toEqual([
        { id: 'cfg-new', created_by: 'rita' },
        { id: 'cfg-old', created_by: 'rita' },
      ]);
    } finally { await conn.release(); }
  });

  it('view exposes the same non-created_by columns as the base table', async () => {
    const conn = await asUser('rita');
    try {
      const [row] = await conn.query<{
        id: string;
        reseller_org_id: string;
        subtenant_org_id: string;
        mode: string;
        rate_basis_points: number | null;
        amount_cents: number | null;
        currency: string;
      }[]>`
        SELECT id, reseller_org_id, subtenant_org_id, mode,
               rate_basis_points, amount_cents, currency
          FROM reseller_pricing_config_view
         WHERE id = 'cfg-new'
      `;
      expect(row).toMatchObject({
        id: 'cfg-new',
        reseller_org_id: 'res-a',
        subtenant_org_id: 'cust-a',
        mode: 'percentage',
        rate_basis_points: 1000,
        amount_cents: null,
        currency: 'USD',
      });
    } finally { await conn.release(); }
  });
});

describe('mig 028 — ServiceLayer.getCurrentPricing composes row-gating + column-strip', () => {
  beforeEach(seedTwoConfigs);

  it('subtenant: returns latest row with createdBy = null', async () => {
    const conn = await asUser('carol');
    try {
      const svc = new ResellerPricingService(conn.query);
      const result = await svc.getCurrentPricing('res-a', 'cust-a');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('cfg-new');
      expect(result!.rateBasisPoints).toBe(1000);
      expect(result!.createdBy).toBeNull();
    } finally { await conn.release(); }
  });

  it('reseller-admin: returns latest row with real createdBy', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService(conn.query);
      const result = await svc.getCurrentPricing('res-a', 'cust-a');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('cfg-new');
      expect(result!.createdBy).toBe('rita');
    } finally { await conn.release(); }
  });

  it('cross-reseller admin: returns null (no row-access via view)', async () => {
    const conn = await asUser('bob');
    try {
      const svc = new ResellerPricingService(conn.query);
      const result = await svc.getCurrentPricing('res-a', 'cust-a');
      expect(result).toBeNull();
    } finally { await conn.release(); }
  });

  it('subtenant + no-config: returns null', async () => {
    await sql`TRUNCATE reseller_pricing_config`;
    const conn = await asUser('carol');
    try {
      const svc = new ResellerPricingService(conn.query);
      const result = await svc.getCurrentPricing('res-a', 'cust-a');
      expect(result).toBeNull();
    } finally { await conn.release(); }
  });
});

describe('mig 028 — conduit_is_latest_pricing_row helper contract', () => {
  beforeEach(seedTwoConfigs);

  it('returns TRUE for the latest-effective row', async () => {
    const [{ result }] = await sql<{ result: boolean }[]>`
      SELECT conduit_is_latest_pricing_row('cfg-new') AS result
    `;
    expect(result).toBe(true);
  });

  it('returns FALSE for a superseded (older) row', async () => {
    const [{ result }] = await sql<{ result: boolean }[]>`
      SELECT conduit_is_latest_pricing_row('cfg-old') AS result
    `;
    expect(result).toBe(false);
  });

  it('returns FALSE for a non-existent id (existence gate)', async () => {
    const [{ result }] = await sql<{ result: boolean }[]>`
      SELECT conduit_is_latest_pricing_row('does-not-exist') AS result
    `;
    expect(result).toBe(false);
  });
});

describe('mig 028 — write-path unchanged by follow-up', () => {
  it('setPricing still inserts into base table and returns expected shape', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService(conn.query);
      const result = await svc.setPricing({
        id: 'cfg-write-1',
        resellerOrgId: 'res-a',
        subtenantOrgId: 'cust-a',
        mode: 'percentage',
        rateBasisPoints: 750,
        createdBy: 'rita',
      });
      // Insert returns directly from base table — createdBy is real here.
      expect(result.createdBy).toBe('rita');
    } finally { await conn.release(); }
  });
});
