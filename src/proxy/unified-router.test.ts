import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { unifiedProxyRoutes } from './unified-router.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock credential-injector
vi.mock('./credential-injector.js', () => {
  class AuthError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.name = 'AuthError';
      this.statusCode = statusCode;
    }
  }

  return {
    AuthError,
    resolveUserId: vi.fn().mockResolvedValue('user-123'),
    injectCredentials: vi.fn(),
  };
});

// Mock vendor-config
vi.mock('../credentials/vendor-config.js', () => ({
  getVendor: vi.fn((slug: string) => {
    const vendors: Record<string, unknown> = {
      autotask: { name: 'Autotask', slug: 'autotask', containerUrl: 'http://autotask:8080', mcpPath: '/mcp' },
      'datto-rmm': { name: 'Datto RMM', slug: 'datto-rmm', containerUrl: 'http://datto:8080', mcpPath: '/mcp' },
    };
    return vendors[slug] ?? null;
  }),
  getVendorSlugs: vi.fn(() => ['autotask', 'datto-rmm']),
}));

// Mock config
vi.mock('../config.js', () => ({
  config: {
    baseUrl: 'https://mcp.example.com',
  },
}));

// vi.hoisted ensures this variable is defined before vi.mock's factory runs.
// (Vitest hoists vi.mock calls above regular variable declarations.)
const { getOrFetchSpy } = vi.hoisted(() => {
  const spy = vi.fn(
    async (
      _scope: string,
      _vendor: string,
      _tool: string,
      _params: unknown,
      fetcher: () => Promise<unknown>,
    ) => {
      const value = await fetcher();
      return { value, fromCache: false };
    },
  );
  return { getOrFetchSpy: spy };
});

// Mock result-cache
vi.mock('./result-cache.js', () => ({
  ResultCache: vi.fn().mockImplementation(() => ({
    getOrFetch: getOrFetchSpy,
    invalidate: vi.fn().mockResolvedValue(undefined),
  })),
  VENDOR_TOOL_CONFIG: {
    autotask: {
      // A cacheable read tool used in cache scope isolation tests
      autotask_search_tickets: { isWrite: false, ttlMs: 30_000 },
    },
  },
}));

// Mock nanoid
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id-123'),
}));

import { injectCredentials, resolveUserId, AuthError } from './credential-injector.js';
import { ResultCache } from './result-cache.js';
import type { ToolCache } from './tool-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockToolCache(): ToolCache {
  return {
    getTools: vi.fn(),
    invalidate: vi.fn(),
  } as unknown as ToolCache;
}

function createMockSql() {
  const sqlFn = vi.fn().mockReturnValue({
    catch: vi.fn().mockReturnValue(undefined),
  });
  // Tagged template literal support
  return Object.assign(
    (...args: unknown[]) => sqlFn(...args),
    sqlFn,
  ) as unknown as import('postgres').Sql;
}

function createMockOrgService() {
  return {
    getMembership: vi.fn().mockResolvedValue({ role: 'owner' }),
    getToolAllowlist: vi.fn().mockResolvedValue(null),
    getUserOrgs: vi.fn().mockResolvedValue([]),
    getUserTeams: vi.fn().mockResolvedValue([]),
    hasServerAccess: vi.fn().mockResolvedValue(true),
  } as unknown as import('../org/org-service.js').OrgService;
}

function createMockBillingGate() {
  return {
    getRateLimit: vi.fn().mockResolvedValue(1000),
  } as unknown as import('../billing/gate.js').BillingGate;
}

function createMockCredentialService(connectedVendors: string[] = []) {
  return {
    listVendors: vi.fn().mockResolvedValue(connectedVendors),
    listOrgVendors: vi.fn().mockResolvedValue(connectedVendors),
    listTeamVendors: vi.fn().mockResolvedValue(connectedVendors),
  } as unknown as import('../credentials/credential-service.js').CredentialService;
}

