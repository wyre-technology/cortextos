/**
 * Migration 027 — reseller_invoices + reseller_invoice_line_items.
 *
 * Surface-1 coverage (schema + RLS + paired accept/reject per Bug B
 * sweep shape):
 *   - reseller_invoices RLS: SELECT (reseller-admin / MSP-org-member /
 *     cross-reseller reject), INSERT (reseller-admin / non-admin
 *     reject), UPDATE (status transitions by reseller-admin / non-admin
 *     reject), no DELETE policy
 *   - reseller_invoice_line_items RLS: SELECT/INSERT via parent invoice
 *     join; UPDATE/DELETE silently no-op (write-once)
 *   - Structural trigger: msp_org_id.type must = 'reseller'
 *   - CHECK constraints: status enum, currency=USD, period_end > period_start,
 *     amount_cents >= 0, line-item arithmetic (final = base + markup),
 *     usage_units > 0 (DP-J skip-zero-usage)
 *   - updated_at trigger: status transitions touch updated_at
 *   - applied_pricing_config_id FK: round-trip persists pointer
 *
 * Follows rls-bug-b-sweep reserved-connection + rls_test_user pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  await applyMigrations();
  await seedFixtures();
  await provisionTestRole();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // CASCADE handles line_items cleanup via FK.
  await sql`TRUNCATE reseller_invoices CASCADE`;
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

  // subscriptions (mig 0001 shape) — needed for source_subscription_id FK.
  await sql`CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'pro',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  // Inline conduit_is_member_of_org (mig 018) — narrow re-implementation.
  await sql`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE
    AS $$
      SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = p_user_id)
    $$
  `;
}

async function applyMigrations(): Promise<void> {
  for (const filename of [
    '023_reseller_admin_of_ancestor_helper.sql',
    '025_reseller_pricing_config.sql',
    '026_reseller_pricing_config_dp_e_and_created_by_strip.sql',
    '027_reseller_invoices.sql',
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
    ('mike',  'mike@reseller-a.example'),
    ('bob',   'bob@reseller-b.example'),
    ('carol', 'carol@cust-a.example')`;

  await sql`INSERT INTO organizations (id, name, type) VALUES
    ('res-a', 'Reseller A', 'reseller'),
    ('res-b', 'Reseller B', 'reseller')`;
  await sql`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
    ('cust-a', 'Customer A', 'customer', 'res-a'),
    ('cust-b', 'Customer B', 'customer', 'res-b')`;

  // Mike is an MSP-employee org_member on res-a (the reseller IS the org,
  // not a sub-org — mid-tier MSP-staff who are not reseller-admins).
  await sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-mike', 'res-a', 'mike', 'member'),
    ('m-carol', 'cust-a', 'carol', 'owner')`;

  await sql`INSERT INTO reseller_members (id, reseller_org_id, user_id, role) VALUES
    ('rm-rita', 'res-a', 'rita', 'reseller_admin'),
    ('rm-bob',  'res-b', 'bob',  'reseller_admin')`;

  await sql`INSERT INTO subscriptions (id, org_id, stripe_customer_id, stripe_subscription_id) VALUES
    ('sub-cust-a', 'cust-a', 'cus_aaa', 'sub_aaa')`;

  // Seed pricing config so applied_pricing_config_id FK has a target.
  await sql`INSERT INTO reseller_pricing_config (
    id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
  ) VALUES ('cfg-cust-a', 'res-a', 'cust-a', 'percentage', 500, 'USD', 'rita')`;
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

const PERIOD_START = '2026-05-01T00:00:00Z';
const PERIOD_END = '2026-06-01T00:00:00Z';

async function seedInvoice(id: string, mspOrgId = 'res-a', stripeId: string | null = null): Promise<void> {
  await sql`
    INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end, status, stripe_invoice_id)
    VALUES (${id}, ${mspOrgId}, ${PERIOD_START}, ${PERIOD_END}, 'draft', ${stripeId})
  `;
}

// ---------------------------------------------------------------------------
// reseller_invoices — RLS INSERT
// ---------------------------------------------------------------------------

describe('mig 027 — reseller_invoices RLS INSERT', () => {
  it('reseller-admin can INSERT for their MSP-org', async () => {
    const conn = await asUser('rita');
    try {
      const inserted = await conn.query<{ id: string }[]>`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
        VALUES ('inv-1', 'res-a', ${PERIOD_START}, ${PERIOD_END})
        RETURNING id
      `;
      expect(inserted).toEqual([{ id: 'inv-1' }]);
    } finally { await conn.release(); }
  });

  it('cross-reseller admin cannot INSERT for another reseller\'s MSP-org', async () => {
    const conn = await asUser('bob'); // admin of res-b
    try {
      await expect(
        conn.query`
          INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
          VALUES ('inv-x', 'res-a', ${PERIOD_START}, ${PERIOD_END})
        `,
      ).rejects.toThrow();
    } finally { await conn.release(); }
  });

  it('MSP-org-member (non-admin) cannot INSERT (RLS reject)', async () => {
    const conn = await asUser('mike'); // org_member on res-a, not reseller_admin
    try {
      await expect(
        conn.query`
          INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
          VALUES ('inv-y', 'res-a', ${PERIOD_START}, ${PERIOD_END})
        `,
      ).rejects.toThrow();
    } finally { await conn.release(); }
  });
});

// ---------------------------------------------------------------------------
// reseller_invoices — RLS SELECT
// ---------------------------------------------------------------------------

describe('mig 027 — reseller_invoices RLS SELECT', () => {
  beforeEach(async () => { await seedInvoice('inv-sel'); });

  it('reseller-admin can SELECT their MSP-org\'s invoices', async () => {
    const conn = await asUser('rita');
    try {
      const rows = await conn.query<{ id: string }[]>`SELECT id FROM reseller_invoices`;
      expect(rows.map((r) => r.id)).toEqual(['inv-sel']);
    } finally { await conn.release(); }
  });

  it('MSP-org-member (non-admin) can SELECT their MSP-org\'s invoices (visibility, not mutation)', async () => {
    const conn = await asUser('mike');
    try {
      const rows = await conn.query<{ id: string }[]>`SELECT id FROM reseller_invoices`;
      expect(rows.map((r) => r.id)).toEqual(['inv-sel']);
    } finally { await conn.release(); }
  });

  it('cross-reseller admin cannot SELECT another reseller\'s invoices', async () => {
    const conn = await asUser('bob');
    try {
      const rows = await conn.query`SELECT id FROM reseller_invoices`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });

  it('customer-side org member cannot SELECT (subtenant is not the MSP)', async () => {
    const conn = await asUser('carol'); // owner of cust-a; subtenant, not MSP
    try {
      const rows = await conn.query`SELECT id FROM reseller_invoices`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });
});

// ---------------------------------------------------------------------------
// reseller_invoices — RLS UPDATE + updated_at trigger
// ---------------------------------------------------------------------------

describe('mig 027 — reseller_invoices RLS UPDATE + updated_at', () => {
  beforeEach(async () => { await seedInvoice('inv-upd'); });

  it('reseller-admin can UPDATE status (draft → open transition)', async () => {
    const conn = await asUser('rita');
    try {
      const updated = await conn.query`
        UPDATE reseller_invoices SET status = 'open' WHERE id = 'inv-upd' RETURNING id, status
      `;
      expect((updated as unknown as { count: number }).count).toBe(1);
    } finally { await conn.release(); }
  });

  it('updated_at trigger fires on status transition', async () => {
    const [{ updated_at: before }] = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM reseller_invoices WHERE id = 'inv-upd'
    `;
    // Force a measurable delta so the comparison is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const conn = await asUser('rita');
    try {
      await conn.query`UPDATE reseller_invoices SET status = 'open' WHERE id = 'inv-upd'`;
    } finally { await conn.release(); }
    const [{ updated_at: after }] = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM reseller_invoices WHERE id = 'inv-upd'
    `;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('cross-reseller admin cannot UPDATE another reseller\'s invoice (0 rows)', async () => {
    const conn = await asUser('bob');
    try {
      const r = await conn.query`UPDATE reseller_invoices SET status = 'paid' WHERE id = 'inv-upd'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { await conn.release(); }

    const [row] = await sql<{ status: string }[]>`SELECT status FROM reseller_invoices WHERE id = 'inv-upd'`;
    expect(row.status).toBe('draft');
  });

  it('MSP-org-member (non-admin) cannot UPDATE', async () => {
    const conn = await asUser('mike');
    try {
      const r = await conn.query`UPDATE reseller_invoices SET status = 'paid' WHERE id = 'inv-upd'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { await conn.release(); }
  });
});

// ---------------------------------------------------------------------------
// reseller_invoices — structural trigger + CHECK constraints
// ---------------------------------------------------------------------------

describe('mig 027 — reseller_invoices structural trigger', () => {
  it('rejects msp_org_id pointing at a non-reseller org', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
        VALUES ('inv-bad-type', 'cust-a', ${PERIOD_START}, ${PERIOD_END})
      `,
    ).rejects.toThrow(/type=reseller/);
  });

  it('rejects msp_org_id pointing at a non-existent org', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
        VALUES ('inv-bad-fk', 'does-not-exist', ${PERIOD_START}, ${PERIOD_END})
      `,
    ).rejects.toThrow();
  });
});

describe('mig 027 — reseller_invoices idempotency UNIQUE', () => {
  it('rejects a second invoice for the same (msp_org_id, period_start)', async () => {
    await seedInvoice('inv-uniq-1');
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
        VALUES ('inv-uniq-2', 'res-a', ${PERIOD_START}, ${PERIOD_END})
      `,
    ).rejects.toThrow(/reseller_invoices_msp_period_unique/);
  });

  it('admits another invoice for the same MSP at a different period_start', async () => {
    await seedInvoice('inv-uniq-1');
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
      VALUES ('inv-uniq-2', 'res-a', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')
      RETURNING id
    `;
    expect(inserted).toEqual([{ id: 'inv-uniq-2' }]);
  });
});

describe('mig 027 — reseller_invoices CHECK constraints', () => {
  it('rejects invalid status value', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end, status)
        VALUES ('inv-bad-st', 'res-a', ${PERIOD_START}, ${PERIOD_END}, 'invalid_state')
      `,
    ).rejects.toThrow(/status_check/);
  });

  it('rejects non-USD currency', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end, currency)
        VALUES ('inv-bad-cur', 'res-a', ${PERIOD_START}, ${PERIOD_END}, 'EUR')
      `,
    ).rejects.toThrow(/currency_check/);
  });

  it('rejects period_end <= period_start', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end)
        VALUES ('inv-bad-per', 'res-a', ${PERIOD_END}, ${PERIOD_START})
      `,
    ).rejects.toThrow(/period_check/);
  });

  it('rejects negative amount_cents', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoices (id, msp_org_id, period_start, period_end, amount_cents)
        VALUES ('inv-bad-amt', 'res-a', ${PERIOD_START}, ${PERIOD_END}, -100)
      `,
    ).rejects.toThrow(/amount_check/);
  });
});

// ---------------------------------------------------------------------------
// reseller_invoice_line_items — RLS + CHECKs + applied_pricing_config_id
// ---------------------------------------------------------------------------

describe('mig 027 — reseller_invoice_line_items RLS', () => {
  beforeEach(async () => { await seedInvoice('inv-li'); });

  it('reseller-admin can INSERT line_items for their invoice', async () => {
    const conn = await asUser('rita');
    try {
      const inserted = await conn.query<{ id: string }[]>`
        INSERT INTO reseller_invoice_line_items (
          id, invoice_id, subtenant_org_id, usage_units,
          base_rate_cents, markup_applied_cents, final_rate_cents,
          source_subscription_id, applied_pricing_config_id
        ) VALUES (
          'li-1', 'inv-li', 'cust-a', 100,
          1000, 50, 1050,
          'sub-cust-a', 'cfg-cust-a'
        ) RETURNING id
      `;
      expect(inserted).toEqual([{ id: 'li-1' }]);
    } finally { await conn.release(); }
  });

  it('cross-reseller admin cannot INSERT line_items pointing at another reseller\'s invoice', async () => {
    const conn = await asUser('bob');
    try {
      await expect(
        conn.query`
          INSERT INTO reseller_invoice_line_items (
            id, invoice_id, subtenant_org_id, usage_units,
            base_rate_cents, markup_applied_cents, final_rate_cents
          ) VALUES (
            'li-x', 'inv-li', 'cust-a', 100,
            1000, 50, 1050
          )
        `,
      ).rejects.toThrow();
    } finally { await conn.release(); }
  });

  it('MSP-org-member can SELECT line_items (via parent invoice visibility)', async () => {
    await sql`
      INSERT INTO reseller_invoice_line_items (
        id, invoice_id, subtenant_org_id, usage_units,
        base_rate_cents, markup_applied_cents, final_rate_cents
      ) VALUES ('li-sel', 'inv-li', 'cust-a', 100, 1000, 50, 1050)
    `;

    const conn = await asUser('mike');
    try {
      const rows = await conn.query<{ id: string }[]>`SELECT id FROM reseller_invoice_line_items`;
      expect(rows.map((r) => r.id)).toEqual(['li-sel']);
    } finally { await conn.release(); }
  });

  it('cross-reseller admin cannot SELECT line_items', async () => {
    await sql`
      INSERT INTO reseller_invoice_line_items (
        id, invoice_id, subtenant_org_id, usage_units,
        base_rate_cents, markup_applied_cents, final_rate_cents
      ) VALUES ('li-cross', 'inv-li', 'cust-a', 100, 1000, 50, 1050)
    `;

    const conn = await asUser('bob');
    try {
      const rows = await conn.query`SELECT id FROM reseller_invoice_line_items`;
      expect(rows).toEqual([]);
    } finally { await conn.release(); }
  });

  it('UPDATE on line_items is silently no-op for non-bypass roles (write-once)', async () => {
    await sql`
      INSERT INTO reseller_invoice_line_items (
        id, invoice_id, subtenant_org_id, usage_units,
        base_rate_cents, markup_applied_cents, final_rate_cents
      ) VALUES ('li-wo', 'inv-li', 'cust-a', 100, 1000, 50, 1050)
    `;

    const conn = await asUser('rita');
    try {
      const r = await conn.query`UPDATE reseller_invoice_line_items SET usage_units = 9999 WHERE id = 'li-wo'`;
      expect((r as unknown as { count: number }).count).toBe(0);
    } finally { await conn.release(); }

    const [row] = await sql<{ usage_units: number }[]>`SELECT usage_units FROM reseller_invoice_line_items WHERE id = 'li-wo'`;
    expect(row.usage_units).toBe(100);
  });
});

describe('mig 027 — reseller_invoice_line_items CHECK constraints', () => {
  beforeEach(async () => { await seedInvoice('inv-ck'); });

  const baseRow = {
    invoice_id: 'inv-ck',
    subtenant_org_id: 'cust-a',
  };

  it('rejects usage_units = 0 (DP-J skip-zero-usage)', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoice_line_items (
          id, invoice_id, subtenant_org_id, usage_units,
          base_rate_cents, markup_applied_cents, final_rate_cents
        ) VALUES ('li-bad-1', ${baseRow.invoice_id}, ${baseRow.subtenant_org_id}, 0, 1000, 50, 1050)
      `,
    ).rejects.toThrow(/amounts_check/);
  });

  it('rejects final_rate_cents != base + markup', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoice_line_items (
          id, invoice_id, subtenant_org_id, usage_units,
          base_rate_cents, markup_applied_cents, final_rate_cents
        ) VALUES ('li-bad-2', ${baseRow.invoice_id}, ${baseRow.subtenant_org_id}, 100, 1000, 50, 999)
      `,
    ).rejects.toThrow(/amounts_check/);
  });

  it('rejects negative base_rate_cents', async () => {
    await expect(
      sql`
        INSERT INTO reseller_invoice_line_items (
          id, invoice_id, subtenant_org_id, usage_units,
          base_rate_cents, markup_applied_cents, final_rate_cents
        ) VALUES ('li-bad-3', ${baseRow.invoice_id}, ${baseRow.subtenant_org_id}, 100, -1, 1, 0)
      `,
    ).rejects.toThrow(/amounts_check/);
  });
});

describe('mig 027 — applied_pricing_config_id audit-trace pointer', () => {
  beforeEach(async () => { await seedInvoice('inv-trace'); });

  it('round-trips the FK pointer on INSERT/SELECT', async () => {
    const conn = await asUser('rita');
    try {
      await conn.query`
        INSERT INTO reseller_invoice_line_items (
          id, invoice_id, subtenant_org_id, usage_units,
          base_rate_cents, markup_applied_cents, final_rate_cents,
          applied_pricing_config_id
        ) VALUES (
          'li-trace-1', 'inv-trace', 'cust-a', 100,
          1000, 50, 1050, 'cfg-cust-a'
        )
      `;
      const [row] = await conn.query<{ applied_pricing_config_id: string | null }[]>`
        SELECT applied_pricing_config_id FROM reseller_invoice_line_items WHERE id = 'li-trace-1'
      `;
      expect(row.applied_pricing_config_id).toBe('cfg-cust-a');
    } finally { await conn.release(); }
  });

  it('preserves the line and sets FK to NULL when the pricing-config row is hard-purged', async () => {
    const conn = await asUser('rita');
    try {
      await conn.query`
        INSERT INTO reseller_invoice_line_items (
          id, invoice_id, subtenant_org_id, usage_units,
          base_rate_cents, markup_applied_cents, final_rate_cents,
          applied_pricing_config_id
        ) VALUES (
          'li-trace-2', 'inv-trace', 'cust-a', 100,
          1000, 50, 1050, 'cfg-cust-a'
        )
      `;
    } finally { await conn.release(); }

    // Hard-purge as superuser (bypass RLS append-only).
    await sql`DELETE FROM reseller_pricing_config WHERE id = 'cfg-cust-a'`;

    const [row] = await sql<{ applied_pricing_config_id: string | null }[]>`
      SELECT applied_pricing_config_id FROM reseller_invoice_line_items WHERE id = 'li-trace-2'
    `;
    expect(row.applied_pricing_config_id).toBeNull();
  });
});
