import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

// We test the CredentialService with a mock SQL that captures queries.
// This verifies encryption round-trips and the store/get contract.

describe('CredentialService', () => {
  let CredentialService: typeof import('./credential-service.js').CredentialService;
  const masterKey = randomBytes(32).toString('hex');

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('MASTER_KEY', masterKey);
    vi.stubEnv('JWT_SECRET', randomBytes(32).toString('hex'));
    const mod = await import('./credential-service.js');
    CredentialService = mod.CredentialService;
  });

  function createMockSql() {
    // Separate stores for personal, org, team, and service client credentials
    const personalStore = new Map<string, Record<string, unknown>>();
    const orgStore = new Map<string, Record<string, unknown>>();
    const teamStore = new Map<string, Record<string, unknown>>();
    const svcClientStore = new Map<string, Record<string, unknown>>();
    // Reseller shared vendor grants, keyed by `${customerOrgId}:${vendorSlug}`.
    const grantStore = new Map<
      string,
      {
        id: string;
        reseller_org_id: string;
        customer_org_id: string;
        vendor_slug: string;
        enabled: boolean;
      }
    >();

    // Create a tagged template function that mimics postgres.js
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');

      // Handle CREATE TABLE
      if (query.includes('CREATE TABLE')) {
        return Promise.resolve([]);
      }

      // -----------------------------------------------------------------------
      // org_credentials — must be checked BEFORE generic "credentials" matches
      // -----------------------------------------------------------------------

      // INSERT INTO org_credentials
      if (query.includes('INSERT INTO org_credentials')) {
        const id = values[0] as string;
        const orgId = values[1] as string;
        const vendorSlug = values[2] as string;
        const key = `${orgId}:${vendorSlug}`;
        orgStore.set(key, {
          id,
          org_id: orgId,
          vendor_slug: vendorSlug,
          encrypted_data: values[3],
          iv: values[4],
          auth_tag: values[5],
          salt: values[6],
          created_by: values[7],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return Promise.resolve([{ id }]);
      }

      // SELECT vendor_slug FROM org_credentials (listOrgVendors)
      if (
        query.includes('SELECT vendor_slug FROM org_credentials')
      ) {
        const orgId = values[0] as string;
        const results: { vendor_slug: string }[] = [];
        for (const [k, row] of orgStore.entries()) {
          if (k.startsWith(`${orgId}:`)) {
            results.push({ vendor_slug: row.vendor_slug as string });
          }
        }
        results.sort((a, b) => a.vendor_slug.localeCompare(b.vendor_slug));
        return Promise.resolve(results);
      }

      // SELECT * FROM org_credentials (getOrgCredential)
      if (query.includes('SELECT') && query.includes('org_credentials')) {
        const orgId = values[0] as string;
        const vendorSlug = values[1] as string;
        const key = `${orgId}:${vendorSlug}`;
        const row = orgStore.get(key);
        return Promise.resolve(row ? [row] : []);
      }

      // DELETE FROM org_credentials
      if (query.includes('DELETE') && query.includes('org_credentials')) {
        const orgId = values[0] as string;
        const vendorSlug = values[1] as string;
        const key = `${orgId}:${vendorSlug}`;
        const existed = orgStore.delete(key);
        return Promise.resolve(Object.assign([], { count: existed ? 1 : 0 }));
      }

      // -----------------------------------------------------------------------
      // reseller_shared_vendor_grants
      // -----------------------------------------------------------------------

      if (query.includes('reseller_shared_vendor_grants')) {
        // resolveForOrgAndVendor reads: customer_org_id, vendor_slug, enabled=TRUE
        const customerOrgId = values[0] as string;
        const vendorSlug = values[1] as string;
        const grant = grantStore.get(`${customerOrgId}:${vendorSlug}`);
        if (grant && grant.enabled) {
          return Promise.resolve([grant]);
        }
        return Promise.resolve([]);
      }

      // -----------------------------------------------------------------------
      // org_team_credentials
      // -----------------------------------------------------------------------

      if (query.includes('INSERT INTO org_team_credentials')) {
        const id = values[0] as string;
        const teamId = values[1] as string;
        const orgId = values[2] as string;
        const vendorSlug = values[3] as string;
        const key = `${teamId}:${vendorSlug}`;
        teamStore.set(key, {
          id,
          team_id: teamId,
          org_id: orgId,
          vendor_slug: vendorSlug,
          encrypted_data: values[4],
          iv: values[5],
          auth_tag: values[6],
          salt: values[7],
          created_by: values[8],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return Promise.resolve([{ id }]);
      }

      if (query.includes('SELECT vendor_slug FROM org_team_credentials')) {
        const teamId = values[0] as string;
        const results: { vendor_slug: string }[] = [];
        for (const [k, row] of teamStore.entries()) {
          if (k.startsWith(`${teamId}:`)) {
            results.push({ vendor_slug: row.vendor_slug as string });
          }
        }
        results.sort((a, b) => a.vendor_slug.localeCompare(b.vendor_slug));
        return Promise.resolve(results);
      }

      if (query.includes('SELECT') && query.includes('org_team_credentials')) {
        const teamId = values[0] as string;
        const vendorSlug = values[1] as string;
        const row = teamStore.get(`${teamId}:${vendorSlug}`);
        return Promise.resolve(row ? [row] : []);
      }

      if (query.includes('DELETE') && query.includes('org_team_credentials')) {
        const teamId = values[0] as string;
        const vendorSlug = values[1] as string;
        const existed = teamStore.delete(`${teamId}:${vendorSlug}`);
        return Promise.resolve(Object.assign([], { count: existed ? 1 : 0 }));
      }

      // -----------------------------------------------------------------------
      // service_client_credentials
      // -----------------------------------------------------------------------

      if (query.includes('INSERT INTO service_client_credentials')) {
        const id = values[0] as string;
        const clientId = values[1] as string;
        const orgId = values[2] as string;
        const vendorSlug = values[3] as string;
        const key = `${clientId}:${vendorSlug}`;
        svcClientStore.set(key, {
          id,
          client_id: clientId,
          org_id: orgId,
          vendor_slug: vendorSlug,
          encrypted_data: values[4],
          iv: values[5],
          auth_tag: values[6],
          salt: values[7],
          created_by: values[8],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return Promise.resolve([{ id }]);
      }

      if (query.includes('SELECT vendor_slug FROM service_client_credentials')) {
        const clientId = values[0] as string;
        const results: { vendor_slug: string }[] = [];
        for (const [k, row] of svcClientStore.entries()) {
          if (k.startsWith(`${clientId}:`)) {
            results.push({ vendor_slug: row.vendor_slug as string });
          }
        }
        results.sort((a, b) => a.vendor_slug.localeCompare(b.vendor_slug));
        return Promise.resolve(results);
      }

      if (query.includes('SELECT') && query.includes('service_client_credentials')) {
        const clientId = values[0] as string;
        const vendorSlug = values[1] as string;
        const row = svcClientStore.get(`${clientId}:${vendorSlug}`);
        return Promise.resolve(row ? [row] : []);
      }

      if (query.includes('DELETE') && query.includes('service_client_credentials')) {
        const clientId = values[0] as string;
        const vendorSlug = values[1] as string;
        const existed = svcClientStore.delete(`${clientId}:${vendorSlug}`);
        return Promise.resolve(Object.assign([], { count: existed ? 1 : 0 }));
      }

      // -----------------------------------------------------------------------
      // personal credentials
      // -----------------------------------------------------------------------

      // INSERT INTO credentials
      if (query.includes('INSERT INTO credentials')) {
        const id = values[0] as string;
        const userId = values[1] as string;
        const vendorSlug = values[2] as string;
        const key = `${userId}:${vendorSlug}`;
        personalStore.set(key, {
          id,
          user_id: userId,
          vendor_slug: vendorSlug,
          encrypted_data: values[3],
          iv: values[4],
          auth_tag: values[5],
          salt: values[6],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return Promise.resolve([{ id }]);
      }

      // SELECT from credentials
      if (query.includes('SELECT') && query.includes('credentials')) {
        const userId = values[0] as string;
        const vendorSlug = values[1] as string;
        const key = `${userId}:${vendorSlug}`;
        const row = personalStore.get(key);
        return Promise.resolve(row ? [row] : []);
      }

      // DELETE from credentials
      if (query.includes('DELETE')) {
        const userId = values[0] as string;
        const vendorSlug = values[1] as string;
        const key = `${userId}:${vendorSlug}`;
        const existed = personalStore.delete(key);
        return Promise.resolve(Object.assign([], { count: existed ? 1 : 0 }));
      }

      // COUNT from credentials
      if (query.includes('COUNT')) {
        const userId = values[0] as string;
        const vendorSlug = values[1] as string;
        const key = `${userId}:${vendorSlug}`;
        return Promise.resolve([{ count: personalStore.has(key) ? 1 : 0 }]);
      }

      return Promise.resolve([]);
    };

    // Expose the grant store for tests that need to seed or revoke grants.
    (sql as unknown as { _grants: typeof grantStore })._grants = grantStore;

    return sql as unknown as import('postgres').Sql;
  }

  /** Convenience: seed a grant row via the mock sql handle. */
  function seedGrant(
    sql: import('postgres').Sql,
    grant: {
      id: string;
      resellerOrgId: string;
      customerOrgId: string;
      vendorSlug: string;
      enabled?: boolean;
    },
  ): void {
    const store = (sql as unknown as {
      _grants: Map<
        string,
        {
          id: string;
          reseller_org_id: string;
          customer_org_id: string;
          vendor_slug: string;
          enabled: boolean;
        }
      >;
    })._grants;
    store.set(`${grant.customerOrgId}:${grant.vendorSlug}`, {
      id: grant.id,
      reseller_org_id: grant.resellerOrgId,
      customer_org_id: grant.customerOrgId,
      vendor_slug: grant.vendorSlug,
      enabled: grant.enabled ?? true,
    });
  }

  // -------------------------------------------------------------------------
  // Personal credentials
  // -------------------------------------------------------------------------

  it('encrypts and decrypts credential data correctly', async () => {
    const sql = createMockSql();
    const service = new CredentialService(sql);

    const creds = {
      apiKey: 'my-api-key-12345',
      apiSecret: 'super-secret-value',
      platform: 'concord',
    };

    await service.store('user_abc', 'datto-rmm', creds);

    const retrieved = await service.get('user_abc', 'datto-rmm');
    expect(retrieved).toEqual(creds);
  });

  it('returns null for non-existent credentials', async () => {
    const sql = createMockSql();
    const service = new CredentialService(sql);

    const result = await service.get('unknown_user', 'datto-rmm');
    expect(result).toBeNull();
  });

  it('overwrites credentials on upsert (same user+vendor)', async () => {
    const sql = createMockSql();
    const service = new CredentialService(sql);

    await service.store('user_abc', 'datto-rmm', { apiKey: 'old-key' });
    await service.store('user_abc', 'datto-rmm', { apiKey: 'new-key' });

    const retrieved = await service.get('user_abc', 'datto-rmm');
    expect(retrieved).toEqual({ apiKey: 'new-key' });
  });

  it('isolates credentials between users', async () => {
    const sql = createMockSql();
    const service = new CredentialService(sql);

    await service.store('user_a', 'itglue', { apiKey: 'key-a' });
    await service.store('user_b', 'itglue', { apiKey: 'key-b' });

    expect(await service.get('user_a', 'itglue')).toEqual({ apiKey: 'key-a' });
    expect(await service.get('user_b', 'itglue')).toEqual({ apiKey: 'key-b' });
  });

  it('isolates credentials between vendors', async () => {
    const sql = createMockSql();
    const service = new CredentialService(sql);

    await service.store('user_abc', 'datto-rmm', { apiKey: 'datto-key' });
    await service.store('user_abc', 'itglue', { apiKey: 'itglue-key' });

    expect(await service.get('user_abc', 'datto-rmm')).toEqual({ apiKey: 'datto-key' });
    expect(await service.get('user_abc', 'itglue')).toEqual({ apiKey: 'itglue-key' });
  });

  // -------------------------------------------------------------------------
  // Org credentials
  // -------------------------------------------------------------------------

  describe('Org credentials', () => {
    it('encrypts and decrypts org credential data correctly', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      const creds = {
        apiKey: 'org-api-key-99999',
        apiSecret: 'org-super-secret',
        subdomain: 'acme-corp',
      };

      await service.storeOrgCredential('org_123', 'datto-rmm', creds, 'user_admin');

      const retrieved = await service.getOrgCredential('org_123', 'datto-rmm');
      expect(retrieved).toEqual(creds);
    });

    it('returns null for non-existent org credentials', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      const result = await service.getOrgCredential('org_unknown', 'datto-rmm');
      expect(result).toBeNull();
    });

    it('isolates org credentials between orgs', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeOrgCredential('org_a', 'itglue', { apiKey: 'org-a-key' }, 'admin_a');
      await service.storeOrgCredential('org_b', 'itglue', { apiKey: 'org-b-key' }, 'admin_b');

      expect(await service.getOrgCredential('org_a', 'itglue')).toEqual({ apiKey: 'org-a-key' });
      expect(await service.getOrgCredential('org_b', 'itglue')).toEqual({ apiKey: 'org-b-key' });
    });

    it('isolates personal and org credentials for same vendor', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      // Store a personal credential for a user
      await service.store('user_abc', 'datto-rmm', { apiKey: 'personal-key' });
      // Store an org credential for a different scope
      await service.storeOrgCredential('org_123', 'datto-rmm', { apiKey: 'org-key' }, 'user_abc');

      // Each scope returns its own credential, uncontaminated by the other
      expect(await service.get('user_abc', 'datto-rmm')).toEqual({ apiKey: 'personal-key' });
      expect(await service.getOrgCredential('org_123', 'datto-rmm')).toEqual({ apiKey: 'org-key' });
    });
  });

  // -------------------------------------------------------------------------
  // Team credentials
  // -------------------------------------------------------------------------

  describe('Team credentials', () => {
    it('encrypts and decrypts team credential data correctly', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      const creds = { apiKey: 'team-key-123', subdomain: 'acme' };
      await service.storeTeamCredential('team_1', 'org_1', 'datto-rmm', creds, 'admin_1');

      expect(await service.getTeamCredential('team_1', 'datto-rmm')).toEqual(creds);
    });

    it('returns null for non-existent team credential', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      expect(await service.getTeamCredential('team_unknown', 'datto-rmm')).toBeNull();
    });

    it('overwrites on upsert (same team+vendor)', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeTeamCredential('team_1', 'org_1', 'itglue', { apiKey: 'old' }, 'admin');
      await service.storeTeamCredential('team_1', 'org_1', 'itglue', { apiKey: 'new' }, 'admin');

      expect(await service.getTeamCredential('team_1', 'itglue')).toEqual({ apiKey: 'new' });
    });

    it('isolates credentials between teams', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeTeamCredential('team_a', 'org_1', 'itglue', { apiKey: 'a-key' }, 'admin');
      await service.storeTeamCredential('team_b', 'org_1', 'itglue', { apiKey: 'b-key' }, 'admin');

      expect(await service.getTeamCredential('team_a', 'itglue')).toEqual({ apiKey: 'a-key' });
      expect(await service.getTeamCredential('team_b', 'itglue')).toEqual({ apiKey: 'b-key' });
    });

    it('deletes correctly', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeTeamCredential('team_1', 'org_1', 'datto-rmm', { apiKey: 'k' }, 'admin');
      expect(await service.deleteTeamCredential('team_1', 'datto-rmm')).toBe(true);
      expect(await service.deleteTeamCredential('team_1', 'datto-rmm')).toBe(false);
    });

    it('listTeamVendors returns sorted slugs', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeTeamCredential('team_1', 'org_1', 'itglue', { apiKey: 'a' }, 'admin');
      await service.storeTeamCredential('team_1', 'org_1', 'datto-rmm', { apiKey: 'b' }, 'admin');

      expect(await service.listTeamVendors('team_1')).toEqual(['datto-rmm', 'itglue']);
    });
  });

  // -------------------------------------------------------------------------
  // Service client credentials
  // -------------------------------------------------------------------------

  describe('Service client credentials', () => {
    it('encrypts and decrypts service client credential data correctly', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      const creds = { apiKey: 'svc-key-456', platform: 'concord' };
      await service.storeServiceClientCredential('client_1', 'org_1', 'datto-rmm', creds, 'admin_1');

      expect(await service.getServiceClientCredential('client_1', 'datto-rmm')).toEqual(creds);
    });

    it('returns null for non-existent service client credential', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      expect(await service.getServiceClientCredential('client_unknown', 'datto-rmm')).toBeNull();
    });

    it('overwrites on upsert (same client+vendor)', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeServiceClientCredential('client_1', 'org_1', 'itglue', { apiKey: 'old' }, 'admin');
      await service.storeServiceClientCredential('client_1', 'org_1', 'itglue', { apiKey: 'new' }, 'admin');

      expect(await service.getServiceClientCredential('client_1', 'itglue')).toEqual({ apiKey: 'new' });
    });

    it('isolates credentials between service clients', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeServiceClientCredential('client_a', 'org_1', 'itglue', { apiKey: 'a' }, 'admin');
      await service.storeServiceClientCredential('client_b', 'org_1', 'itglue', { apiKey: 'b' }, 'admin');

      expect(await service.getServiceClientCredential('client_a', 'itglue')).toEqual({ apiKey: 'a' });
      expect(await service.getServiceClientCredential('client_b', 'itglue')).toEqual({ apiKey: 'b' });
    });

    it('deletes correctly', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeServiceClientCredential('client_1', 'org_1', 'datto-rmm', { apiKey: 'k' }, 'admin');
      expect(await service.deleteServiceClientCredential('client_1', 'datto-rmm')).toBe(true);
      expect(await service.deleteServiceClientCredential('client_1', 'datto-rmm')).toBe(false);
    });

    it('listServiceClientVendors returns sorted slugs', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeServiceClientCredential('client_1', 'org_1', 'itglue', { apiKey: 'a' }, 'admin');
      await service.storeServiceClientCredential('client_1', 'org_1', 'datto-rmm', { apiKey: 'b' }, 'admin');

      expect(await service.listServiceClientVendors('client_1')).toEqual(['datto-rmm', 'itglue']);
    });
  });

  // -------------------------------------------------------------------------
  // resolveForOrgAndVendor (reseller-shared credential resolution)
  // -------------------------------------------------------------------------

  describe('resolveForOrgAndVendor', () => {
    it('returns the customer org credential when one exists', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeOrgCredential(
        'cust_1',
        'datto-rmm',
        { apiKey: 'customer-key' },
        'admin_1',
      );

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved).not.toBeNull();
      expect(resolved?.source).toBe('customer');
      expect(resolved?.ownerOrgId).toBe('cust_1');
      expect(resolved?.grantId).toBeNull();
      expect(resolved?.data).toEqual({ apiKey: 'customer-key' });
    });

    it('falls back to the reseller credential when only a grant exists', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      // Reseller has a shared credential; customer has none of its own.
      await service.storeOrgCredential(
        'reseller_1',
        'datto-rmm',
        { apiKey: 'shared-reseller-key' },
        'reseller_admin',
      );
      seedGrant(sql, {
        id: 'grant_abc',
        resellerOrgId: 'reseller_1',
        customerOrgId: 'cust_1',
        vendorSlug: 'datto-rmm',
        enabled: true,
      });

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved).not.toBeNull();
      expect(resolved?.source).toBe('reseller_grant');
      expect(resolved?.ownerOrgId).toBe('reseller_1');
      expect(resolved?.grantId).toBe('grant_abc');
      expect(resolved?.data).toEqual({ apiKey: 'shared-reseller-key' });
    });

    it('prefers the customer credential when both a grant and an own cred exist', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeOrgCredential(
        'reseller_1',
        'datto-rmm',
        { apiKey: 'shared-reseller-key' },
        'reseller_admin',
      );
      await service.storeOrgCredential(
        'cust_1',
        'datto-rmm',
        { apiKey: 'customer-key' },
        'cust_admin',
      );
      seedGrant(sql, {
        id: 'grant_abc',
        resellerOrgId: 'reseller_1',
        customerOrgId: 'cust_1',
        vendorSlug: 'datto-rmm',
        enabled: true,
      });

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved?.source).toBe('customer');
      expect(resolved?.data).toEqual({ apiKey: 'customer-key' });
    });

    it('ignores a disabled (revoked) grant and returns null when the customer has no own cred', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeOrgCredential(
        'reseller_1',
        'datto-rmm',
        { apiKey: 'shared-reseller-key' },
        'reseller_admin',
      );
      seedGrant(sql, {
        id: 'grant_abc',
        resellerOrgId: 'reseller_1',
        customerOrgId: 'cust_1',
        vendorSlug: 'datto-rmm',
        enabled: false,
      });

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved).toBeNull();
    });

    it('falls back to the customer own cred when the grant is disabled but the customer has its own', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      await service.storeOrgCredential(
        'cust_1',
        'datto-rmm',
        { apiKey: 'customer-key' },
        'cust_admin',
      );
      seedGrant(sql, {
        id: 'grant_abc',
        resellerOrgId: 'reseller_1',
        customerOrgId: 'cust_1',
        vendorSlug: 'datto-rmm',
        enabled: false,
      });

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved?.source).toBe('customer');
      expect(resolved?.data).toEqual({ apiKey: 'customer-key' });
    });

    it('returns null when no credential exists anywhere', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved).toBeNull();
    });

    it('returns null when a grant references a reseller that has no credential stored', async () => {
      const sql = createMockSql();
      const service = new CredentialService(sql);

      seedGrant(sql, {
        id: 'grant_abc',
        resellerOrgId: 'reseller_1',
        customerOrgId: 'cust_1',
        vendorSlug: 'datto-rmm',
        enabled: true,
      });

      const resolved = await service.resolveForOrgAndVendor('cust_1', 'datto-rmm');
      expect(resolved).toBeNull();
    });
  });
});
