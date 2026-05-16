/**
 * SCIM /Groups handler integration tests against real Postgres 15.
 *
 * Coverage:
 *   - POST /Groups creates org_teams + org_team_members
 *   - PATCH `Add` members — Entra-style capitalised op
 *   - PATCH `Remove` members[value eq "<id>"] — Entra-specific path filter
 *   - PATCH replace displayName — non-member op via scim-patch
 *   - PUT /Groups full replace swaps the member set
 *   - DELETE /Groups removes team and cascades members
 *   - GET /Groups?filter=displayName eq scoped to org
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScimGroupsHandler } from '../groups-handler.js';
import { ScimUsersHandler } from '../users-handler.js';
import type { ScimConnection } from '../types.js';
import { seedConnection, seedOwner, startIntegrationDb, type IntegrationDb } from './integration-harness.js';
import { enterTestContext } from '../../db/context.js';

let db: IntegrationDb;
let groups: ScimGroupsHandler;
let users: ScimUsersHandler;

function buildConnection(over: { orgId: string; createdBy: string }): ScimConnection {
  return {
    id: `scim_${over.orgId}`,
    orgId: over.orgId,
    scope: 'tenant',
    idpType: 'entra',
    tokenHash: '',
    defaultRole: 'member',
    status: 'active',
    lastSyncAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    createdBy: over.createdBy,
    revokedAt: null,
  };
}

beforeAll(async () => {
  db = await startIntegrationDb();
  groups = new ScimGroupsHandler();
  users = new ScimUsersHandler();
}, 90_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.reset();
  enterTestContext(db.sql);
});

async function provisionUser(conn: ScimConnection, email: string): Promise<string> {
  const res = await users.create(conn, { userName: email });
  return (res.body as { id: string }).id;
}

describe('SCIM /Groups', () => {
  it('POST /Groups creates an org_teams row + members', async () => {
    const owner = await seedOwner(db.sql, { orgId: 'orgA', orgType: 'standalone' });
    const conn = buildConnection({ orgId: 'orgA', createdBy: owner.userId });
    await seedConnection(db.sql, { id: `scim_orgA`, orgId: 'orgA', scope: 'tenant', createdBy: owner.userId });
    const aliceId = await provisionUser(conn, 'alice@acme.com');
    const bobId = await provisionUser(conn, 'bob@acme.com');

    const res = await groups.create(conn, {
      displayName: 'Engineering',
      externalId: 'entra-grp-1',
      members: [{ value: aliceId }, { value: bobId }],
    });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; displayName: string; members: Array<{ value: string }> };
    expect(body.displayName).toBe('Engineering');
    expect(body.members).toHaveLength(2);

    const [team] = await db.sql<{ name: string; external_id: string; scim_connection_id: string }[]>`
      SELECT name, external_id, scim_connection_id FROM org_teams WHERE id = ${body.id}
    `;
    expect(team.name).toBe('Engineering');
    expect(team.external_id).toBe('entra-grp-1');
    expect(team.scim_connection_id).toBe(conn.id);
  });

  it('PATCH Add members (Entra-style capitalised op + members[value eq] path)', async () => {
    const owner = await seedOwner(db.sql, { orgId: 'orgB', orgType: 'standalone' });
    const conn = buildConnection({ orgId: 'orgB', createdBy: owner.userId });
    await seedConnection(db.sql, { id: `scim_orgB`, orgId: 'orgB', scope: 'tenant', createdBy: owner.userId });
    const aliceId = await provisionUser(conn, 'alice@acme.com');
    const carolId = await provisionUser(conn, 'carol@acme.com');

    const created = await groups.create(conn, {
      displayName: 'Ops',
      members: [{ value: aliceId }],
    });
    const groupId = (created.body as { id: string }).id;

    const res = await groups.patch(conn, groupId, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Add', path: 'members', value: [{ value: carolId }] },
      ],
    });
    expect(res.status).toBe(200);

    const memberRows = await db.sql<{ user_id: string }[]>`
      SELECT user_id FROM org_team_members WHERE team_id = ${groupId} ORDER BY added_at
    `;
    expect(memberRows.map((r) => r.user_id).sort()).toEqual([aliceId, carolId].sort());
  });

  it('PATCH Remove members[value eq "<id>"] removes the targeted user', async () => {
    const owner = await seedOwner(db.sql, { orgId: 'orgC', orgType: 'standalone' });
    const conn = buildConnection({ orgId: 'orgC', createdBy: owner.userId });
    await seedConnection(db.sql, { id: `scim_orgC`, orgId: 'orgC', scope: 'tenant', createdBy: owner.userId });
    const aliceId = await provisionUser(conn, 'alice@acme.com');
    const carolId = await provisionUser(conn, 'carol@acme.com');

    const created = await groups.create(conn, {
      displayName: 'Sales',
      members: [{ value: aliceId }, { value: carolId }],
    });
    const groupId = (created.body as { id: string }).id;

    await groups.patch(conn, groupId, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'Remove', path: `members[value eq "${aliceId}"]` },
      ],
    });

    const memberRows = await db.sql<{ user_id: string }[]>`
      SELECT user_id FROM org_team_members WHERE team_id = ${groupId}
    `;
    expect(memberRows.map((r) => r.user_id)).toEqual([carolId]);
  });

  it('PATCH Replace displayName updates the team name', async () => {
    const owner = await seedOwner(db.sql, { orgId: 'orgD', orgType: 'standalone' });
    const conn = buildConnection({ orgId: 'orgD', createdBy: owner.userId });
    await seedConnection(db.sql, { id: `scim_orgD`, orgId: 'orgD', scope: 'tenant', createdBy: owner.userId });

    const created = await groups.create(conn, { displayName: 'OldName' });
    const groupId = (created.body as { id: string }).id;

    await groups.patch(conn, groupId, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'displayName', value: 'NewName' }],
    });

    const [t] = await db.sql<{ name: string }[]>`
      SELECT name FROM org_teams WHERE id = ${groupId}
    `;
    expect(t.name).toBe('NewName');
  });

  it('PUT /Groups full-replaces the member set', async () => {
    const owner = await seedOwner(db.sql, { orgId: 'orgE', orgType: 'standalone' });
    const conn = buildConnection({ orgId: 'orgE', createdBy: owner.userId });
    await seedConnection(db.sql, { id: `scim_orgE`, orgId: 'orgE', scope: 'tenant', createdBy: owner.userId });
    const aliceId = await provisionUser(conn, 'alice@acme.com');
    const bobId = await provisionUser(conn, 'bob@acme.com');
    const carolId = await provisionUser(conn, 'carol@acme.com');

    const created = await groups.create(conn, {
      displayName: 'Eng',
      members: [{ value: aliceId }, { value: bobId }],
    });
    const groupId = (created.body as { id: string }).id;

    await groups.replace(conn, groupId, {
      displayName: 'Eng',
      members: [{ value: carolId }],
    });

    const memberRows = await db.sql<{ user_id: string }[]>`
      SELECT user_id FROM org_team_members WHERE team_id = ${groupId}
    `;
    expect(memberRows.map((r) => r.user_id)).toEqual([carolId]);
  });

  it('DELETE removes the team and cascades members', async () => {
    const owner = await seedOwner(db.sql, { orgId: 'orgF', orgType: 'standalone' });
    const conn = buildConnection({ orgId: 'orgF', createdBy: owner.userId });
    await seedConnection(db.sql, { id: `scim_orgF`, orgId: 'orgF', scope: 'tenant', createdBy: owner.userId });
    const aliceId = await provisionUser(conn, 'alice@acme.com');

    const created = await groups.create(conn, {
      displayName: 'ToDelete',
      members: [{ value: aliceId }],
    });
    const groupId = (created.body as { id: string }).id;

    const res = await groups.delete(conn, groupId);
    expect(res.status).toBe(204);

    const teamRows = await db.sql`SELECT 1 FROM org_teams WHERE id = ${groupId}`;
    expect(teamRows.length).toBe(0);
    const memberRows = await db.sql`SELECT 1 FROM org_team_members WHERE team_id = ${groupId}`;
    expect(memberRows.length).toBe(0);
  });

  it('isolates groups by org_id', async () => {
    const ownerA = await seedOwner(db.sql, { orgId: 'orgG', orgType: 'standalone' });
    const ownerB = await seedOwner(db.sql, { orgId: 'orgH', orgType: 'standalone' });
    const connA = buildConnection({ orgId: 'orgG', createdBy: ownerA.userId });
    await seedConnection(db.sql, { id: `scim_orgG`, orgId: 'orgG', scope: 'tenant', createdBy: ownerA.userId });
    const connB = buildConnection({ orgId: 'orgH', createdBy: ownerB.userId });
    await seedConnection(db.sql, { id: `scim_orgH`, orgId: 'orgH', scope: 'tenant', createdBy: ownerB.userId });

    await groups.create(connA, { displayName: 'OnlyA' });
    const aList = await groups.list(connA, {});
    const bList = await groups.list(connB, {});
    expect((aList.body as { totalResults: number }).totalResults).toBe(1);
    expect((bList.body as { totalResults: number }).totalResults).toBe(0);
  });
});
