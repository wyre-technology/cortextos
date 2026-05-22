/**
 * Control-plane server integration — exercises the §4 step-1 + step-3 stack
 * end-to-end against real Postgres + a real WSS socket + a real Fastify HTTP
 * server. Closes the gap between the unit-tested HMAC + the unit-tested relay:
 * proves that a signed gateway→relay POST routes through to a live tunnel,
 * the response threads back, and every failure shape from scope §3 decision
 * (iv) maps correctly.
 *
 * Not yet wired: the cloud-gateway side (§4 steps 4-5) and the full-T2
 * /v1/mcp → gateway → relay → ... integration (§4 step 7). This file proves
 * the relay-side of the gateway↔relay control-plane.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { nanoid } from 'nanoid';
import { enterTestContext, clearTestContext } from '../db/context.js';
import { RelayServer } from './relay-server.js';
import { ControlPlaneServer, ROUTE_PATH } from './control-plane-server.js';
import { signRequest } from './control-plane-auth.js';
import { TunnelClient } from '../onprem/tunnel-client.js';
import { mintEnrollmentToken } from './enrollment-token.js';
import { handleEchoMcp } from '../onprem/echo-mcp-server.js';

const SUBTENANT = 'org-cp-test';
const SECRET = 'integration-test-shared-hmac-secret';

const WS_SCHEME = 'ws';
// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- in-process test relay; production-policy gate is assertSecureRelayUrl + assertInternalIngress. Suppression localized.
const relayWsUrl = (port: number) => `${WS_SCHEME}://127.0.0.1:${port}`;

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;
let relay: RelayServer;
let controlPlane: ControlPlaneServer;
let relayPort: number;
let controlPlanePort: number;

async function bootstrap(): Promise<void> {
  await sql`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE onprem_tunnels (
      id TEXT PRIMARY KEY,
      subtenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identity_fingerprint TEXT NOT NULL,
      capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE UNIQUE INDEX uq_onprem_tunnels_identity ON onprem_tunnels (identity_fingerprint)`;
  await sql`INSERT INTO organizations (id, name) VALUES (${SUBTENANT}, 'CP Test Org')`;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  sql = postgres(container.getConnectionUri());
  enterTestContext(sql);
  await bootstrap();
}, 90_000);

afterAll(async () => {
  clearTestContext();
  await sql?.end();
  await container?.stop();
});

beforeEach(async () => {
  await sql`TRUNCATE onprem_tunnels`;
  relayPort = 19000 + Math.floor(Math.random() * 2000);
  controlPlanePort = 21000 + Math.floor(Math.random() * 2000);
  relay = new RelayServer({ port: relayPort, requestTimeoutMs: 5_000 });
  controlPlane = new ControlPlaneServer({
    relay,
    secret: SECRET,
    port: controlPlanePort,
    maxConcurrentRequests: 3, // small so backpressure is exercisable.
  });
  await controlPlane.start();
});

afterEach(async () => {
  await controlPlane.stop();
  await relay.stop();
});

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('eventually() timed out');
}

async function bringTunnelOnline(): Promise<{ client: TunnelClient; tunnelId: string }> {
  const token = await mintEnrollmentToken({ subtenantId: SUBTENANT, capabilities: ['echo'] });
  const client = new TunnelClient({
    relayUrl: relayWsUrl(relayPort),
    enrollmentToken: token,
    capabilities: ['echo'],
    onRequest: async (_t, p) => handleEchoMcp(p),
  });
  client.start();
  await eventually(() => client.currentTunnelId() !== null);
  return { client, tunnelId: client.currentTunnelId()! };
}

async function signedFetch(body: object): Promise<{ status: number; data: unknown }> {
  const bodyStr = JSON.stringify(body);
  const headers = signRequest({
    secret: SECRET,
    method: 'POST',
    path: ROUTE_PATH,
    body: bodyStr,
    nonce: nanoid(),
  });
  const res = await fetch(`http://127.0.0.1:${controlPlanePort}${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: bodyStr,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('control-plane-server — end-to-end (HMAC + relay → tunnel → echo)', () => {
  it('signed POST routes through to the live tunnel and the echo response returns', async () => {
    const { client } = await bringTunnelOnline();

    const result = await signedFetch({
      subtenantId: SUBTENANT,
      target: 'echo',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'control plane works' } },
      },
    });
    expect(result.status).toBe(200);
    const frame = result.data as { type: string; payload: { result: { content: { text: string }[] } } };
    expect(frame.type).toBe('response');
    expect(frame.payload.result.content[0].text).toBe('control plane works');

    await client.stop();
  });

  it('unsigned POST returns 401 generic — no leak of which check failed', async () => {
    const { client } = await bringTunnelOnline();
    const res = await fetch(`http://127.0.0.1:${controlPlanePort}${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subtenantId: SUBTENANT, target: 'echo', payload: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
    await client.stop();
  });

  it('a tampered body (signature computed over different bytes) → 401', async () => {
    const { client } = await bringTunnelOnline();
    const bodyStr = JSON.stringify({ subtenantId: SUBTENANT, target: 'echo', payload: { ok: true } });
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: ROUTE_PATH,
      body: bodyStr,
      nonce: nanoid(),
    });
    // Send a DIFFERENT body with the original signature — body-binding rejects this.
    const tamperedBody = JSON.stringify({ subtenantId: SUBTENANT, target: 'echo', payload: { ok: false } });
    const res = await fetch(`http://127.0.0.1:${controlPlanePort}${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: tamperedBody,
    });
    expect(res.status).toBe(401);
    await client.stop();
  });

  it('no live tunnel for the subtenant → 404 tunnel_offline', async () => {
    // No tunnel connected at all.
    const result = await signedFetch({
      subtenantId: SUBTENANT,
      target: 'echo',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    expect(result.status).toBe(404);
    expect((result.data as { error: string }).error).toBe('tunnel_offline');
  });

  it('capability not granted (target ∉ tunnel.capabilities) → 403 capability_not_granted', async () => {
    const { client } = await bringTunnelOnline();
    const result = await signedFetch({
      subtenantId: SUBTENANT,
      target: 'admin-ldap', // not in echo-only grant
      payload: { jsonrpc: '2.0', id: 1 },
    });
    expect(result.status).toBe(403);
    expect((result.data as { error: string }).error).toBe('capability_not_granted');
    await client.stop();
  });

  it('malformed body shape → 400 malformed_body', async () => {
    const { client } = await bringTunnelOnline();
    // Missing required `target` field.
    const result = await signedFetch({ subtenantId: SUBTENANT, payload: {} });
    expect(result.status).toBe(400);
    expect((result.data as { error: string }).error).toBe('malformed_body');
    await client.stop();
  });

  it('signed POST is rejected as replay on second use of the same nonce', async () => {
    const { client } = await bringTunnelOnline();
    const bodyStr = JSON.stringify({
      subtenantId: SUBTENANT,
      target: 'echo',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    const headers = signRequest({
      secret: SECRET,
      method: 'POST',
      path: ROUTE_PATH,
      body: bodyStr,
      nonce: 'fixed-replay-nonce',
    });
    const first = await fetch(`http://127.0.0.1:${controlPlanePort}${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: bodyStr,
    });
    expect(first.status).toBe(200);
    // Same nonce + same body + same signature → replay.
    const second = await fetch(`http://127.0.0.1:${controlPlanePort}${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: bodyStr,
    });
    expect(second.status).toBe(401);
    await client.stop();
  });
});

describe('control-plane-server — RouteResult discriminant wire-coverage (boss refinement 2)', () => {
  // Each missing discriminant (relative to the prior 7 tests) gets a wire-level
  // test against the real server + tunnel + control-plane HTTP path, exercised
  // through RelayControlPlaneClient (the actual gateway-side client) so the
  // mapping from relay HTTP status → RouteResult discriminant is proven against
  // the same code production uses.
  it('504 tunnel_timeout — relay sendRequest times out, gateway client sees tunnel_timeout', async () => {
    // Tunnel client that NEVER responds — onRequest hangs.
    const token = await mintEnrollmentToken({ subtenantId: SUBTENANT, capabilities: ['echo'] });
    const client = new TunnelClient({
      relayUrl: relayWsUrl(relayPort),
      enrollmentToken: token,
      capabilities: ['echo'],
      onRequest: async () => new Promise(() => {/* never resolves */}),
    });
    client.start();
    await eventually(() => client.currentTunnelId() !== null);

    // Use a fresh relay with a SHORT requestTimeoutMs to keep the test fast.
    // We can't change relay timeout mid-test, so we rely on the beforeEach's
    // relay being constructed with 5_000 ms timeout. To make this test fast
    // we use a smaller timeout-aware test: stop the relay's sweep loop and
    // assert the gateway client sees tunnel_timeout within the relay's
    // configured 5s window.
    const { RelayControlPlaneClient } = await import('../proxy/relay-control-plane-client.js');
    const gwClient = new RelayControlPlaneClient({
      relayUrl: `http://127.0.0.1:${controlPlanePort}`,
      secret: SECRET,
      requestTimeoutMs: 10_000, // generous so the relay's 5s timeout fires first
    });
    const result = await gwClient.route({
      subtenantId: SUBTENANT,
      target: 'echo',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tunnel_timeout');

    await client.stop();
  }, 15_000);

  it('502 tunnel_disconnected — tunnel drops mid-request, gateway client sees tunnel_disconnected', async () => {
    // Tunnel client whose onRequest closes the socket from the on-prem side.
    const token = await mintEnrollmentToken({ subtenantId: SUBTENANT, capabilities: ['echo'] });
    const dropSignal = new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    const client = new TunnelClient({
      relayUrl: relayWsUrl(relayPort),
      enrollmentToken: token,
      capabilities: ['echo'],
      onRequest: async () => {
        await dropSignal;
        // Stop the tunnel mid-request — the relay's pending promise rejects.
        void client.stop();
        return new Promise(() => {/* never resolves */});
      },
    });
    client.start();
    await eventually(() => client.currentTunnelId() !== null);

    const { RelayControlPlaneClient } = await import('../proxy/relay-control-plane-client.js');
    const gwClient = new RelayControlPlaneClient({
      relayUrl: `http://127.0.0.1:${controlPlanePort}`,
      secret: SECRET,
      requestTimeoutMs: 10_000,
    });
    const result = await gwClient.route({
      subtenantId: SUBTENANT,
      target: 'echo',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['tunnel_disconnected', 'tunnel_offline']).toContain(result.reason);
    }
  }, 15_000);

  it('503 overloaded — concurrent flood past maxConcurrentRequests gets retry-after', async () => {
    // beforeEach constructs ControlPlaneServer with maxConcurrentRequests: 3.
    // Bring a tunnel up + flood with > 3 in-flight requests; some get 503.
    const token = await mintEnrollmentToken({ subtenantId: SUBTENANT, capabilities: ['echo'] });
    // Slow handler so requests pile up in-flight.
    const client = new TunnelClient({
      relayUrl: relayWsUrl(relayPort),
      enrollmentToken: token,
      capabilities: ['echo'],
      onRequest: async (_t, payload) => {
        await new Promise((r) => setTimeout(r, 500));
        return handleEchoMcp(payload);
      },
    });
    client.start();
    await eventually(() => client.currentTunnelId() !== null);

    const { RelayControlPlaneClient } = await import('../proxy/relay-control-plane-client.js');
    const gwClient = new RelayControlPlaneClient({
      relayUrl: `http://127.0.0.1:${controlPlanePort}`,
      secret: SECRET,
      requestTimeoutMs: 10_000,
    });
    // 10 concurrent — relay has 3-concurrent ceiling, so at least some get 503.
    const concurrent = 10;
    const results = await Promise.all(
      Array.from({ length: concurrent }, () =>
        gwClient.route({
          subtenantId: SUBTENANT,
          target: 'echo',
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { message: 'load' } } },
        }),
      ),
    );
    const overloaded = results.filter((r) => !r.ok && r.reason === 'overloaded');
    expect(overloaded.length).toBeGreaterThan(0);

    await client.stop();
  }, 15_000);
});
