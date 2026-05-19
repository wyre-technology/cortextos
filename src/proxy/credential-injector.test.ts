import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as jose from 'jose';
import { randomBytes } from 'node:crypto';

describe('injectCredentials', () => {
  let injectCredentials: typeof import('./credential-injector.js').injectCredentials;
  let AuthError: typeof import('./credential-injector.js').AuthError;
  const jwtSecret = randomBytes(32).toString('hex');
  const baseUrl = 'http://localhost:8080';

  const mockCredentialService = {
    get: vi.fn(),
    getOrgCredential: vi.fn(),
    resolveForOrgAndVendor: vi.fn(),
    getTeamCredential: vi.fn(),
    getTeamCredentialsForTeams: vi.fn(),
    getServiceClientCredential: vi.fn(),
    store: vi.fn(),
    storeOrgCredential: vi.fn(),
    storeTeamCredential: vi.fn(),
    storeServiceClientCredential: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    listVendors: vi.fn(),
    initTables: vi.fn(),
  };

  const mockOrgService = {
    getUserOrgs: vi.fn(),
    getOrg: vi.fn(),
    createOrg: vi.fn(),
    updateOrg: vi.fn(),
    deleteOrg: vi.fn(),
    updateOrgPlan: vi.fn(),
    getMembers: vi.fn(),
    getMembership: vi.fn(),
    removeMember: vi.fn(),
    createInvitation: vi.fn(),
    getInvitationByToken: vi.fn(),
    acceptInvitation: vi.fn(),
    listInvitations: vi.fn(),
    revokeInvitation: vi.fn(),
    logRequest: vi.fn(),
    initTables: vi.fn(),
    hasServerAccess: vi.fn(),
    grantServerAccess: vi.fn(),
    revokeServerAccess: vi.fn(),
    listServerAccess: vi.fn(),
    bulkSetServerAccess: vi.fn(),
    grantAllServerAccess: vi.fn(),
    migrateServerAccessForExistingMembers: vi.fn(),
    updateOrgSettings: vi.fn(),
    getUserTeams: vi.fn(),
  };

  async function makeToken(sub: string, vendor: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    return new jose.SignJWT({ sub, vendor, scope: `mcp:${vendor}` })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(baseUrl)
      .sign(secret);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('MASTER_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('JWT_SECRET', jwtSecret);
    vi.stubEnv('BASE_URL', baseUrl);
    mockCredentialService.get.mockReset();
    mockCredentialService.getOrgCredential.mockReset();
    mockCredentialService.resolveForOrgAndVendor.mockReset();
    mockCredentialService.getTeamCredential.mockReset();
    mockCredentialService.getTeamCredentialsForTeams.mockReset();
    mockCredentialService.getServiceClientCredential.mockReset();
    mockCredentialService.storeOrgCredential.mockReset();
    mockCredentialService.storeTeamCredential.mockReset();
    mockCredentialService.storeServiceClientCredential.mockReset();
    mockOrgService.getUserOrgs.mockReset();
    mockOrgService.hasServerAccess.mockReset();
    mockOrgService.getMembership.mockReset();
    mockOrgService.getUserTeams.mockReset();
    // Defaults: no teams, no service client creds (backward-compatible)
    mockOrgService.getUserTeams.mockResolvedValue([]);
    mockCredentialService.getTeamCredential.mockResolvedValue(null);
    mockCredentialService.getTeamCredentialsForTeams.mockResolvedValue([]);
    mockCredentialService.getServiceClientCredential.mockResolvedValue(null);

    const mod = await import('./credential-injector.js');
    injectCredentials = mod.injectCredentials;
    AuthError = mod.AuthError;
  });

  it('rejects missing Authorization header', async () => {
    await expect(
      injectCredentials(undefined, 'datto-rmm', mockCredentialService as never),
    ).rejects.toThrow(AuthError);
  });

  it('rejects non-Bearer auth', async () => {
    await expect(
      injectCredentials('Basic abc123', 'datto-rmm', mockCredentialService as never),
    ).rejects.toThrow('Missing or invalid Authorization header');
  });

  it('rejects invalid JWT', async () => {
    await expect(
      injectCredentials('Bearer invalid.token.here', 'datto-rmm', mockCredentialService as never),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('rejects unknown vendor slug', async () => {
    // Token claims the same slug as the URL path so the cross-vendor binding
    // check passes; the request then reaches getVendor() which throws because
    // the slug isn't in the registry.
    const token = await makeToken('user123', 'nonexistent');
    await expect(
      injectCredentials(`Bearer ${token}`, 'nonexistent', mockCredentialService as never),
    ).rejects.toThrow('Unknown vendor');
  });

  it('rejects token issued for a different vendor (cross-vendor binding)', async () => {
    // Threat: a token minted during the OAuth flow for vendor A is sent to
    // /v1/<vendorB>/mcp. Without binding, vendor B's credentials are
    // injected — escalating from a low-trust vendor to a high-trust one.
    mockCredentialService.get.mockResolvedValue({ apiKey: 'x' });
    const tokenForA = await makeToken('user123', 'datto-rmm');
    await expect(
      injectCredentials(`Bearer ${tokenForA}`, 'autotask', mockCredentialService as never),
    ).rejects.toThrow(/cannot be used at autotask/);
    // The credential lookup for B must NOT have been attempted.
    expect(mockCredentialService.get).not.toHaveBeenCalled();
  });

  it('rejects human-user token with empty vendor claim (legacy unscoped)', async () => {
    // Pre-binding tokens didn't carry a vendor claim. Force re-issue via
    // refresh by rejecting these — alternative is silent vendor-scope drift
    // on already-issued long-lived tokens.
    const secret = new TextEncoder().encode(jwtSecret);
    const legacyToken = await new jose.SignJWT({ sub: 'user123', vendor: '', scope: 'mcp' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(baseUrl)
      .sign(secret);
    await expect(
      injectCredentials(`Bearer ${legacyToken}`, 'datto-rmm', mockCredentialService as never),
    ).rejects.toThrow(/missing vendor claim/);
  });

  it('rejects when no stored credentials exist', async () => {
    mockCredentialService.get.mockResolvedValue(null);
    const token = await makeToken('user123', 'datto-rmm');

    await expect(
      injectCredentials(`Bearer ${token}`, 'datto-rmm', mockCredentialService as never),
    ).rejects.toThrow('No stored credentials');
  });

  it('returns injected headers for valid token + stored creds', async () => {
    mockCredentialService.get.mockResolvedValue({
      apiKey: 'my-key',
      apiSecret: 'my-secret',
      platform: 'concord',
    });

    const token = await makeToken('user123', 'datto-rmm');
    const result = await injectCredentials(
      `Bearer ${token}`,
      'datto-rmm',
      mockCredentialService as never,
    );

    expect(result.userId).toBe('user123');
    expect(result.vendor).toBe('datto-rmm');
    expect(result.headers).toEqual({
      'X-Datto-API-Key': 'my-key',
      'X-Datto-API-Secret': 'my-secret',
      'X-Datto-Platform': 'concord',
    });
  });

  it('maps credentials to correct vendor-specific headers', async () => {
    mockCredentialService.get.mockResolvedValue({
      username: 'api-user',
      secret: 'api-secret',
      integrationCode: 'INT001',
    });

    const token = await makeToken('user456', 'autotask');
    const result = await injectCredentials(
      `Bearer ${token}`,
      'autotask',
      mockCredentialService as never,
    );

    expect(result.headers).toEqual({
      'X-Api-Key': 'api-user',
      'X-Api-Secret': 'api-secret',
      'X-Integration-Code': 'INT001',
    });
  });

  // -------------------------------------------------------------------------
  // Org credential fallback
  // -------------------------------------------------------------------------

  describe('org credential fallback', () => {
    it('returns org credentials when user has no personal creds and orgService provides org creds', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-42', name: 'Acme Corp', ownerId: 'owner-1', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue({
        data: {
          apiKey: 'org-key',
          apiSecret: 'org-secret',
          platform: 'concord',
        },
        vendorSlug: 'datto-rmm',
        ownerOrgId: 'org-42',
        source: 'customer',
        grantId: null,
      });
      mockOrgService.hasServerAccess.mockResolvedValue(true);

      const token = await makeToken('user789', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.userId).toBe('user789');
      expect(result.vendor).toBe('datto-rmm');
      expect(result.orgId).toBe('org-42');
      expect(result.headers).toEqual({
        'X-Datto-API-Key': 'org-key',
        'X-Datto-API-Secret': 'org-secret',
        'X-Datto-Platform': 'concord',
      });
      expect(mockCredentialService.get).toHaveBeenCalledWith('user789', 'datto-rmm');
      expect(mockOrgService.getUserOrgs).toHaveBeenCalledWith('user789');
      expect(mockCredentialService.resolveForOrgAndVendor).toHaveBeenCalledWith('org-42', 'datto-rmm');
    });

    it('throws AuthError when user has no personal creds and no org creds exist', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-42', name: 'Acme Corp', ownerId: 'owner-1', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue(null);

      const token = await makeToken('user789', 'datto-rmm');

      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('No stored credentials');
    });

    it('falls back to original behavior when orgService is not provided', async () => {
      mockCredentialService.get.mockResolvedValue(null);

      const token = await makeToken('user789', 'datto-rmm');

      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          undefined,
        ),
      ).rejects.toThrow('No stored credentials');

      // orgService was not provided so getUserOrgs must not be called
      expect(mockOrgService.getUserOrgs).not.toHaveBeenCalled();
    });

    it('tries multiple orgs and uses the first one with valid creds', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-1', name: 'First Org', ownerId: 'owner-1', plan: 'free' },
        { id: 'org-2', name: 'Second Org', ownerId: 'owner-2', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor
        .mockResolvedValueOnce(null) // org-1 has no creds
        .mockResolvedValueOnce({     // org-2 has creds
          data: {
            apiKey: 'org2-key',
            apiSecret: 'org2-secret',
            platform: 'concord',
          },
          vendorSlug: 'datto-rmm',
          ownerOrgId: 'org-2',
          source: 'customer',
          grantId: null,
        });
      mockOrgService.hasServerAccess.mockResolvedValue(true);

      const token = await makeToken('user789', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.orgId).toBe('org-2');
      expect(result.headers['X-Datto-API-Key']).toBe('org2-key');
      expect(mockCredentialService.resolveForOrgAndVendor).toHaveBeenCalledTimes(2);
      expect(mockCredentialService.resolveForOrgAndVendor).toHaveBeenCalledWith('org-1', 'datto-rmm');
      expect(mockCredentialService.resolveForOrgAndVendor).toHaveBeenCalledWith('org-2', 'datto-rmm');
    });

    it('skips org when user has no server access', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-42', name: 'Acme Corp', ownerId: 'owner-1', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue({
        data: {
          apiKey: 'org-key',
          apiSecret: 'org-secret',
          platform: 'concord',
        },
        vendorSlug: 'datto-rmm',
        ownerOrgId: 'org-42',
        source: 'customer',
        grantId: null,
      });
      mockOrgService.hasServerAccess.mockResolvedValue(false);

      const token = await makeToken('user789', 'datto-rmm');

      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('No stored credentials');

      expect(mockOrgService.hasServerAccess).toHaveBeenCalledWith('org-42', 'user789', 'datto-rmm');
    });

    it('skips org without access and uses next org with access', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-1', name: 'No Access Org', ownerId: 'owner-1', plan: 'pro' },
        { id: 'org-2', name: 'Has Access Org', ownerId: 'owner-2', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor
        .mockResolvedValueOnce({
          data: { apiKey: 'org1-key', apiSecret: 'org1-secret', platform: 'concord' },
          vendorSlug: 'datto-rmm',
          ownerOrgId: 'org-1',
          source: 'customer',
          grantId: null,
        })
        .mockResolvedValueOnce({
          data: { apiKey: 'org2-key', apiSecret: 'org2-secret', platform: 'concord' },
          vendorSlug: 'datto-rmm',
          ownerOrgId: 'org-2',
          source: 'customer',
          grantId: null,
        });
      mockOrgService.hasServerAccess
        .mockResolvedValueOnce(false) // no access to org-1
        .mockResolvedValueOnce(true);  // has access to org-2

      const token = await makeToken('user789', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.orgId).toBe('org-2');
      expect(result.headers['X-Datto-API-Key']).toBe('org2-key');
      expect(mockOrgService.hasServerAccess).toHaveBeenCalledTimes(2);
    });

    it('personal credentials are unaffected by server access controls', async () => {
      // Even if hasServerAccess would return false, personal creds always work
      mockCredentialService.get.mockResolvedValue({
        apiKey: 'personal-key',
        apiSecret: 'personal-secret',
        platform: 'concord',
      });

      const token = await makeToken('user789', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.orgId).toBeUndefined();
      expect(result.headers['X-Datto-API-Key']).toBe('personal-key');
      // hasServerAccess should never be called for personal creds
      expect(mockOrgService.hasServerAccess).not.toHaveBeenCalled();
    });

    it('prefers personal credentials over org credentials', async () => {
      mockCredentialService.get.mockResolvedValue({
        apiKey: 'personal-key',
        apiSecret: 'personal-secret',
        platform: 'concord',
      });

      const token = await makeToken('user789', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.orgId).toBeUndefined();
      expect(result.headers['X-Datto-API-Key']).toBe('personal-key');
      // orgService should never be consulted if personal creds exist
      expect(mockOrgService.getUserOrgs).not.toHaveBeenCalled();
      expect(mockCredentialService.resolveForOrgAndVendor).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Reseller-shared credential fallback
  // -------------------------------------------------------------------------

  describe('reseller-shared credential fallback', () => {
    it('injects reseller-granted credentials when the customer org has none of its own', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'customer-org', name: 'Customer', ownerId: 'owner-c', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue({
        data: {
          apiKey: 'reseller-key',
          apiSecret: 'reseller-secret',
          platform: 'concord',
        },
        vendorSlug: 'datto-rmm',
        ownerOrgId: 'reseller-org',
        source: 'reseller_grant',
        grantId: 'grant-abc',
      });
      mockOrgService.hasServerAccess.mockResolvedValue(true);

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const token = await makeToken('user-c', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.orgId).toBe('customer-org');
      expect(result.headers['X-Datto-API-Key']).toBe('reseller-key');

      // Audit trail: info-level log captures grant provenance
      expect(infoSpy).toHaveBeenCalledWith(
        'credential-injector: reseller-grant resolution',
        expect.objectContaining({
          grantId: 'grant-abc',
          resellerOrgId: 'reseller-org',
          customerOrgId: 'customer-org',
          vendorSlug: 'datto-rmm',
        }),
      );

      infoSpy.mockRestore();
    });

    it('does not log reseller-grant audit entry when credential source is the customer itself', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'customer-org', name: 'Customer', ownerId: 'owner-c', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue({
        data: { apiKey: 'own-key', apiSecret: 'own-secret', platform: 'concord' },
        vendorSlug: 'datto-rmm',
        ownerOrgId: 'customer-org',
        source: 'customer',
        grantId: null,
      });
      mockOrgService.hasServerAccess.mockResolvedValue(true);

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const token = await makeToken('user-c', 'datto-rmm');
      await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(infoSpy).not.toHaveBeenCalledWith(
        'credential-injector: reseller-grant resolution',
        expect.anything(),
      );

      infoSpy.mockRestore();
    });

    it('falls through with no regression when no grant exists and customer has no own credential', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'customer-org', name: 'Customer', ownerId: 'owner-c', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue(null);

      const token = await makeToken('user-c', 'datto-rmm');

      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('No stored credentials');
    });

    it('enforces hasServerAccess even for reseller-granted credentials', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'customer-org', name: 'Customer', ownerId: 'owner-c', plan: 'pro' },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue({
        data: { apiKey: 'reseller-key', apiSecret: 'reseller-secret', platform: 'concord' },
        vendorSlug: 'datto-rmm',
        ownerOrgId: 'reseller-org',
        source: 'reseller_grant',
        grantId: 'grant-abc',
      });
      mockOrgService.hasServerAccess.mockResolvedValue(false);

      const token = await makeToken('user-c', 'datto-rmm');
      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('No stored credentials');
    });
  });

  // -------------------------------------------------------------------------
  // Team-scoped credential resolution
  // -------------------------------------------------------------------------

  describe('team-scoped credential resolution', () => {
    it('resolves a team credential via one set-based query, not a per-team fan-out', async () => {
      mockCredentialService.get.mockResolvedValue(null); // no personal credential
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-1', name: 'Org', ownerId: 'owner', plan: 'pro' },
      ]);
      mockOrgService.getUserTeams.mockResolvedValue([{ id: 'team-a' }, { id: 'team-b' }]);
      mockCredentialService.getTeamCredentialsForTeams.mockResolvedValue([
        {
          teamId: 'team-b',
          creds: { apiKey: 'team-key', apiSecret: 'team-secret', platform: 'concord' },
        },
      ]);
      mockOrgService.hasServerAccess.mockResolvedValue(true);

      const token = await makeToken('user-t', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.headers).toBeDefined();
      // One query covering every team the user is in — not a per-team
      // Promise.all fan-out on the reserved-transaction connection.
      expect(mockCredentialService.getTeamCredentialsForTeams).toHaveBeenCalledTimes(1);
      expect(mockCredentialService.getTeamCredentialsForTeams).toHaveBeenCalledWith(
        ['team-a', 'team-b'],
        'datto-rmm',
      );
      expect(mockCredentialService.getTeamCredential).not.toHaveBeenCalled();
    });

    it('falls through to the org tier when more than one team has the credential', async () => {
      mockCredentialService.get.mockResolvedValue(null);
      mockOrgService.getUserOrgs.mockResolvedValue([
        { id: 'org-1', name: 'Org', ownerId: 'owner', plan: 'pro' },
      ]);
      mockOrgService.getUserTeams.mockResolvedValue([{ id: 'team-a' }, { id: 'team-b' }]);
      mockCredentialService.getTeamCredentialsForTeams.mockResolvedValue([
        { teamId: 'team-a', creds: { apiKey: 'k1', apiSecret: 's1', platform: 'concord' } },
        { teamId: 'team-b', creds: { apiKey: 'k2', apiSecret: 's2', platform: 'concord' } },
      ]);
      mockCredentialService.resolveForOrgAndVendor.mockResolvedValue(null);

      const token = await makeToken('user-t', 'datto-rmm');
      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('No stored credentials');
    });
  });

  // -------------------------------------------------------------------------
  // Service client (svc: prefix) tokens
  // -------------------------------------------------------------------------

  describe('service client tokens', () => {
    it('uses org credentials directly for svc: prefixed subject', async () => {
      mockCredentialService.getOrgCredential.mockResolvedValue({
        apiKey: 'org-key',
        apiSecret: 'org-secret',
        platform: 'concord',
      });

      const token = await makeToken('svc:org-42:svc_client123', 'datto-rmm');
      const result = await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      expect(result.userId).toBe('svc:org-42:svc_client123');
      expect(result.orgId).toBe('org-42');
      expect(result.headers['X-Datto-API-Key']).toBe('org-key');
      // Should NOT call personal creds or getUserOrgs
      expect(mockCredentialService.get).not.toHaveBeenCalled();
      expect(mockOrgService.getUserOrgs).not.toHaveBeenCalled();
      // Should call getOrgCredential directly with the org from the token
      expect(mockCredentialService.getOrgCredential).toHaveBeenCalledWith('org-42', 'datto-rmm');
    });

    it('throws AuthError when org has no credentials for vendor', async () => {
      mockCredentialService.getOrgCredential.mockResolvedValue(null);

      const token = await makeToken('svc:org-42:svc_client123', 'datto-rmm');

      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('Organization has no credentials');
    });

    it('throws AuthError for malformed svc: subject (missing orgId)', async () => {
      const token = await makeToken('svc:', 'datto-rmm');

      await expect(
        injectCredentials(
          `Bearer ${token}`,
          'datto-rmm',
          mockCredentialService as never,
          mockOrgService as never,
        ),
      ).rejects.toThrow('Malformed service client token');
    });

    it('does not check server access for service clients', async () => {
      mockCredentialService.getOrgCredential.mockResolvedValue({
        apiKey: 'org-key',
        apiSecret: 'org-secret',
        platform: 'concord',
      });

      const token = await makeToken('svc:org-42:svc_client123', 'datto-rmm');
      await injectCredentials(
        `Bearer ${token}`,
        'datto-rmm',
        mockCredentialService as never,
        mockOrgService as never,
      );

      // Service clients bypass server access checks — they have org-level access
      expect(mockOrgService.hasServerAccess).not.toHaveBeenCalled();
    });
  });
});
