/**
 * Migration 025 — reseller_pricing_config table + RLS + structural trigger
 * + append-only supersession.
 *
 * Paired accept/reject coverage across the independent enforcement layers
 * (per Bug B sweep shape):
 *   - RLS SELECT path:  reseller-admin via mig 023 helper / subtenant via
 *                       conduit_is_member_of_org / cross-reseller reject
 *   - RLS INSERT path:  WITH CHECK by reseller-admin / non-admin reject /
 *                       depth-2 ancestor (mig 023 helper exercised)
 *   - Structural trigger: cross-reseller subtenant reject / non-reseller
 *                         reseller_org_id reject
 *   - CHECK constraints: mode/value mismatch / negative values / wrong
 *                        currency
 *   - Supersession: latest-effective_at wins; getCurrentPricing returns
 *                   latest row; no-config returns null; UPDATE/DELETE
 *                   silently no-op under non-bypass roles.
 *
 * Companion: rls-reseller-admin-of-ancestor.integration.test.ts (mig 023
 * helper). Follows rls-bug-b-sweep.integration.test.ts's reserved-
 * connection + rls_test_user pattern so the superuser bypass on the
 * default postgres role does not mask policy failures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResellerPricingService } from '../../billing/reseller-pricing-service.js';
import { enterTestContext, type Sql } from '../../db/context.js';

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

// ---------------------------------------------------------------------------
// Bootstrap — minimal schema mig 025 depends on
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

  // Inline conduit_is_member_of_org (mig 018) — narrow re-implementation
  // sufficient for the SELECT-path subtenant-read test.
  await sql`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean
      LANGUAGE sql
      STABLE
    AS $$
      SELECT EXISTS (
        SELECT 1 FROM org_members
         WHERE org_id = p_org_id AND user_id = p_user_id
      )
    $$
  `;
}

async function applyMigrations(): Promise<void> {
  for (const filename of [
    '023_reseller_admin_of_ancestor_helper.sql',
    '025_reseller_pricing_config.sql',
    // mig 026 adds reseller_pricing_config_view + current-only filter on
    // subtenant SELECT branch. The service's getCurrentPricing now reads
    // from the view, so this test bootstrap must include it.
    '026_reseller_pricing_config_dp_e_and_created_by_strip.sql',
  ]) {
    const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');
    await sql.unsafe(body);
  }
}

// ---------------------------------------------------------------------------
// Seed
//
//   reseller-A (res-a) ← rita (reseller_admin), vera (reseller_billing_viewer)
//     └── cust-a    (depth-1 customer; owner=carol)
//           └── sub-cust-a (depth-2 sub-customer; owner=sam)
//
//   reseller-B (res-b) ← bob (reseller_admin)
//     └── cust-b    (depth-1 customer)
// ---------------------------------------------------------------------------

async function seedFixtures(): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES
    ('rita',  'rita@reseller-a.example'),
    ('vera',  'vera@reseller-a.example'),
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
    ('rm-vera', 'res-a', 'vera', 'reseller_billing_viewer'),
    ('rm-bob',  'res-b', 'bob',  'reseller_admin')`;
}

async function provisionTestRole(): Promise<void> {
  await sql.unsafe(`CREATE ROLE rls_test_user`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user`);
  // mig 026 view — required for service-layer reads to work.
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
  // Install this role-switched connection as the request context so a service
  // constructed in the test resolves getSql() to it — RLS policies then
  // enforce against rls_test_user, not the superuser pool.
  enterTestContext(reserved as unknown as Sql);
  return {
    query: reserved as unknown as postgres.Sql,
    release: async () => {
      // Reset role + session GUC before returning the connection to the
      // pool. Without this, a subsequent superuser-only op (TRUNCATE,
      // CREATE) hitting the same pool slot fails with permission denied.
      try {
        await reserved.unsafe(`RESET ROLE`);
        await reserved`SELECT set_config('conduit.current_user_id', '', false)`;
      } finally {
        reserved.release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePctInput(overrides: Partial<{
  id: string;
  reseller: string;
  subtenant: string;
  bp: number;
  by: string;
}> = {}) {
  return {
    id: overrides.id ?? `cfg-${Math.random().toString(36).slice(2, 10)}`,
    resellerOrgId: overrides.reseller ?? 'res-a',
    subtenantOrgId: overrides.subtenant ?? 'cust-a',
    mode: 'percentage' as const,
    rateBasisPoints: overrides.bp ?? 500,
    createdBy: overrides.by ?? 'rita',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mig 025 — RLS INSERT path', () => {
  it('reseller-admin can set pricing for their depth-1 subtenant', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      const result = await svc.setPricing(makePctInput({ subtenant: 'cust-a' }));
      expect(result.resellerOrgId).toBe('res-a');
      expect(result.subtenantOrgId).toBe('cust-a');
      expect(result.mode).toBe('percentage');
      expect(result.rateBasisPoints).toBe(500);
    } finally { await conn.release(); }
  });

  it('reseller-admin can set pricing for their depth-2 sub-customer (mig 023 helper)', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      const result = await svc.setPricing(makePctInput({ subtenant: 'sub-cust-a' }));
      expect(result.subtenantOrgId).toBe('sub-cust-a');
    } finally { await conn.release(); }
  });

  it('reseller-admin cannot set pricing on a different reseller\'s subtenant (RLS reject)', async () => {
    const conn = await asUser('bob'); // admin of res-b, not res-a
    try {
      const svc = new ResellerPricingService();
      await expect(
        svc.setPricing(makePctInput({ reseller: 'res-a', subtenant: 'cust-a', by: 'bob' })),
      ).rejects.toThrow();
    } finally { await conn.release(); }
  });

  it('reseller_billing_viewer (non-admin) cannot set pricing (RLS reject)', async () => {
    const conn = await asUser('vera'); // billing_viewer on res-a, not admin
    try {
      const svc = new ResellerPricingService();
      await expect(
        svc.setPricing(makePctInput({ subtenant: 'cust-a', by: 'vera' })),
      ).rejects.toThrow();
    } finally { await conn.release(); }
  });

  it('customer org member cannot set pricing on their own org (RLS reject)', async () => {
    const conn = await asUser('carol'); // owner of cust-a, not reseller_member
    try {
      const svc = new ResellerPricingService();
      await expect(
        svc.setPricing(makePctInput({ subtenant: 'cust-a', by: 'carol' })),
      ).rejects.toThrow();
    } finally { await conn.release(); }
  });
});

describe('mig 025 — structural trigger', () => {
  // Trigger fires on every INSERT and operates on NEW row regardless of
  // RLS verdict; tests run with bypass (superuser) so we exercise the
  // trigger in isolation from RLS gating.
  it('rejects cross-reseller config: subtenant is not descendant of reseller_org_id', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
      ) VALUES ('cfg-x', 'res-a', 'cust-b', 'percentage', 500, 'USD', 'rita')`,
    ).rejects.toThrow(/not a descendant/);
  });

  it('rejects config where reseller_org_id is not type=reseller', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
      ) VALUES ('cfg-y', 'cust-a', 'sub-cust-a', 'percentage', 500, 'USD', 'rita')`,
    ).rejects.toThrow(/type=reseller/);
  });
});

describe('mig 025 — CHECK constraints', () => {
  // CHECK constraints fire regardless of RLS; run as superuser to isolate.
  it('rejects percentage mode with amount_cents populated', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency, created_by
      ) VALUES ('cfg-bad-1', 'res-a', 'cust-a', 'percentage', 500, 1000, 'USD', 'rita')`,
    ).rejects.toThrow(/mode_value_check/);
  });

  it('rejects absolute_per_seat mode with rate_basis_points populated', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency, created_by
      ) VALUES ('cfg-bad-2', 'res-a', 'cust-a', 'absolute_per_seat', 500, 1000, 'USD', 'rita')`,
    ).rejects.toThrow(/mode_value_check/);
  });

  it('rejects percentage mode with both value columns NULL', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency, created_by
      ) VALUES ('cfg-bad-3', 'res-a', 'cust-a', 'percentage', NULL, NULL, 'USD', 'rita')`,
    ).rejects.toThrow(/mode_value_check/);
  });

  it('rejects negative rate_basis_points', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency, created_by
      ) VALUES ('cfg-bad-4', 'res-a', 'cust-a', 'percentage', -100, NULL, 'USD', 'rita')`,
    ).rejects.toThrow(/mode_value_check/);
  });

  it('rejects non-USD currency', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency, created_by
      ) VALUES ('cfg-bad-5', 'res-a', 'cust-a', 'percentage', 500, NULL, 'EUR', 'rita')`,
    ).rejects.toThrow(/currency_check/);
  });

  it('rejects unknown mode value', async () => {
    await expect(
      sql`INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, amount_cents, currency, created_by
      ) VALUES ('cfg-bad-6', 'res-a', 'cust-a', 'flat_fee', 500, NULL, 'USD', 'rita')`,
    ).rejects.toThrow(/mode_check/);
  });
});

describe('mig 025 — RLS SELECT path', () => {
  beforeEach(async () => {
    // Seed two rows as superuser (bypass RLS) — tests then read via
    // reserved rls_test_user connections to exercise SELECT policies.
    await sql`
      INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
      ) VALUES
        ('cfg-cust-a',     'res-a', 'cust-a',     'percentage', 500, 'USD', 'rita'),
        ('cfg-sub-cust-a', 'res-a', 'sub-cust-a', 'percentage', 750, 'USD', 'rita')
    `;
  });

  it('reseller-admin can SELECT their own configs (depth-1 + depth-2)', async () => {
    const conn = await asUser('rita');
    try {
      const rows = await conn.query<{ id: string }[]>`SELECT id FROM reseller_pricing_config ORDER BY id`;
      expect(rows.map((r) => r.id)).toEqual(['cfg-cust-a', 'cfg-sub-cust-a']);
    } finally { await conn.release(); }
  });

  it('subtenant org member can SELECT only their own org\'s config (opaque DP-E)', async () => {
    const conn = await asUser('carol'); // owner of cust-a
    try {
      const rows = await conn.query<{ id: string }[]>`SELECT id FROM reseller_pricing_config ORDER BY id`;
      expect(rows.map((r) => r.id)).toEqual(['cfg-cust-a']);
    } finally { await conn.release(); }
  });

  it('cross-reseller admin cannot SELECT another reseller\'s configs', async () => {
    const conn = await asUser('bob'); // admin of res-b
    try {
      const rows = await conn.query`SELECT id FROM reseller_pricing_config`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });

  it('unauthenticated session sees no rows', async () => {
    const conn = await asUser(null);
    try {
      const rows = await conn.query`SELECT id FROM reseller_pricing_config`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });
});

describe('mig 025 — append-only supersession', () => {
  it('getCurrentPricing returns the latest effective row', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      await svc.setPricing(makePctInput({ id: 'cfg-1', subtenant: 'cust-a', bp: 500 }));
      // Insert second row directly with later effective_at for deterministic
      // ordering even on same-millisecond inserts. Done as superuser (sql)
      // because asUser-reserved conn would need an explicit effective_at
      // pass-through on the service; v1 service doesn't take that.
    } finally { await conn.release(); }

    await sql`
      INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode,
        rate_basis_points, currency, effective_at, created_by
      ) VALUES (
        'cfg-2', 'res-a', 'cust-a', 'percentage',
        750, 'USD', NOW() + INTERVAL '1 second', 'rita'
      )
    `;

    const readConn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      const current = await svc.getCurrentPricing('res-a', 'cust-a');
      expect(current).not.toBeNull();
      expect(current!.id).toBe('cfg-2');
      expect(current!.rateBasisPoints).toBe(750);
    } finally { await readConn.release(); }
  });

  it('getCurrentPricing returns null when no config exists', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      const current = await svc.getCurrentPricing('res-a', 'cust-a');
      expect(current).toBeNull();
    } finally { await conn.release(); }
  });

  it('UPDATE on reseller_pricing_config is silently no-op for non-bypass roles', async () => {
    await sql`
      INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
      ) VALUES ('cfg-immut', 'res-a', 'cust-a', 'percentage', 500, 'USD', 'rita')
    `;

    const conn = await asUser('rita');
    try {
      const updated = await conn.query`
        UPDATE reseller_pricing_config
           SET rate_basis_points = 9999
         WHERE id = 'cfg-immut'
        RETURNING id
      `;
      expect((updated as unknown as { count: number }).count).toBe(0);
    } finally { await conn.release(); }

    const [row] = await sql<{ rate_basis_points: number }[]>`
      SELECT rate_basis_points FROM reseller_pricing_config WHERE id = 'cfg-immut'
    `;
    expect(row.rate_basis_points).toBe(500);
  });

  it('DELETE on reseller_pricing_config is silently no-op for non-bypass roles', async () => {
    await sql`
      INSERT INTO reseller_pricing_config (
        id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
      ) VALUES ('cfg-immut-2', 'res-a', 'cust-a', 'percentage', 500, 'USD', 'rita')
    `;

    const conn = await asUser('rita');
    try {
      const deleted = await conn.query`DELETE FROM reseller_pricing_config WHERE id = 'cfg-immut-2' RETURNING id`;
      expect((deleted as unknown as { count: number }).count).toBe(0);
    } finally { await conn.release(); }

    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM reseller_pricing_config WHERE id = 'cfg-immut-2'
    `;
    expect(row.id).toBe('cfg-immut-2');
  });
});

describe('mig 025 — service-layer round-trip', () => {
  it('setPricing returns the inserted shape (percentage)', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      const result = await svc.setPricing(makePctInput({ id: 'cfg-rt-1', bp: 1250 }));
      expect(result).toMatchObject({
        id: 'cfg-rt-1',
        resellerOrgId: 'res-a',
        subtenantOrgId: 'cust-a',
        mode: 'percentage',
        rateBasisPoints: 1250,
        amountCents: null,
        currency: 'USD',
        createdBy: 'rita',
      });
      expect(typeof result.effectiveAt).toBe('string');
      expect(typeof result.createdAt).toBe('string');
    } finally { await conn.release(); }
  });

  it('setPricing returns the inserted shape (absolute_per_seat)', async () => {
    const conn = await asUser('rita');
    try {
      const svc = new ResellerPricingService();
      const result = await svc.setPricing({
        id: 'cfg-rt-2',
        resellerOrgId: 'res-a',
        subtenantOrgId: 'cust-a',
        mode: 'absolute_per_seat',
        amountCents: 2500,
        createdBy: 'rita',
      });
      expect(result).toMatchObject({
        id: 'cfg-rt-2',
        mode: 'absolute_per_seat',
        rateBasisPoints: null,
        amountCents: 2500,
      });
    } finally { await conn.release(); }
  });
});
