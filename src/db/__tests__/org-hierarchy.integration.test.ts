/**
 * enforce_org_hierarchy trigger — bounded-depth-N coverage (migration 021).
 *
 * Migration 002 introduced the trigger with a hardcoded depth=2 (reseller →
 * customer). Migration 021 relaxed it to bounded-depth-N (MAX_ORG_DEPTH=3
 * for MVP, reseller → customer → customer-under-customer). This test exercises
 * the four trigger invariants:
 *
 *   1. Type-based parent-presence (standalone/reseller forbid parent;
 *      customer requires parent).
 *   2. Total chain depth ≤ MAX_ORG_DEPTH.
 *   3. Chain composition: root is reseller, intermediate rungs are customers.
 *   4. Cycle prevention.
 *
 * Companion: orgs/wyre/agents/analyst/memory/2026-05-11-subtenant-research-notes.md.
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
    max: 2,
    onnotice: () => undefined,
  });

  // Bootstrap the minimum organizations columns the trigger references.
  // We avoid running the entire migration sequence because:
  //   (a) RLS migrations 007/014/018/020 require multiple FK-referenced
  //       tables that aren't relevant to the hierarchy trigger contract
  //   (b) this test is scoped to the trigger; the bootstrap mirrors only
  //       what the trigger touches
  await sql`
    CREATE TABLE organizations (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await applyTriggerMigrations();
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

async function applyTriggerMigrations(): Promise<void> {
  // Apply 002 (introduces the trigger with hardcoded depth=2) then 021
  // (relaxes to bounded-depth-3). Verify 021 supersedes 002 cleanly.
  for (const filename of [
    '002_reseller_tenancy_expand.sql',
    '021_relax_org_hierarchy_to_bounded_depth.sql',
  ]) {
    const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
    const body = raw
      .replace(/^\s*BEGIN\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '');
    await sql.begin((tx) => tx.unsafe(body));
  }
}

async function insertOrg(id: string, type: string, parentId: string | null): Promise<void> {
  await sql`
    INSERT INTO organizations (id, name, type, parent_org_id)
    VALUES (${id}, ${id}, ${type}, ${parentId})
  `;
}

async function expectInsertReject(
  id: string,
  type: string,
  parentId: string | null,
  expectedFragment: string,
): Promise<void> {
  let captured: Error | null = null;
  try {
    await insertOrg(id, type, parentId);
  } catch (err) {
    captured = err as Error;
  }
  expect(captured, `expected INSERT to be rejected by trigger; it succeeded`).not.toBeNull();
  expect(captured!.message.toLowerCase()).toContain(expectedFragment.toLowerCase());
}

describe('enforce_org_hierarchy trigger — bounded-depth-3 (migration 021)', () => {
  // -------------------------------------------------------------------------
  // Depth-allowed paths (the relaxation)
  // -------------------------------------------------------------------------

  describe('depth-allowed inserts', () => {
    it('depth 1: reseller with no parent succeeds', async () => {
      await insertOrg('reseller-1', 'reseller', null);
      const [row] = await sql`SELECT id FROM organizations WHERE id = 'reseller-1'`;
      expect(row?.id).toBe('reseller-1');
    });

    it('depth 2: customer under reseller succeeds (mig 002 baseline preserved)', async () => {
      await insertOrg('customer-1', 'customer', 'reseller-1');
      const [row] = await sql`SELECT id FROM organizations WHERE id = 'customer-1'`;
      expect(row?.id).toBe('customer-1');
    });

    it('depth 3: customer under customer-under-reseller succeeds (mig 021 relaxation)', async () => {
      // The load-bearing assertion. Pre-mig-021 the depth-2 trigger
      // rejected this with "customer parent must be a reseller (got customer)".
      await insertOrg('subcustomer-1', 'customer', 'customer-1');
      const [row] = await sql`SELECT id FROM organizations WHERE id = 'subcustomer-1'`;
      expect(row?.id).toBe('subcustomer-1');
    });

    it('standalone with no parent succeeds', async () => {
      await insertOrg('standalone-1', 'standalone', null);
      const [row] = await sql`SELECT id FROM organizations WHERE id = 'standalone-1'`;
      expect(row?.id).toBe('standalone-1');
    });
  });

  // -------------------------------------------------------------------------
  // Depth-rejected paths
  // -------------------------------------------------------------------------

  describe('depth-rejected inserts', () => {
    it('depth 4: customer under subcustomer-under-customer-under-reseller fails', async () => {
      await expectInsertReject(
        'subsubcustomer-1',
        'customer',
        'subcustomer-1',
        'org hierarchy depth exceeds MAX_ORG_DEPTH',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Type-composition rules
  // -------------------------------------------------------------------------

  describe('type composition rules', () => {
    it('rejects reseller with a parent', async () => {
      await expectInsertReject('reseller-bad', 'reseller', 'reseller-1', 'cannot have a parent');
    });

    it('rejects standalone with a parent', async () => {
      await expectInsertReject('standalone-bad', 'standalone', 'reseller-1', 'cannot have a parent');
    });

    it('rejects customer with no parent', async () => {
      await expectInsertReject('orphan-customer', 'customer', null, 'must have parent_org_id');
    });

    it('rejects customer with parent that does not exist', async () => {
      await expectInsertReject('ghost-child', 'customer', 'no-such-parent', 'does not exist');
    });

    it('rejects customer whose chain roots at standalone (root must be reseller)', async () => {
      // Construct: customer A whose parent is standalone-1. Should fail because
      // the chain root is a 'standalone', not a 'reseller'.
      await expectInsertReject(
        'invalid-root',
        'customer',
        'standalone-1',
        'must root at a reseller',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cycle prevention
  // -------------------------------------------------------------------------

  describe('cycle prevention', () => {
    it('rejects self-parent (org pointing at itself)', async () => {
      // Insert with id == parent_org_id. The trigger walks up cur_id =
      // NEW.parent_org_id = NEW.id and detects the cycle.
      await expectInsertReject('self-cycle', 'customer', 'self-cycle', 'cyclic parent_org_id chain');
    });

    it('rejects update repointing parent_org_id into a cycle', async () => {
      // customer-1 has parent reseller-1 (created above). Try to UPDATE
      // reseller-1's parent_org_id to customer-1 — would create a cycle
      // (reseller-1 → customer-1 → reseller-1). But reseller cannot have
      // a parent at all, so the cannot-have-parent rule fires first.
      // Instead test a customer→customer cycle:
      //   subcustomer-1 currently has parent customer-1
      //   UPDATE customer-1 SET parent_org_id = 'subcustomer-1' should be
      //   rejected because (a) customer-1's chain would walk
      //   subcustomer-1 → customer-1 (cycle).
      let captured: Error | null = null;
      try {
        await sql`UPDATE organizations SET parent_org_id = 'subcustomer-1' WHERE id = 'customer-1'`;
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).not.toBeNull();
      // Either the cyclic-detection error fires OR the depth-exceeded
      // error fires depending on walk-order. Both are valid rejections.
      const msg = captured!.message.toLowerCase();
      expect(
        msg.includes('cyclic') || msg.includes('depth') || msg.includes('intermediate'),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // UPDATE behavior — repoint a customer's parent
  // -------------------------------------------------------------------------

  describe('UPDATE repoint behavior', () => {
    it('allows UPDATE to a shallower parent (depth shrinks)', async () => {
      // Create a fresh chain: reseller-2 → customer-2 → subcustomer-2 (depth 3).
      // Then UPDATE subcustomer-2's parent to reseller-2 directly (depth 2).
      await insertOrg('reseller-2', 'reseller', null);
      await insertOrg('customer-2', 'customer', 'reseller-2');
      await insertOrg('subcustomer-2', 'customer', 'customer-2');

      await sql`UPDATE organizations SET parent_org_id = 'reseller-2' WHERE id = 'subcustomer-2'`;

      const [row] = await sql`SELECT parent_org_id FROM organizations WHERE id = 'subcustomer-2'`;
      expect(row?.parent_org_id).toBe('reseller-2');
    });

    it('rejects UPDATE that would push chain beyond MAX_ORG_DEPTH', async () => {
      // Set up a fresh depth-3 chain again (reseller-3 → customer-3 → subcustomer-3),
      // then try to repoint a NEW customer-only chain as a 4th level under it.
      await insertOrg('reseller-3', 'reseller', null);
      await insertOrg('customer-3', 'customer', 'reseller-3');
      await insertOrg('subcustomer-3', 'customer', 'customer-3');
      await insertOrg('floating-customer', 'customer', 'reseller-3'); // depth 2 currently

      let captured: Error | null = null;
      try {
        await sql`UPDATE organizations SET parent_org_id = 'subcustomer-3' WHERE id = 'floating-customer'`;
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).not.toBeNull();
      expect(captured!.message.toLowerCase()).toContain('org hierarchy depth exceeds');
    });
  });
});
