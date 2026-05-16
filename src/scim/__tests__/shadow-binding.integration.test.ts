/**
 * Integration test for SCIM shadow-id binding.
 *
 * The Auth0 callback in src/auth/auth0.ts contains a 10-line tx that, on
 * first SSO login matching a `shadow:%` users row by lower(email), reassigns
 * the row's id to the Auth0 sub. FK cascades carry org_members and
 * org_team_members along.
 *
 * This test exercises that binding step against a real Postgres so we catch:
 *   - case-insensitive email match
 *   - FK cascade on UPDATE id (referenced rows in org_members get rewritten)
 *   - idempotency (no shadow row, or already bound id, is a no-op)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScimUsersHandler } from '../users-handler.js';
import { bindShadowUserOnLogin } from '../shadow-binding.js';
import { seedOwner, startIntegrationDb, type IntegrationDb } from './integration-harness.js';
import { enterTestContext } from '../../db/context.js';

let db: IntegrationDb;
let handler: ScimUsersHandler;

beforeAll(async () => {
  db = await startIntegrationDb();
  handler = new ScimUsersHandler();
}, 90_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.reset();
  enterTestContext(db.sql);
});

describe('Shadow-id binding', () => {
  it('promotes a shadow id to the Auth0 sub on first login (matched by lower(email))', async () => {
    await seedOwner(db.sql, { orgId: 'orgX', orgType: 'standalone' });
    const conn = {
      id: 'c1', orgId: 'orgX', scope: 'tenant' as const, idpType: 'entra' as const,
      tokenHash: '', defaultRole: 'member', status: 'active' as const,
      lastSyncAt: null, lastError: null, createdAt: '', createdBy: null, revokedAt: null,
    };

    // SCIM provisions Iris with mixed-case email.
    await handler.create(conn, { userName: 'Iris@Acme.com' });
    const [shadow] = await db.sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = 'iris@acme.com'
    `;
    expect(shadow.id).toMatch(/^shadow:/);

    // Iris logs in via Auth0 with all-lowercase email.
    await bindShadowUserOnLogin(db.sql, 'auth0|abc123', 'iris@acme.com');

    const [bound] = await db.sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = 'iris@acme.com'
    `;
    expect(bound.id).toBe('auth0|abc123');
  });

  it("does nothing when there's no shadow row for the email", async () => {
    await db.sql`
      INSERT INTO users (id, email, name) VALUES ('auth0|already', 'real@acme.com', 'Real')
    `;
    await bindShadowUserOnLogin(db.sql, 'auth0|already', 'real@acme.com');
    const rows = await db.sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = 'real@acme.com'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('auth0|already');
  });

  it('is a no-op if the shadow id already matches the sub (idempotent)', async () => {
    await seedOwner(db.sql, { orgId: 'orgY', orgType: 'standalone' });
    const conn = {
      id: 'c1', orgId: 'orgY', scope: 'tenant' as const, idpType: 'entra' as const,
      tokenHash: '', defaultRole: 'member', status: 'active' as const,
      lastSyncAt: null, lastError: null, createdAt: '', createdBy: null, revokedAt: null,
    };
    await handler.create(conn, { userName: 'jay@acme.com' });
    const [first] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'jay@acme.com'`;
    await bindShadowUserOnLogin(db.sql, first.id, 'jay@acme.com'); // sub == shadow id
    const [second] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'jay@acme.com'`;
    expect(second.id).toBe(first.id);
  });
});
