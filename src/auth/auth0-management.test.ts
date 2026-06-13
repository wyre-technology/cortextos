import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    auth0Domain: 'wyre.test.auth0.com',
    auth0M2mClientId: 'test_m2m_client_id',
    auth0M2mClientSecret: 'test_m2m_client_secret',
  },
}));

import {
  Auth0ManagementClient,
  Auth0ManagementError,
} from './auth0-management.js';

/**
 * Multi-IdP foundation slice 2 unit tests — Auth0 Management API client.
 *
 * The client is exercised end-to-end against a mocked fetch (no live Auth0
 * calls). The token-cache + dedup + error-translation contracts are the
 * load-bearing pieces the slice-3/4/5 callers will depend on.
 */

interface MockFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetchMock() {
  const calls: MockFetchCall[] = [];
  const responses: Array<() => Response> = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body as string | undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch call: ${url}`);
    return next();
  });
  return {
    mock,
    calls,
    enqueueOk(body: unknown): void {
      responses.push(() => new Response(JSON.stringify(body), { status: 200 }));
    },
    enqueueStatus(status: number, body = ''): void {
      responses.push(() => new Response(body, { status }));
    },
    enqueueNoContent(): void {
      // 204 cannot carry a body per Fetch spec; pass `null` not `''`.
      responses.push(() => new Response(null, { status: 204 }));
    },
  };
}

describe('Auth0ManagementClient.createIfConfigured', () => {
  it('returns null when m2m creds are unset', async () => {
    // Re-import via dynamic module reset so the mocked config can be swapped.
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      config: { auth0Domain: 'x', auth0M2mClientId: '', auth0M2mClientSecret: '' },
    }));
    const { Auth0ManagementClient: Reimported } = await import('./auth0-management.js');
    expect(Reimported.createIfConfigured()).toBeNull();
  });

  it('returns null when domain is unset', async () => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      config: { auth0Domain: '', auth0M2mClientId: 'x', auth0M2mClientSecret: 'y' },
    }));
    const { Auth0ManagementClient: Reimported } = await import('./auth0-management.js');
    expect(Reimported.createIfConfigured()).toBeNull();
  });

  it('returns an instance when all three are set', async () => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      config: {
        auth0Domain: 'wyre.test.auth0.com',
        auth0M2mClientId: 'x',
        auth0M2mClientSecret: 'y',
      },
    }));
    const { Auth0ManagementClient: Reimported } = await import('./auth0-management.js');
    expect(Reimported.createIfConfigured()).toBeInstanceOf(Reimported);
  });
});

describe('Auth0ManagementClient — token cache + client_credentials flow', () => {
  let f: ReturnType<typeof makeFetchMock>;
  let now = 1_700_000_000_000;
  let client: Auth0ManagementClient;

  beforeEach(() => {
    f = makeFetchMock();
    now = 1_700_000_000_000;
    client = new Auth0ManagementClient(
      'wyre.test.auth0.com',
      'cid',
      'csecret',
      f.mock as unknown as typeof fetch,
      () => now,
    );
  });

  it('first call fetches a token then the operation; second call reuses the cached token', async () => {
    // Token fetch
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    // createOrganization response
    f.enqueueOk({ id: 'org_aaa', name: 'acme' });
    const a = await client.createOrganization({ name: 'acme', displayName: 'Acme' });
    expect(a.id).toBe('org_aaa');

    // Second op — only the op call hits fetch (token cache hits)
    f.enqueueOk({ id: 'org_bbb', name: 'beta' });
    const b = await client.createOrganization({ name: 'beta', displayName: 'Beta' });
    expect(b.id).toBe('org_bbb');

    expect(f.calls).toHaveLength(3);
    expect(f.calls[0].url).toBe('https://wyre.test.auth0.com/oauth/token');
    expect(f.calls[1].headers.Authorization).toBe('Bearer tok1');
    expect(f.calls[2].headers.Authorization).toBe('Bearer tok1');
  });

  it('expired token (within 60s buffer) triggers a fresh token fetch', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({ id: 'org_aaa', name: 'acme' });
    await client.createOrganization({ name: 'acme', displayName: 'Acme' });

    // Advance clock to within the 60s refresh buffer
    now += (86400 - 30) * 1000;

    f.enqueueOk({ access_token: 'tok2', expires_in: 86400 });
    f.enqueueOk({ id: 'org_bbb', name: 'beta' });
    await client.createOrganization({ name: 'beta', displayName: 'Beta' });

    // 4 calls total: tok1 fetch + create_a + tok2 fetch + create_b
    expect(f.calls).toHaveLength(4);
    expect(f.calls[3].headers.Authorization).toBe('Bearer tok2');
  });

  it('concurrent token-stale calls dedup the token fetch (no thundering-herd)', async () => {
    // Slow-token implementation that pushes to `calls` like the default mock
    // but defers response resolution until we explicitly trigger it. Lets us
    // observe what happens when p2 enters getAccessToken WHILE p1's token
    // fetch is still in-flight.
    let resolveTokenFetch: ((r: Response) => void) | null = null;
    const tokenPromise = new Promise<Response>((res) => {
      resolveTokenFetch = res;
    });
    let firstFetchObserved = false;
    f.mock.mockImplementationOnce((input: string | URL | Request, init?: RequestInit) => {
      firstFetchObserved = true;
      f.calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: {},
        body: init?.body as string | undefined,
      });
      return tokenPromise;
    });
    f.enqueueOk({ id: 'org_aaa', name: 'a' });
    f.enqueueOk({ id: 'org_bbb', name: 'b' });

    const p1 = client.createOrganization({ name: 'a', displayName: 'A' });
    const p2 = client.createOrganization({ name: 'b', displayName: 'B' });

    // Microtask-drain so both p1 + p2 reach getAccessToken's await
    await Promise.resolve();
    expect(firstFetchObserved).toBe(true);

    resolveTokenFetch!(
      new Response(JSON.stringify({ access_token: 'tok1', expires_in: 86400 }), { status: 200 }),
    );

    const [a, b] = await Promise.all([p1, p2]);
    expect(a.id).toBe('org_aaa');
    expect(b.id).toBe('org_bbb');

    // Total fetch calls: 1 token + 2 creates = 3. NOT 2 tokens + 2 creates = 4.
    expect(f.calls).toHaveLength(3);
  });
});

describe('Auth0ManagementClient — error translation', () => {
  it('non-2xx response throws Auth0ManagementError with status + body', async () => {
    const f = makeFetchMock();
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueStatus(409, '{"message":"already exists"}');
    const client = new Auth0ManagementClient(
      'wyre.test.auth0.com',
      'cid',
      'csecret',
      f.mock as unknown as typeof fetch,
    );
    await expect(
      client.createOrganization({ name: 'acme', displayName: 'Acme' }),
    ).rejects.toMatchObject({
      name: 'Auth0ManagementError',
      status: 409,
      body: '{"message":"already exists"}',
    });
  });

  it('token fetch failure throws Auth0ManagementError surfacing the upstream status', async () => {
    const f = makeFetchMock();
    f.enqueueStatus(503, 'service unavailable');
    const client = new Auth0ManagementClient(
      'wyre.test.auth0.com',
      'cid',
      'csecret',
      f.mock as unknown as typeof fetch,
    );
    await expect(client.deleteOrganization('org_xyz')).rejects.toBeInstanceOf(
      Auth0ManagementError,
    );
  });
});

describe('Auth0ManagementClient — operation contracts', () => {
  let f: ReturnType<typeof makeFetchMock>;
  let client: Auth0ManagementClient;

  beforeEach(() => {
    f = makeFetchMock();
    client = new Auth0ManagementClient(
      'wyre.test.auth0.com',
      'cid',
      'csecret',
      f.mock as unknown as typeof fetch,
    );
  });

  it('createOrganization POSTs name + display_name + optional metadata', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({ id: 'org_aaa', name: 'acme', display_name: 'Acme' });
    await client.createOrganization({
      name: 'acme',
      displayName: 'Acme',
      metadata: { tier: 'reseller' },
    });
    const createCall = f.calls[1];
    expect(createCall.url).toContain('/api/v2/organizations');
    expect(createCall.method).toBe('POST');
    const sentBody = JSON.parse(createCall.body!);
    expect(sentBody).toEqual({
      name: 'acme',
      display_name: 'Acme',
      metadata: { tier: 'reseller' },
    });
  });

  it('createOrganization omits metadata when absent (avoids null/undefined wire-format weirdness)', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({ id: 'org_aaa', name: 'acme' });
    await client.createOrganization({ name: 'acme', displayName: 'Acme' });
    const sentBody = JSON.parse(f.calls[1].body!);
    expect(sentBody).toEqual({ name: 'acme', display_name: 'Acme' });
    expect('metadata' in sentBody).toBe(false);
  });

  it('enableConnection POSTs to /enabled_connections with the connection_id payload', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({ connection_id: 'con_xyz' });
    await client.enableConnection('org_aaa', 'con_xyz');
    const call = f.calls[1];
    expect(call.url).toContain('/api/v2/organizations/org_aaa/enabled_connections');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual({ connection_id: 'con_xyz' });
  });

  it('enableConnection url-encodes the org id (defense against pathological ids slipping into URLs)', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({ connection_id: 'con_xyz' });
    await client.enableConnection('org with spaces', 'con_xyz');
    expect(f.calls[1].url).toContain('/api/v2/organizations/org%20with%20spaces/enabled_connections');
  });

  it('deleteOrganization issues DELETE and accepts 204 No Content as success', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueNoContent();
    await client.deleteOrganization('org_aaa');
    expect(f.calls[1].method).toBe('DELETE');
    expect(f.calls[1].url).toContain('/api/v2/organizations/org_aaa');
  });

  // Multi-IdP slice 7: createConnection + deleteConnection operations.
  // Wire-format + URL-encoding defense + cascade rollback contract.

  it('createConnection POSTs name + strategy + options + optional enabled_clients/display_name/metadata', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({
      id: 'con_xyz',
      name: 'conduit-org-abc-saml',
      strategy: 'samlp',
    });
    await client.createConnection({
      name: 'conduit-org-abc-saml',
      strategy: 'samlp',
      options: {
        signInEndpoint: 'https://idp.example.com/sso',
        entityId: 'https://idp.example.com',
      },
      enabledClients: ['client_id_one'],
      displayName: 'Acme SAML',
      metadata: { conduit_org_id: 'org_abc' },
    });
    const call = f.calls[1];
    expect(call.url).toContain('/api/v2/connections');
    expect(call.method).toBe('POST');
    const body = JSON.parse(call.body!);
    expect(body).toEqual({
      name: 'conduit-org-abc-saml',
      strategy: 'samlp',
      options: {
        signInEndpoint: 'https://idp.example.com/sso',
        entityId: 'https://idp.example.com',
      },
      enabled_clients: ['client_id_one'],
      display_name: 'Acme SAML',
      metadata: { conduit_org_id: 'org_abc' },
    });
  });

  it('createConnection omits optional fields when absent (clean wire-format)', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueOk({ id: 'con_xyz', name: 'minimal', strategy: 'samlp' });
    await client.createConnection({
      name: 'minimal',
      strategy: 'samlp',
      options: {},
    });
    const body = JSON.parse(f.calls[1].body!);
    expect(body).toEqual({ name: 'minimal', strategy: 'samlp', options: {} });
    expect('enabled_clients' in body).toBe(false);
    expect('display_name' in body).toBe(false);
    expect('metadata' in body).toBe(false);
  });

  it('deleteConnection issues DELETE + accepts 204 (rollback path cascade)', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueNoContent();
    await client.deleteConnection('con_xyz');
    expect(f.calls[1].method).toBe('DELETE');
    expect(f.calls[1].url).toContain('/api/v2/connections/con_xyz');
  });

  it('deleteConnection url-encodes the connection id (defense vs pathological ids)', async () => {
    f.enqueueOk({ access_token: 'tok1', expires_in: 86400 });
    f.enqueueNoContent();
    await client.deleteConnection('con id with spaces');
    expect(f.calls[1].url).toContain('/api/v2/connections/con%20id%20with%20spaces');
  });
});
