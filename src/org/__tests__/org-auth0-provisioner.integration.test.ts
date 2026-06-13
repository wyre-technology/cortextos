/**
 * Auth0 org-provisioner BOTH-OR-NEITHER integration test — end-to-end
 * against a real Postgres testcontainer with a mocked Auth0 provisioner
 * at the seam.
 *
 * Why this exists (boss directive 2026-06-13 msg-1781369908151):
 *   Slice 3 PR #382 shipped BOTH-OR-NEITHER discipline at the createOrg
 *   seam with unit tests that lock the cheap-detector signatures. This
 *   file hardens the discipline against REAL Postgres semantics — real
 *   FK violations, real UNIQUE constraints, real transaction visibility
 *   — before pearl's routing-middleware lands on top of slice 3 next
 *   week. Sibling-shape to src/billing/__tests__/trial-end-contract.
 *   integration.test.ts which is the canonical 4-layer-defense reference
 *   for this codebase (spec + types + unit + integration).
 *
 * Three load-bearing scenarios:
 *   1. Auth0 provisioner throws BEFORE INSERT → ZERO DB writes happen.
 *      Asserts the no-orphan-row invariant against a real Postgres
 *      organizations table.
 *   2. Auth0 succeeds + DB INSERT throws (FK violation: invalid owner_id
 *      with no matching users row) → rollback hook fires with the right
 *      auth0OrgId, AND the original Postgres error propagates as the
 *      caller-facing throw. The auth0OrgId from step 1 is preserved
 *      through the catch + handed to the rollback.
 *   3. DB INSERT throws + rollback ALSO throws → the ORIGINAL Postgres
 *      error still propagates (not the rollback error). Error-contract-
 *      muddling avoided per slice 3 docstring.
 *
 * Scope discipline (per the invitation-flow.integration.test.ts pattern
 * sibling): this stands up its own minimal schema rather than running
 * full migrations. Mirror of organizations + users + org_members + the
 * auth0_org_id column from migration 046, inlined so the test is self-
 * contained and migration-loader-independent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

import { OrgService } from '../org-service.js';
import type {
  OrgAuth0Provisioner,
  OrgAuth0Rollback,
} from '../org-auth0-provisioner.js';
import { enterTestContext } from '../../db/context.js';

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

async function bootstrap(): Promise<void> {
  // Minimum schema for the createOrg + Auth0 provisioner code path.
  // Mirrors the migrated state (post-mig 046) without running the full
  // migration runner — same posture as invitation-flow.integration.test.ts.
  await sql`
    CREATE TABLE users (
      id    TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    )
  `;
  await sql`
    CREATE TABLE organizations (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      owner_id               TEXT NOT NULL REFERENCES users(id),
      plan                   TEXT NOT NULL DEFAULT 'free',
      default_server_access  TEXT NOT NULL DEFAULT 'none',
      prompt_capture_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      type                   TEXT,
      parent_org_id          TEXT REFERENCES organizations(id),
      auth0_org_id           TEXT UNIQUE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_members (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member',
      joined_at  TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, user_id)
    )
  `;
  // The notifyNewSignup helper from billing/sales-notifier writes to a
  // notification queue — minimal table here to keep that call from
  // raising; the queue isn't the load-bearing surface for this test.
  await sql`
    CREATE TABLE IF NOT EXISTS new_signups (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      org_id     TEXT NOT NULL,
      is_owner   BOOLEAN NOT NULL DEFAULT FALSE,
      notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function reset(): Promise<void> {
  // Truncate cascade so each test starts from a clean state.
  await sql`TRUNCATE org_members, organizations, users, new_signups CASCADE`;
}

async function insertUser(userId: string, email: string): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
}

async function countOrgs(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM organizations`;
  return Number(rows[0]?.count ?? '0');
}

async function countMembers(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM org_members`;
  return Number(rows[0]?.count ?? '0');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  sql = postgres(container.getConnectionUri());
  enterTestContext(sql);
  await bootstrap();
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

beforeEach(async () => {
  await reset();
});

describe('Auth0 provisioner BOTH-OR-NEITHER — integration (real Postgres)', () => {
  it('Auth0 throws BEFORE INSERT -> zero DB writes (no orphan org rows)', async () => {
    await insertUser('user_alpha', 'alpha@example.com');

    const provisioner: OrgAuth0Provisioner = vi.fn().mockRejectedValue(
      new Error('Auth0 Management API 503'),
    );
    const rollback: OrgAuth0Rollback = vi.fn().mockResolvedValue(undefined);
    const service = new OrgService({
      auth0Provisioner: provisioner,
      auth0Rollback: rollback,
    });

    await expect(service.createOrg('Acme', 'user_alpha')).rejects.toThrow(
      'Auth0 Management API 503',
    );

    // Zero DB writes — no orphan rows. This is the load-bearing
    // invariant for BOTH-OR-NEITHER's order-of-ops rationale.
    expect(await countOrgs()).toBe(0);
    expect(await countMembers()).toBe(0);
    expect(provisioner).toHaveBeenCalledOnce();
    // No rollback needed — there's no Auth0 peer to delete.
    expect(rollback).not.toHaveBeenCalled();
  });

  it('Auth0 succeeds + DB INSERT FK violation -> rollback fires with auth0OrgId + original Postgres error propagates', async () => {
    // NO users row inserted on purpose — createOrg uses owner_id =
    // 'user_missing', which violates the FK to users(id). Real Postgres
    // throws an error with code 23503 (foreign_key_violation).
    const provisioner: OrgAuth0Provisioner = vi.fn().mockResolvedValue({
      auth0OrgId: 'org_auth0_real_postgres_test',
    });
    const rollback: OrgAuth0Rollback = vi.fn().mockResolvedValue(undefined);
    const service = new OrgService({
      auth0Provisioner: provisioner,
      auth0Rollback: rollback,
    });

    // The caller-facing throw is the original Postgres FK violation —
    // NOT the rollback error (which doesn't happen here; the rollback
    // succeeds cleanly).
    await expect(service.createOrg('Acme', 'user_missing')).rejects.toThrow(
      /foreign key|owner_id/i,
    );

    // No DB rows survived — Postgres rejected the INSERT before any
    // organizations row was written.
    expect(await countOrgs()).toBe(0);
    expect(await countMembers()).toBe(0);

    // Rollback fired with the auth0OrgId from the provisioner — locks
    // the auth0OrgId-flows-through-catch contract.
    expect(provisioner).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledWith('org_auth0_real_postgres_test');
  });

  it('Auth0 succeeds + DB INSERT FK violation + rollback ALSO throws -> original Postgres error still propagates (no error-contract muddling)', async () => {
    const provisioner: OrgAuth0Provisioner = vi.fn().mockResolvedValue({
      auth0OrgId: 'org_auth0_rollback_will_fail',
    });
    const rollback: OrgAuth0Rollback = vi.fn().mockRejectedValue(
      new Error('Auth0 deleteOrganization 500'),
    );
    const service = new OrgService({
      auth0Provisioner: provisioner,
      auth0Rollback: rollback,
    });

    // Force the FK violation by referencing a missing owner_id. The
    // rollback will then fire and throw its own error — but the throw
    // that PROPAGATES to the caller must be the Postgres FK error, not
    // the Auth0 deleteOrganization error. Locks the docstring contract:
    // "the original DB error is the load-bearing signal the caller needs
    // to handle. Surfacing both would muddle the error contract."
    await expect(service.createOrg('Acme', 'user_missing')).rejects.toThrow(
      /foreign key|owner_id/i,
    );

    expect(rollback).toHaveBeenCalledWith('org_auth0_rollback_will_fail');
    expect(await countOrgs()).toBe(0);
    expect(await countMembers()).toBe(0);
  });

  it('happy path against real Postgres: provisioner ID lands on the organizations row + member row inserted', async () => {
    await insertUser('user_happy', 'happy@example.com');

    const provisioner: OrgAuth0Provisioner = vi.fn().mockResolvedValue({
      auth0OrgId: 'org_auth0_happy_path',
    });
    const rollback: OrgAuth0Rollback = vi.fn().mockResolvedValue(undefined);
    const service = new OrgService({
      auth0Provisioner: provisioner,
      auth0Rollback: rollback,
    });

    const org = await service.createOrg('Acme', 'user_happy');

    // Round-trip: auth0OrgId from the provisioner ends up on the
    // organizations.auth0_org_id column AND surfaces on the returned
    // Organization via toOrg's mapper.
    expect(org.auth0OrgId).toBe('org_auth0_happy_path');

    const rows = await sql<{ auth0_org_id: string }[]>`
      SELECT auth0_org_id FROM organizations WHERE id = ${org.id}
    `;
    expect(rows[0]?.auth0_org_id).toBe('org_auth0_happy_path');

    // Owner-member row inserted alongside.
    expect(await countMembers()).toBe(1);
    // Rollback never fires on the happy path.
    expect(rollback).not.toHaveBeenCalled();
  });

  it('UNIQUE constraint on auth0_org_id catches accidental double-create -> rollback fires for the second attempt', async () => {
    // Locks the migration 046 UNIQUE constraint at the integration
    // layer — slice 1 docstring claims by-construction protection
    // against drift between Conduit + Auth0; this test exercises the
    // constraint against real Postgres so the claim isn't just textual.
    await insertUser('user_first', 'first@example.com');
    await insertUser('user_second', 'second@example.com');

    const sameAuth0Id = 'org_auth0_collision_target';

    // First create succeeds.
    {
      const provisioner: OrgAuth0Provisioner = vi.fn().mockResolvedValue({
        auth0OrgId: sameAuth0Id,
      });
      const rollback: OrgAuth0Rollback = vi.fn().mockResolvedValue(undefined);
      const service = new OrgService({
        auth0Provisioner: provisioner,
        auth0Rollback: rollback,
      });
      const org = await service.createOrg('First Acme', 'user_first');
      expect(org.auth0OrgId).toBe(sameAuth0Id);
    }

    // Second create with the SAME auth0OrgId — Postgres UNIQUE
    // constraint rejects the INSERT. Rollback fires to clean up the
    // Auth0-side state for the second attempt.
    const provisioner2: OrgAuth0Provisioner = vi.fn().mockResolvedValue({
      auth0OrgId: sameAuth0Id,
    });
    const rollback2: OrgAuth0Rollback = vi.fn().mockResolvedValue(undefined);
    const service2 = new OrgService({
      auth0Provisioner: provisioner2,
      auth0Rollback: rollback2,
    });

    await expect(service2.createOrg('Second Acme', 'user_second')).rejects.toThrow(
      /unique|duplicate key|auth0_org_id/i,
    );

    expect(rollback2).toHaveBeenCalledWith(sameAuth0Id);
    // Only one org row + one member row survive (from the first create).
    expect(await countOrgs()).toBe(1);
    expect(await countMembers()).toBe(1);
  });
});
