import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the byo-oauth network helpers; keep the real ByoOAuthError so the
// orchestration's thrown errors stay instanceof-checkable.
vi.mock('./byo-oauth.js', async (importActual) => {
  const actual = await importActual<typeof import('./byo-oauth.js')>();
  return {
    ...actual,
    discoverByoAuthServer: vi.fn(),
    registerByoClient: vi.fn(),
    completeByoOAuth: vi.fn(),
    buildByoAuthorizeUrl: vi.fn(),
  };
});

import {
  startByoOAuthConnect,
  finishByoOAuthConnect,
  type ByoOAuthConnectDeps,
} from './byo-oauth-connect.js';
import {
  discoverByoAuthServer,
  registerByoClient,
  completeByoOAuth,
  buildByoAuthorizeUrl,
  ByoOAuthError,
} from './byo-oauth.js';

const META = {
  issuer: 'https://as.example.com',
  authorizationEndpoint: 'https://as.example.com/authorize',
  tokenEndpoint: 'https://as.example.com/token',
  registrationEndpoint: 'https://as.example.com/register',
  scopesSupported: ['mcp.read'],
  codeChallengeMethodsSupported: ['S256'],
};

function makeDeps(overrides: Partial<ByoOAuthConnectDeps> = {}): ByoOAuthConnectDeps & {
  service: { get: ReturnType<typeof vi.fn>; setOAuthTokens: ReturnType<typeof vi.fn> };
  stateStore: { create: ReturnType<typeof vi.fn>; consume: ReturnType<typeof vi.fn> };
} {
  const service = { get: vi.fn(), setOAuthTokens: vi.fn().mockResolvedValue(true) };
  const stateStore = { create: vi.fn().mockResolvedValue(undefined), consume: vi.fn() };
  return {
    service,
    stateStore,
    redirectUri: 'https://gw.example.com/connect/byo/oauth/callback',
    newStateToken: () => 'state-token-1',
    newCodeVerifier: () => 'verifier-1',
    ...overrides,
  } as never;
}

describe('startByoOAuthConnect', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('discovers, registers a client, persists state (with client_secret), and returns the authorize URL', async () => {
    const deps = makeDeps();
    deps.service.get.mockResolvedValue({ id: 'srv-1', endpointUrl: 'https://byo.example.com/mcp', headers: {} });
    vi.mocked(discoverByoAuthServer).mockResolvedValue(META);
    vi.mocked(registerByoClient).mockResolvedValue({ clientId: 'dyn-client', clientSecret: 'dyn-secret' });
    vi.mocked(buildByoAuthorizeUrl).mockReturnValue('https://as.example.com/authorize?x=1');

    const url = await startByoOAuthConnect(deps, 'user-a', 'srv-1');

    expect(url).toBe('https://as.example.com/authorize?x=1');
    expect(discoverByoAuthServer).toHaveBeenCalledWith('https://byo.example.com/mcp');
    expect(registerByoClient).toHaveBeenCalledWith(META, deps.redirectUri);
    expect(deps.stateStore.create).toHaveBeenCalledWith({
      stateToken: 'state-token-1',
      userId: 'user-a',
      byoServerId: 'srv-1',
      clientId: 'dyn-client',
      codeVerifier: 'verifier-1',
      clientSecret: 'dyn-secret',
    });
    // PKCE: the verifier persisted == the verifier used to build the URL.
    expect(buildByoAuthorizeUrl).toHaveBeenCalledWith(META, {
      clientId: 'dyn-client',
      redirectUri: deps.redirectUri,
      state: 'state-token-1',
      codeVerifier: 'verifier-1',
      scopes: ['mcp.read'],
    });
  });

  it('throws (and persists nothing) when the BYO server is not found / not owned', async () => {
    const deps = makeDeps();
    deps.service.get.mockResolvedValue(null);
    await expect(startByoOAuthConnect(deps, 'user-a', 'srv-x')).rejects.toBeInstanceOf(ByoOAuthError);
    expect(discoverByoAuthServer).not.toHaveBeenCalled();
    expect(deps.stateStore.create).not.toHaveBeenCalled();
  });
});

describe('finishByoOAuthConnect', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('consumes the state, exchanges the code, and persists the tokens onto the server', async () => {
    const deps = makeDeps();
    deps.stateStore.consume.mockResolvedValue({
      userId: 'user-a',
      byoServerId: 'srv-1',
      clientId: 'dyn-client',
      codeVerifier: 'verifier-1',
      clientSecret: 'dyn-secret',
    });
    deps.service.get.mockResolvedValue({ id: 'srv-1', endpointUrl: 'https://byo.example.com/mcp', headers: {} });
    vi.mocked(completeByoOAuth).mockResolvedValue({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresIn: 3600,
      raw: {},
    });

    const res = await finishByoOAuthConnect(deps, { code: 'auth-code', state: 'state-token-1', iss: 'https://as.example.com' });

    expect(res).toEqual({ byoServerId: 'srv-1' });
    expect(deps.stateStore.consume).toHaveBeenCalledWith('state-token-1');
    // The consumed verifier + client + the callback iss flow into the exchange.
    expect(completeByoOAuth).toHaveBeenCalledWith({
      endpointUrl: 'https://byo.example.com/mcp',
      code: 'auth-code',
      codeVerifier: 'verifier-1',
      clientId: 'dyn-client',
      clientSecret: 'dyn-secret',
      redirectUri: deps.redirectUri,
      iss: 'https://as.example.com',
    });
    expect(deps.service.setOAuthTokens).toHaveBeenCalledTimes(1);
    const [uid, sid, tokens] = deps.service.setOAuthTokens.mock.calls[0];
    expect(uid).toBe('user-a');
    expect(sid).toBe('srv-1');
    expect(tokens.accessToken).toBe('AT-1');
    expect(tokens.refreshToken).toBe('RT-1');
    expect(typeof tokens.expiresAt).toBe('string');
  });

  it('throws on an unknown/expired state and never exchanges', async () => {
    const deps = makeDeps();
    deps.stateStore.consume.mockResolvedValue(null);
    await expect(
      finishByoOAuthConnect(deps, { code: 'c', state: 'bad', iss: undefined }),
    ).rejects.toBeInstanceOf(ByoOAuthError);
    expect(completeByoOAuth).not.toHaveBeenCalled();
    expect(deps.service.setOAuthTokens).not.toHaveBeenCalled();
  });

  it('throws when the server was deleted mid-flow (consume ok, get null) and never persists tokens', async () => {
    const deps = makeDeps();
    deps.stateStore.consume.mockResolvedValue({ userId: 'user-a', byoServerId: 'srv-1', clientId: 'c', codeVerifier: 'v' });
    deps.service.get.mockResolvedValue(null);
    await expect(
      finishByoOAuthConnect(deps, { code: 'c', state: 's', iss: undefined }),
    ).rejects.toBeInstanceOf(ByoOAuthError);
    expect(completeByoOAuth).not.toHaveBeenCalled();
    expect(deps.service.setOAuthTokens).not.toHaveBeenCalled();
  });
});
