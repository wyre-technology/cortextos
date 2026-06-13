import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enterTestContext } from '../db/context.js';

/**
 * Multi-IdP slice 6+7 PR-B — OrgIdpConnectionService unit tests against a
 * mock SQL substrate. Locks the CRUD-shape contracts the wizard handler
 * depends on. Integration-test layer exercises the full schema (UNIQUE,
 * FK CASCADE) against real Postgres.
 */

describe('OrgIdpConnectionService', () => {
  let OrgIdpConnectionService: typeof import('./org-idp-connection-service.js').OrgIdpConnectionService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./org-idp-connection-service.js');
    OrgIdpConnectionService = mod.OrgIdpConnectionService;
  });

  function createMockSql() {
    const rows = new Map<string, Record<string, unknown>>();
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');

      if (query.includes('INSERT INTO org_idp_connections')) {
        const id = values[0] as string;
        const orgId = values[1] as string;
        const auth0ConnectionId = values[2] as string;
        const entityId = values[3] as string;
        const strategy = values[4] as string;
        const displayName = (values[5] as string | null) ?? null;
        const createdByUserId = values[6] as string;
        const now = new Date().toISOString();
        const row = {
          id,
          org_id: orgId,
          auth0_connection_id: auth0ConnectionId,
          entity_id: entityId,
          strategy,
          display_name: displayName,
          status: 'active',
          created_by_user_id: createdByUserId,
          created_at: now,
          updated_at: now,
        };
        rows.set(id, row);
        return Promise.resolve([row]);
      }

      if (query.includes('SELECT * FROM org_idp_connections') && query.includes('WHERE org_id =')) {
        const orgId = values[0] as string;
        return Promise.resolve(
          Array.from(rows.values()).filter((r) => r.org_id === orgId),
        );
      }

      if (query.includes('SELECT * FROM org_idp_connections WHERE id =')) {
        const id = values[0] as string;
        const row = rows.get(id);
        return Promise.resolve(row ? [row] : []);
      }

      if (query.includes('DELETE FROM org_idp_connections WHERE id =')) {
        const id = values[0] as string;
        rows.delete(id);
        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    };
    return sql;
  }

  it('create() inserts row + returns typed entity with status="active"', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new OrgIdpConnectionService();
    const conn = await svc.create({
      orgId: 'org_abc',
      auth0ConnectionId: 'con_xyz',
      entityId: 'https://idp.example.com',
      strategy: 'samlp',
      displayName: 'Acme Okta',
      createdByUserId: 'user_admin',
    });
    expect(conn.id).toMatch(/^idpc_/);
    expect(conn.orgId).toBe('org_abc');
    expect(conn.auth0ConnectionId).toBe('con_xyz');
    expect(conn.entityId).toBe('https://idp.example.com');
    expect(conn.strategy).toBe('samlp');
    expect(conn.displayName).toBe('Acme Okta');
    expect(conn.status).toBe('active');
    expect(conn.createdByUserId).toBe('user_admin');
  });

  it('create() handles optional displayName by storing null', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new OrgIdpConnectionService();
    const conn = await svc.create({
      orgId: 'org_abc',
      auth0ConnectionId: 'con_xyz',
      entityId: 'https://idp.example.com',
      strategy: 'samlp',
      createdByUserId: 'user_admin',
    });
    expect(conn.displayName).toBeNull();
  });

  it('listForOrg() returns only connections for the matching org', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new OrgIdpConnectionService();
    await svc.create({
      orgId: 'org_a',
      auth0ConnectionId: 'con_a1',
      entityId: 'https://a1',
      strategy: 'samlp',
      createdByUserId: 'user_admin',
    });
    await svc.create({
      orgId: 'org_a',
      auth0ConnectionId: 'con_a2',
      entityId: 'https://a2',
      strategy: 'samlp',
      createdByUserId: 'user_admin',
    });
    await svc.create({
      orgId: 'org_b',
      auth0ConnectionId: 'con_b1',
      entityId: 'https://b1',
      strategy: 'samlp',
      createdByUserId: 'user_admin',
    });

    const aList = await svc.listForOrg('org_a');
    const bList = await svc.listForOrg('org_b');
    expect(aList).toHaveLength(2);
    expect(bList).toHaveLength(1);
    expect(aList.every((c) => c.orgId === 'org_a')).toBe(true);
  });

  it('getById() returns the matching row, or null when absent', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new OrgIdpConnectionService();
    const created = await svc.create({
      orgId: 'org_abc',
      auth0ConnectionId: 'con_xyz',
      entityId: 'https://idp.example.com',
      strategy: 'samlp',
      createdByUserId: 'user_admin',
    });
    const found = await svc.getById(created.id);
    expect(found?.id).toBe(created.id);

    const missing = await svc.getById('idpc_does_not_exist');
    expect(missing).toBeNull();
  });

  it('hardDelete() removes the row (subsequent getById returns null)', async () => {
    const sql = createMockSql();
    enterTestContext(sql as unknown as Parameters<typeof enterTestContext>[0]);
    const svc = new OrgIdpConnectionService();
    const created = await svc.create({
      orgId: 'org_abc',
      auth0ConnectionId: 'con_xyz',
      entityId: 'https://idp.example.com',
      strategy: 'samlp',
      createdByUserId: 'user_admin',
    });
    await svc.hardDelete(created.id);
    const found = await svc.getById(created.id);
    expect(found).toBeNull();
  });
});
