/**
 * Request-context Fastify plugin — RLS request-path enforcement.
 *
 * Wraps every non-exempt HTTP request in a request-path DB context: a reserved
 * NOBYPASSRLS connection inside a transaction, with `conduit.current_user_id`
 * set to the server-verified session user. Every getSql() call made anywhere
 * in the request's async chain — across all hooks and the route handler —
 * resolves to that transaction, so RLS policies enforce.
 *
 * Why a plugin and not runInRequestContext(): the Fastify request lifecycle
 * spans separate async entry points (onRequest hook, handler, onResponse hook)
 * and cannot be wrapped in a single callback. The plugin opens the context in
 * onRequest and closes it in onResponse — see src/db/context.ts for the
 * openRequestContext()/closeRequestContext() lifecycle pair.
 *
 * Settle paths (closeRequestContext is idempotent via its settle-once guard,
 * so these may overlap without double-committing):
 *   - onResponse  — the primary path. COMMIT on a <500 response, ROLLBACK on
 *                   5xx (a server error must not persist a partial write).
 *   - onError     — a thrown handler error. ROLLBACK. onResponse still runs
 *                   afterwards and no-ops via the guard.
 *   - onTimeout   — the request timed out. ROLLBACK.
 *   - raw 'close' — backstop for a client disconnect that kills the socket
 *                   before onResponse runs. ROLLBACK. On a normal request the
 *                   socket also closes after the response; the guard makes
 *                   that late close a no-op.
 *
 * Exempt routes get NO context (request.rlsContext stays null):
 *   - /health, /health/* — liveness/readiness probes MUST stay green even if
 *     the request pool is unavailable; opening a context would couple probe
 *     success to pool health and mask, or be masked by, a pool outage.
 *   - /api/webhooks/stripe — no user session; runs system-path explicitly via
 *     runAsSystem(), and needs its own raw-body content-type parser.
 *   - GET /v1/mcp and GET /v1/<vendor>/mcp — persistent SSE heartbeat streams
 *     that stay open for the life of an mcp-remote client. The GET handler
 *     does only JWT validation, no DB work. A request context would reserve
 *     one request-pool connection + hold an open transaction for the entire
 *     stream, so N concurrent SSE clients pin N connections — at pool max the
 *     next client hangs, and idle-in-transaction sessions bloat vacuum. POST
 *     to those same paths is the JSON-RPC call path and is NOT exempt — it
 *     does real per-request DB work and needs the context. Hence the
 *     exemption is method-aware.
 *
 * If openRequestContext() throws (request pool down), the onRequest hook
 * throws and the request fails with a 500. That is deliberate fail-loud: a
 * non-exempt request must never proceed without RLS enforcement.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  openRequestContext,
  closeRequestContext,
  RequestPoolBusyError,
  type RequestContextHandle,
} from './context.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The open request-path context, or null for an exempt route. */
    rlsContext: RequestContextHandle | null;
  }
}

/** Path prefixes exempt for any method. See the docblock. */
const EXEMPT_PREFIXES = ['/health', '/api/webhooks/stripe'];

/**
 * True when `path` is a persistent MCP SSE stream endpoint: the unified
 * `/v1/mcp` or the per-vendor `/v1/<vendor>/mcp`. Exempt for GET only — a GET
 * is the long-lived heartbeat stream (no DB work); a POST is the JSON-RPC call
 * path and keeps its request context.
 */
function isMcpSseStream(path: string): boolean {
  return path === '/v1/mcp' || /^\/v1\/[^/]+\/mcp$/.test(path);
}

/**
 * True when a request runs WITHOUT a request-path RLS context. Method-aware:
 * the /v1 MCP endpoints are exempt only for GET (SSE streams), never for POST.
 * Matches an exact prefix or a path under it (`/health` and `/health/vendors`,
 * but NOT `/healthz`). Exported for unit test — both the prefix-boundary check
 * and the GET-only MCP rule are easy to get subtly wrong.
 */
export function isExempt(method: string, url: string): boolean {
  const path = url.split('?')[0];
  if (EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return true;
  return method === 'GET' && isMcpSseStream(path);
}

/**
 * Register the request-context lifecycle on `app`. Must be registered AFTER
 * the auth plugin: the onRequest hook below reads `request.auth0User`, which
 * the auth plugin's own (earlier-registered) onRequest hook populates.
 */
export const requestContextPlugin = () =>
  fp(async function plugin(app: FastifyInstance): Promise<void> {
    app.decorateRequest('rlsContext', null);

    app.addHook('onRequest', async (request, reply) => {
      if (isExempt(request.method, request.url)) return;

      // users.id === the session `sub` (auth0.ts inserts users with id = sub).
      // '' for an unauthenticated request — RLS predicates then match no
      // user-scoped rows, the correct posture for a request with no user.
      const userId = request.auth0User?.sub ?? '';

      // The raw-socket-close handler MUST be registered BEFORE awaiting
      // openRequestContext. Otherwise, a client disconnect during the
      // reserve() acquire window leaves the eventual reserved connection with
      // no release path (onResponse never fires because the response never
      // completes). Two phases the closure handles:
      //   - close BEFORE openRequestContext resolves: set `abortedEarly`; the
      //     post-await check immediately rolls back + releases.
      //   - close AFTER openRequestContext resolves: rollback now; the
      //     settle-once guard in closeRequestContext makes the eventual
      //     onResponse close of a normal request a no-op.
      let handle: RequestContextHandle | null = null;
      let abortedEarly = false;
      const onClose = (): void => {
        if (handle) {
          void closeRequestContext(handle, 'rollback');
        } else {
          abortedEarly = true;
        }
      };
      request.raw.on('close', onClose);

      try {
        handle = await openRequestContext(userId);
      } catch (err) {
        // Failed acquire: no handle is owed a close, but the listener we
        // registered above must come off or it lives for the life of the raw
        // socket. RequestPoolBusyError maps to HTTP 503 — fail loud on pool
        // exhaustion rather than letting it surface as a generic 500.
        request.raw.off('close', onClose);
        if (err instanceof RequestPoolBusyError) {
          // Static message — do NOT echo err.message into the response body.
          // The RequestPoolBusyError constructor accepts an argument, so a
          // future call site that passed user data (a vendor slug, a tenant
          // id, a path) would leak it via 503. Mapping a fixed string here
          // makes the no-info-leak property STRUCTURAL, not by-convention.
          return reply.code(503).send({
            error: 'request_pool_busy',
            message: 'Request pool exhausted; please retry shortly.',
          });
        }
        throw err;
      }

      request.rlsContext = handle;

      if (abortedEarly) {
        // The client gave up while we were acquiring. Release immediately so
        // the slot is reusable; onResponse will not run on this request.
        void closeRequestContext(handle, 'rollback');
      }
    });

    app.addHook('onResponse', async (request, reply) => {
      const handle = request.rlsContext;
      if (!handle) return;
      const outcome = reply.statusCode >= 500 ? 'rollback' : 'commit';
      try {
        await closeRequestContext(handle, outcome);
      } catch (err) {
        // The response is already sent; a failed COMMIT cannot be surfaced to
        // the client. Log loudly — a persistent failure here means writes are
        // silently lost. The connection is released regardless (finally in
        // closeRequestContext).
        request.log.error({ err }, 'request-context: settle failed in onResponse');
      }
    });

    app.addHook('onError', async (request) => {
      const handle = request.rlsContext;
      if (handle) await closeRequestContext(handle, 'rollback');
    });

    app.addHook('onTimeout', async (request) => {
      const handle = request.rlsContext;
      if (handle) await closeRequestContext(handle, 'rollback');
    });
  });
