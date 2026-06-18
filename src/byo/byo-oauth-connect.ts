/**
 * BYOMCP OAuth connect orchestration (WYREAI-187 — the route increment).
 *
 * Two halves of the auth-code + PKCE flow for a user-supplied MCP server, with
 * every collaborator injected so the orchestration is unit-testable without
 * Fastify, a real Postgres, or live network:
 *
 *   start  — load the BYO server (RLS owner-scoped) → discover its authorization
 *            server → register a client (RFC 7591 DCR) → mint a PKCE verifier +
 *            state token → persist the flow state → return the authorize URL.
 *   finish — consume the flow state (single-use, owner-scoped) → re-discover the
 *            AS from the server's endpoint → validate `iss` (RFC 9207) + exchange
 *            the code → persist the tokens onto the BYO server.
 *
 * SSRF + RFC 9207 are enforced inside the byo-oauth helpers this composes
 * (discoverByoAuthServer / registerByoClient / completeByoOAuth); RLS owner
 * scoping is enforced by the injected service + state store, which both run on
 * the request-path connection under `conduit.current_user_id`.
 */
import { ByoOAuthError } from './byo-oauth.js';
import {
  discoverByoAuthServer,
  registerByoClient,
  buildByoAuthorizeUrl,
  completeByoOAuth,
} from './byo-oauth.js';
import type { ByoMcpServerWithHeaders } from './byo-mcp-service.js';
import type { CreateByoStateParams, ConsumedByoState } from './byo-oauth-state-store.js';

/** The owner-scoped store collaborators the orchestration needs. */
export interface ByoOAuthConnectDeps {
  service: {
    get(userId: string, id: string): Promise<ByoMcpServerWithHeaders | null>;
    setOAuthTokens(
      userId: string,
      id: string,
      tokens: { accessToken: string; refreshToken: string; expiresAt: string },
    ): Promise<boolean>;
  };
  stateStore: {
    create(params: CreateByoStateParams): Promise<void>;
    consume(stateToken: string): Promise<ConsumedByoState | null>;
  };
  /** The gateway's BYO OAuth callback URL ({baseUrl}/connect/byo/oauth/callback). */
  redirectUri: string;
  newStateToken: () => string;
  newCodeVerifier: () => string;
}

/**
 * Begin a BYO OAuth connect. Returns the authorization URL to redirect the
 * browser to. `userId` is the authenticated owner; RLS guarantees the server
 * load + state persist are scoped to them.
 */
export async function startByoOAuthConnect(
  deps: ByoOAuthConnectDeps,
  userId: string,
  byoServerId: string,
): Promise<string> {
  const server = await deps.service.get(userId, byoServerId);
  if (!server) {
    throw new ByoOAuthError('BYO MCP server not found');
  }

  const meta = await discoverByoAuthServer(server.endpointUrl);
  const client = await registerByoClient(meta, deps.redirectUri);

  const codeVerifier = deps.newCodeVerifier();
  const stateToken = deps.newStateToken();

  await deps.stateStore.create({
    stateToken,
    userId,
    byoServerId,
    clientId: client.clientId,
    codeVerifier,
    clientSecret: client.clientSecret,
  });

  return buildByoAuthorizeUrl(meta, {
    clientId: client.clientId,
    redirectUri: deps.redirectUri,
    state: stateToken,
    codeVerifier,
    scopes: meta.scopesSupported,
  });
}

export interface FinishByoOAuthParams {
  code: string;
  state: string;
  /** RFC 9207 `iss` from the callback query (may be undefined). */
  iss: string | undefined;
}

/**
 * Complete a BYO OAuth connect from the callback. Consumes the state, exchanges
 * the code, and persists the tokens onto the BYO server. Returns the connected
 * server's id. Throws ByoOAuthError on an unknown/expired state or a missing
 * server (e.g. deleted mid-flow).
 *
 * The consumed state's `userId` IS the authenticated caller — RLS only let the
 * caller consume their own state — so it is the canonical owner for the
 * downstream owner-scoped server load + token persist.
 */
export async function finishByoOAuthConnect(
  deps: ByoOAuthConnectDeps,
  params: FinishByoOAuthParams,
): Promise<{ byoServerId: string }> {
  const pending = await deps.stateStore.consume(params.state);
  if (!pending) {
    throw new ByoOAuthError('unknown or expired BYO OAuth state');
  }

  const server = await deps.service.get(pending.userId, pending.byoServerId);
  if (!server) {
    throw new ByoOAuthError('BYO MCP server not found (deleted mid-flow?)');
  }

  const tokens = await completeByoOAuth({
    endpointUrl: server.endpointUrl,
    code: params.code,
    codeVerifier: pending.codeVerifier,
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    redirectUri: deps.redirectUri,
    iss: params.iss,
  });

  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  await deps.service.setOAuthTokens(pending.userId, pending.byoServerId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt,
  });

  return { byoServerId: pending.byoServerId };
}