async function buildApp(toolCache: ToolCache, connectedVendors: string[] = ['autotask', 'datto-rmm']) {
  const app = Fastify({ logger: false });

  await app.register(
    unifiedProxyRoutes({
      credentialService: createMockCredentialService(connectedVendors),
      orgService: createMockOrgService(),
      billingGate: createMockBillingGate(),
      toolCache,
      sql: createMockSql(),
    }),
  );

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Unified MCP Router', () => {
  let app: FastifyInstance;
  let toolCache: ToolCache;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-establish resolveUserId default after clearAllMocks resets it
    vi.mocked(resolveUserId).mockResolvedValue('user-123');
    toolCache = createMockToolCache();
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  describe('initialize', () => {
    it('returns gateway serverInfo without proxying', async () => {
      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0' },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.serverInfo.name).toBe('mcp-gateway');
      expect(body.result.capabilities).toHaveProperty('tools');
      // Should NOT call any vendor container
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('tools/list', () => {
    it('returns prefixed tools from multiple vendors', async () => {
      vi.mocked(injectCredentials)
        .mockResolvedValueOnce({ userId: 'user-123', vendor: 'autotask', headers: { 'X-Key': 'at' } })
        .mockResolvedValueOnce({ userId: 'user-123', vendor: 'datto-rmm', headers: { 'X-Key': 'dr' } });

      vi.mocked(toolCache.getTools)
        .mockResolvedValueOnce([
          { name: 'list_tickets', description: 'List tickets' },
          { name: 'create_ticket', description: 'Create a ticket' },
        ])
        .mockResolvedValueOnce([
          { name: 'list_devices', description: 'List devices' },
        ]);

      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const tools = body.result.tools;

      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe('autotask__list_tickets');
      expect(tools[0].description).toBe('[Autotask] List tickets');
      expect(tools[1].name).toBe('autotask__create_ticket');
      expect(tools[2].name).toBe('datto-rmm__list_devices');
      expect(tools[2].description).toBe('[Datto RMM] List devices');
    });

    it('skips vendors where user has no credentials', async () => {
      vi.mocked(injectCredentials)
        .mockResolvedValueOnce({ userId: 'user-123', vendor: 'autotask', headers: { 'X-Key': 'at' } })
        .mockRejectedValueOnce(new AuthError(403, 'No credentials'));

      vi.mocked(toolCache.getTools).mockResolvedValueOnce([
        { name: 'list_tickets', description: 'List tickets' },
      ]);

      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });

      const body = JSON.parse(res.body);
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0].name).toBe('autotask__list_tickets');
    });

    it('returns empty tools list when user has no credentials for any vendor', async () => {
      vi.mocked(injectCredentials)
        .mockRejectedValueOnce(new AuthError(403, 'No credentials'))
        .mockRejectedValueOnce(new AuthError(403, 'No credentials'));

      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });

      const body = JSON.parse(res.body);
      expect(body.result.tools).toHaveLength(0);
    });
  });

  describe('tools/call', () => {
    it('routes to correct vendor based on prefix', async () => {
      vi.mocked(injectCredentials).mockResolvedValueOnce({
        userId: 'user-123',
        vendor: 'autotask',
        headers: { 'X-Key': 'at-secret' },
      });

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 3,
          result: { content: [{ type: 'text', text: 'Ticket #1' }] },
        }),
      } as Response);

      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'autotask__get_ticket', arguments: { id: 1 } },
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify injectCredentials was called with 'autotask'
      expect(injectCredentials).toHaveBeenCalledWith(
        'Bearer valid-token',
        'autotask',
        expect.anything(),
        expect.anything(),
      );

      // Verify the proxied request has the original (un-prefixed) tool name
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe('http://autotask:8080/mcp');
      const fetchBody = JSON.parse(fetchCall[1]!.body as string);
      expect(fetchBody.params.name).toBe('get_ticket');
    });

    it('strips prefix before proxying', async () => {
      vi.mocked(injectCredentials).mockResolvedValueOnce({
        userId: 'user-123',
        vendor: 'datto-rmm',
        headers: { 'X-Key': 'dr-secret' },
      });

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 4,
          result: { content: [{ type: 'text', text: 'OK' }] },
        }),
      } as Response);

      app = await buildApp(toolCache);

      await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'datto-rmm__list_devices', arguments: {} },
        },
      });

      const fetchBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(fetchBody.params.name).toBe('list_devices');
    });

    it('returns error for unknown vendor prefix', async () => {
      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'unknown-vendor__some_tool', arguments: {} },
        },
      });

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Unknown vendor');
    });

    it('returns error for missing prefix separator', async () => {
      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'no_prefix_here', arguments: {} },
        },
      });

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('Invalid tool name format');
    });
  });

  describe('authentication', () => {
    it('returns 401 with WWW-Authenticate for unauthenticated POST requests', async () => {
      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('resource_metadata');
      expect(res.headers['www-authenticate']).toContain('/v1/mcp');
    });

    it('returns 401 with WWW-Authenticate for unauthenticated GET requests', async () => {
      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/mcp',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('notifications/initialized', () => {
    it('acknowledges with 202', async () => {
      app = await buildApp(toolCache);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });

      expect(res.statusCode).toBe(202);
    });
  });

  describe('tool allowlist filtering', () => {
    it('filters tools/list based on org allowlist', async () => {
      const orgService = createMockOrgService();
      vi.mocked(orgService.getMembership).mockResolvedValue({ role: 'member' } as never);
      vi.mocked(orgService.getToolAllowlist).mockResolvedValue(['list_tickets']);

      vi.mocked(injectCredentials)
        .mockResolvedValueOnce({ userId: 'user-123', vendor: 'autotask', orgId: 'org-1', headers: { 'X-Key': 'at' } })
        .mockRejectedValueOnce(new AuthError(403, 'No creds'));

      vi.mocked(toolCache.getTools).mockResolvedValueOnce([
        { name: 'list_tickets', description: 'List tickets' },
        { name: 'create_ticket', description: 'Create ticket' },
        { name: 'delete_ticket', description: 'Delete ticket' },
      ]);

      const customApp = Fastify({ logger: false });
      await customApp.register(
        unifiedProxyRoutes({
          credentialService: createMockCredentialService(['autotask']),
          orgService,
          billingGate: createMockBillingGate(),
          toolCache,
          sql: createMockSql(),
        }),
      );
      await customApp.ready();

      const res = await customApp.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });

      const body = JSON.parse(res.body);
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0].name).toBe('autotask__list_tickets');

      await customApp.close();
    });

    it('allows tools/call for tools in allowlist', async () => {
      const orgService = createMockOrgService();
      vi.mocked(orgService.getMembership).mockResolvedValue({ role: 'member' } as never);
      vi.mocked(orgService.getToolAllowlist).mockResolvedValue(['list_tickets']);

      vi.mocked(injectCredentials).mockResolvedValueOnce({
        userId: 'user-123',
        vendor: 'autotask',
        orgId: 'org-1',
        headers: { 'X-Key': 'at' },
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 4, result: { content: [] } }),
      } as never);

      const customApp = Fastify({ logger: false });
      await customApp.register(
        unifiedProxyRoutes({
          credentialService: createMockCredentialService(),
          orgService,
          billingGate: createMockBillingGate(),
          toolCache,
          sql: createMockSql(),
        }),
      );
      await customApp.ready();

      const res = await customApp.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'autotask__list_tickets', arguments: {} },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.error).toBeUndefined();

      await customApp.close();
    });

    it('blocks tools/call for tools not in allowlist', async () => {
      const orgService = createMockOrgService();
      vi.mocked(orgService.getMembership).mockResolvedValue({ role: 'member' } as never);
      vi.mocked(orgService.getToolAllowlist).mockResolvedValue(['list_tickets']);

      vi.mocked(injectCredentials).mockResolvedValueOnce({
        userId: 'user-123',
        vendor: 'autotask',
        orgId: 'org-1',
        headers: { 'X-Key': 'at' },
      });

      const customApp = Fastify({ logger: false });
      await customApp.register(
        unifiedProxyRoutes({
          credentialService: createMockCredentialService(['autotask']),
          orgService,
          billingGate: createMockBillingGate(),
          toolCache,
          sql: createMockSql(),
        }),
      );
      await customApp.ready();

      const res = await customApp.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'autotask__create_ticket', arguments: {} },
        },
      });

      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('not permitted');

      await customApp.close();
    });
  });

  describe('result cache scope isolation', () => {
    // Helper: make a tools/call for autotask__autotask_search_tickets (a cacheable read tool
    // in VENDOR_TOOL_CONFIG) with the given injection, and return the scope getOrFetch was
    // called with. Uses the shared `app` instance from the outer beforeEach.
    async function scopeForInjection(
      injection: Partial<{ userId: string; vendor: string; orgId?: string; teamId?: string; headers: Record<string, string> }>,
    ): Promise<string> {
      getOrFetchSpy.mockClear();

      // vi.restoreAllMocks() in afterEach (Vitest 1.x) resets vi.fn() implementations.
      // Re-establish the ResultCache mock before each call.
      vi.mocked(ResultCache).mockImplementation(() => ({
        getOrFetch: getOrFetchSpy,
        invalidate: vi.fn().mockResolvedValue(undefined),
      }) as never);

      vi.mocked(injectCredentials).mockResolvedValueOnce({
        userId: 'user-123',
        vendor: 'autotask',
        headers: { 'X-Key': 'at' },
        ...injection,
      } as never);

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
      } as never);

      app = await buildApp(toolCache);

      await app.inject({
        method: 'POST',
        url: '/v1/mcp',
        headers: { authorization: 'Bearer valid-token' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'autotask__autotask_search_tickets', arguments: {} },
        },
      });

      // Return the first argument (scope) of the first getOrFetch call
      return getOrFetchSpy.mock.calls[0]?.[0] as string;
    }

    it('uses team scope when teamId is set (even if orgId is also present)', async () => {
      // Regression test for P0 cross-tenant data leak:
      // two teams in the same org had different vendor instances but shared
      // an org-scoped cache, causing cross-team data leakage.
      const scope = await scopeForInjection({ orgId: 'org-1', teamId: 'team-A' });

      expect(scope).toBe('team:team-A');
      expect(scope).not.toBe('org:org-1');
    });

    it('uses org scope when orgId is set but teamId is not', async () => {
      const scope = await scopeForInjection({ orgId: 'org-1', teamId: undefined });

      expect(scope).toBe('org:org-1');
    });

    it('uses user scope when neither orgId nor teamId is set', async () => {
      const scope = await scopeForInjection({ orgId: undefined, teamId: undefined });

      expect(scope).toBe('user:user-123');
    });

    it('team scope takes priority over org scope (isolation invariant)', async () => {
      // Team A and Team B are in the same org but must have isolated caches
      // because they may have different vendor credentials/instances.
      const scopeForTeamA = await scopeForInjection({ orgId: 'shared-org', teamId: 'team-A' });
      const scopeForTeamB = await scopeForInjection({ orgId: 'shared-org', teamId: 'team-B' });

      expect(scopeForTeamA).toBe('team:team-A');
      expect(scopeForTeamB).toBe('team:team-B');
      expect(scopeForTeamA).not.toBe(scopeForTeamB);
    });
  });
});
