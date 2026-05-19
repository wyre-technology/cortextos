import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isExempt, requestContextPlugin } from './request-context-plugin.js';
import { RequestPoolBusyError } from './context.js';

// vi.mock isolates the pool-backed openRequestContext / closeRequestContext
// behind in-process spies so the plugin can be exercised without a real
// Postgres. Two plugin-level regression guards below: (a) a client disconnect
// during the reserve() acquire window must still release the late-arriving
// handle (close-listener-ordering fix), and (b) a RequestPoolBusyError from
// openRequestContext must surface as HTTP 503, not a hang or 500.
vi.mock('./context.js', async (importActual) => {
  const actual = await importActual<typeof import('./context.js')>();
  return {
    ...actual,
    openRequestContext: vi.fn(),
    closeRequestContext: vi.fn().mockResolvedValue(undefined),
  };
});
const ctx = await import('./context.js');

describe('isExempt — request-context exemption matcher', () => {
  it('matches an exact exempt prefix, any method', () => {
    expect(isExempt('GET', '/health')).toBe(true);
    expect(isExempt('POST', '/api/webhooks/stripe')).toBe(true);
  });

  it('matches a path nested under an exempt prefix', () => {
    expect(isExempt('GET', '/health/vendors')).toBe(true);
  });

  it('ignores the query string when matching', () => {
    expect(isExempt('GET', '/health?probe=1')).toBe(true);
  });

  it('does NOT match a path that merely shares the prefix as a substring', () => {
    // The boundary bug: /healthz must not be exempted by the /health prefix.
    expect(isExempt('GET', '/healthz')).toBe(false);
    expect(isExempt('GET', '/health-internal')).toBe(false);
  });

  it('does not exempt a normal request-path route', () => {
    expect(isExempt('GET', '/api/orgs')).toBe(false);
    expect(isExempt('GET', '/settings')).toBe(false);
  });

  // The MCP SSE exemption is method-aware: a GET is a persistent heartbeat
  // stream (no DB work) and must NOT pin a request-pool connection; a POST is
  // the JSON-RPC call path and legitimately needs the request context.
  it('exempts GET on the unified MCP endpoint (SSE stream)', () => {
    expect(isExempt('GET', '/v1/mcp')).toBe(true);
  });

  it('exempts GET on the per-vendor MCP endpoint (SSE stream)', () => {
    expect(isExempt('GET', '/v1/autotask/mcp')).toBe(true);
    expect(isExempt('GET', '/v1/datto-rmm/mcp')).toBe(true);
  });

  it('does NOT exempt POST on the MCP endpoints — JSON-RPC needs the context', () => {
    expect(isExempt('POST', '/v1/mcp')).toBe(false);
    expect(isExempt('POST', '/v1/autotask/mcp')).toBe(false);
  });

  it('does not exempt non-MCP /v1 paths or deeper MCP sub-paths', () => {
    expect(isExempt('GET', '/v1/autotask/tools')).toBe(false);
    expect(isExempt('GET', '/v1/autotask/mcp/extra')).toBe(false);
    expect(isExempt('GET', '/v1')).toBe(false);
  });
});

describe('requestContextPlugin — onRequest lifecycle', () => {
  let app: FastifyInstance;
  let capturedRequest: FastifyRequest | null;

  beforeEach(async () => {
    vi.mocked(ctx.openRequestContext).mockReset();
    vi.mocked(ctx.closeRequestContext).mockReset().mockResolvedValue(undefined);

    app = Fastify({ logger: false });
    capturedRequest = null;
    // Capture hook registered BEFORE the plugin so it runs first and we have
    // a handle on the request — including its raw socket — while the plugin's
    // own onRequest is later awaiting openRequestContext.
    app.addHook('onRequest', async (request) => {
      capturedRequest = request;
    });
    await app.register(requestContextPlugin());
    app.post('/api/echo', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('releases the late-arriving handle when the client disconnects during reserve()', async () => {
    // openRequestContext is stuck — emulating a slow reserve() acquire.
    let resolveOpen!: (h: unknown) => void;
    const fakeHandle = { reserved: {}, settled: false };
    vi.mocked(ctx.openRequestContext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = (h) => resolve(h as never);
        }),
    );

    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/echo',
      payload: {},
    });

    // Wait one tick so the plugin's onRequest hook starts and registers its
    // raw.on('close') listener, then synthesize the client disconnect while
    // openRequestContext is STILL pending.
    await new Promise((r) => setImmediate(r));
    expect(capturedRequest).not.toBeNull();
    capturedRequest!.raw.emit('close');

    // The client has gone. Now resolve openRequestContext with the handle —
    // the post-await check must see `abortedEarly` and release immediately.
    resolveOpen(fakeHandle);

    // light-my-request's raw is a synthetic stream — emitting 'close' does
    // NOT make Fastify abort, so the handler still runs and onResponse also
    // calls closeRequestContext('commit'). In production the settle-once
    // guard in closeRequestContext makes that second call a no-op; here the
    // mock records both calls, so we pin the regression on the FIRST call —
    // the abortedEarly-triggered rollback.
    await responsePromise.catch(() => undefined);

    expect(ctx.closeRequestContext).toHaveBeenNthCalledWith(1, fakeHandle, 'rollback');
  });

  it('returns HTTP 503 when openRequestContext rejects with RequestPoolBusyError', async () => {
    vi.mocked(ctx.openRequestContext).mockRejectedValueOnce(new RequestPoolBusyError());

    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('request_pool_busy');
    // No handle was acquired -> no close owed.
    expect(ctx.closeRequestContext).not.toHaveBeenCalled();
  });
});
