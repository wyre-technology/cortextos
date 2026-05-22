/**
 * Invitation flow integration test — end-to-end against a real Postgres.
 *
 * The unit suite at `src/org/invitation-service.test.ts` (added in PR #61)
 * pins the post-015 contract via fake SQL. Walter's review observation
 * on PR #61 was: "unit tests pin the contract; nothing exercises the
 * contract end-to-end." This file is that gap-filler at the data
 * layer — InvitationService + MemberService against a real
 * testcontainer, full create → hash-lookup → accept → second-accept-
 * rejected loop.
 *
 * Scope is deliberately data-layer, not HTTP-layer. The HTTP routes
 * require Auth0 authentication; stubbing that cleanly in integration
 * is its own piece of work. Service-level integration proves the
 * post-015 contract holds against real Postgres semantics (real
 * sha256 lookup, real UNIQUE constraints, real row-counting on
 * single-use accept), which is the property the unit tests can't
 * verify.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { nanoid } from 'nanoid';

import { InvitationService } from '../invitation-service.js';
import { MemberService } from '../member-service.js';
import { hashInvitationToken } from '../invitation-token-hash.js';
import { enterTestContext } from '../../db/context.js';

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;
let svc: InvitationService;

async function bootstrap(): Promise<void> {
  // Minimum schema for the invitation-flow code path. Mirrors the
  // post-015 shape: no plaintext `token` column on org_invitations.
  await sql`
    CREATE TABLE users (
      id    TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    )
  `;
  await sql`
    CREATE TABLE organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  await sql`
    CREATE TABLE org_invitations (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_by  TEXT NOT NULL REFERENCES users(id),
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      accepted_by TEXT REFERENCES users(id),
      accepted_at TIMESTAMPTZ,
      max_uses    INTEGER,
      use_count   INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function seedOrg(orgId: string, ownerId: string, ownerEmail: string): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES (${ownerId}, ${ownerEmail})`;
  await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, ${'Org-' + orgId})`;
  await sql`INSERT INTO org_members (id, org_id, user_id, role) VALUES (${nanoid()}, ${orgId}, ${ownerId}, 'owner')`;
}

async function seedUser(userId: string, email: string): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => undefined });
  await bootstrap();
  svc = new InvitationService(new MemberService());
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // Fresh state per test — keeps assertions independent.
  await sql`TRUNCATE org_invitations, org_members, organizations, users CASCADE`;
  enterTestContext(sql);
});

describe('invitation flow — end-to-end against real Postgres', () => {
  it('createInvitation persists only the hash; plaintext is response-only', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');

    const { invitation, plainToken } = await svc.createInvitation('org-1', 'owner-1');

    expect(plainToken.length).toBeGreaterThanOrEqual(20);
    expect((invitation as unknown as Record<string, unknown>).token).toBeUndefined();

    // Real DB introspection: no plaintext column was written. After 015
    // the column doesn't exist, so the query itself proves the contract.
    const [row] = await sql<{ token_hash: string }[]>`
      SELECT token_hash FROM org_invitations WHERE id = ${invitation.id}
    `;
    expect(row.token_hash).toBe(hashInvitationToken(plainToken));
  });

  it('getInvitationByToken finds a freshly-issued invitation via hash lookup', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    const { plainToken } = await svc.createInvitation('org-1', 'owner-1');

    const found = await svc.getInvitationByToken(plainToken);
    expect(found).not.toBeNull();
    expect(found!.orgId).toBe('org-1');
  });

  it('getInvitationByToken returns null for an unknown token (real sha256 mismatch)', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    await svc.createInvitation('org-1', 'owner-1');

    const found = await svc.getInvitationByToken('a-token-the-server-never-issued');
    expect(found).toBeNull();
  });

  it('acceptInvitation creates a membership for the joining user', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    await seedUser('joiner-1', 'joiner@example.com');
    const { plainToken } = await svc.createInvitation('org-1', 'owner-1');

    const member = await svc.acceptInvitation(plainToken, 'joiner-1');
    expect(member).not.toBeNull();
    // Member-invite path (no intendedRole='owner', no recipientEmail) → OrgMember.
    expect(member).not.toHaveProperty('kind');
    expect((member as { orgId: string }).orgId).toBe('org-1');
    expect((member as { userId: string }).userId).toBe('joiner-1');

    const [row] = await sql<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM org_members WHERE org_id = 'org-1' AND user_id = 'joiner-1'
    `;
    expect(Number(row.count)).toBe(1);
  });

  it('single-use invitation: second accept by a different user is rejected', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    await seedUser('joiner-1', 'joiner1@example.com');
    await seedUser('joiner-2', 'joiner2@example.com');
    // Default maxUses is 1.
    const { plainToken } = await svc.createInvitation('org-1', 'owner-1');

    const first = await svc.acceptInvitation(plainToken, 'joiner-1');
    expect(first).not.toBeNull();

    const second = await svc.acceptInvitation(plainToken, 'joiner-2');
    expect(second).toBeNull();
  });

  it('multi-use invitation honors max_uses and rejects beyond the cap', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    await seedUser('joiner-1', 'j1@example.com');
    await seedUser('joiner-2', 'j2@example.com');
    await seedUser('joiner-3', 'j3@example.com');
    const { plainToken } = await svc.createInvitation('org-1', 'owner-1', { maxUses: 2 });

    expect(await svc.acceptInvitation(plainToken, 'joiner-1')).not.toBeNull();
    expect(await svc.acceptInvitation(plainToken, 'joiner-2')).not.toBeNull();
    expect(await svc.acceptInvitation(plainToken, 'joiner-3')).toBeNull();
  });

  it('expired invitation is not accepted', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    await seedUser('joiner-1', 'j1@example.com');
    const { invitation, plainToken } = await svc.createInvitation('org-1', 'owner-1');

    // Backdate the row's expires_at so it's already past.
    await sql`UPDATE org_invitations SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${invitation.id}`;

    expect(await svc.getInvitationByToken(plainToken)).toBeNull();
    expect(await svc.acceptInvitation(plainToken, 'joiner-1')).toBeNull();
  });

  it('listInvitations returns rows for the org, with no token field on any row', async () => {
    await seedOrg('org-1', 'owner-1', 'owner@example.com');
    await svc.createInvitation('org-1', 'owner-1');
    await svc.createInvitation('org-1', 'owner-1');

    const list = await svc.listInvitations('org-1');
    expect(list).toHaveLength(2);
    for (const inv of list) {
      expect((inv as unknown as Record<string, unknown>).token).toBeUndefined();
    }
  });
});
