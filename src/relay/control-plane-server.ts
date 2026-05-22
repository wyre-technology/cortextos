/**
 * Relay control-plane HTTP server — the in-cluster endpoint the multi-instance
 * cloud gateway calls to invoke the relay's `sendRequest(tunnelId, target,
 * payload)` primitive over a tunnel held by THIS relay instance.
 *
 * PR #2 scope-doc §4 steps 1 + 3 (locked green from boss + analyst + warden).
 *
 * Deployment shape:
 *   - The control-plane endpoint MUST be served on an internal-only ACA ingress
 *     (deploy-time CI falsifier + boot-time `assertInternalIngress` form the
 *     two-layer falsifier pair — see scope §3 decision (ii)).
 *   - Authentication: HMAC-SHA256 with body-binding + nonce-replay defense
 *     (`control-plane-auth.ts`). The HMAC secret is shared between gateway and
 *     relay via ACA secret reference (`CONTROL_PLANE_SECRET` env var).
 *   - This Fastify instance runs IN THE SAME PROCESS as `RelayServer` (the
 *     WSS terminator) so the handler can call `relay.sendRequest` directly —
 *     no inter-process hop, no extra latency, no extra connection state.
 *
 * Request lifecycle (POST /internal/relay/route):
 *   1. HMAC verify (control-plane-auth.verifyRequest) — discriminated result
 *      maps to per-failure HTTP status (401 malformed / 401 timestamp_skew /
 *      401 bad_signature / 401 replay). Same generic error body for all four
 *      so the client cannot distinguish; the operator audit log captures the
 *      precise reason (warden's operator-only-audit pin lands in §4 step 8).
 *   2. Validate request body shape: {subtenantId, target, payload}.
 *   3. Look up the live tunnel for `subtenantId` (registry SELECT — system-
 *      path; the request-path RLS policy lands in §4 step 6, this code-path
 *      runs BYPASSRLS as the relay's system identity).
 *   4. Capability gate: target must be in tunnel.capabilities (sendRequest
 *      already checks this, but we surface the failure with the (iv) failure-
 *      semantics mapping rather than a generic 500).
 *   5. relay.sendRequest(tunnel.id, target, payload) → resolves to the
 *      response frame OR rejects with timeout / disconnect.
 *   6. Map per (iv) table to HTTP response.
 *
 * Failure-semantics mapping (scope §3 decision (iv) + §4 step 8):
 *   tunnel not found            → 404  tunnel_offline
 *   relay.sendRequest timeout    → 504  tunnel_timeout
 *   tunnel disconnected mid-call → 502  tunnel_disconnected
 *   capability not granted       → 403  capability_not_granted
 *   HMAC verify fails            → 401  unauthorized (generic)
 *   request body malformed       → 400  malformed
 *
 * The HTTP response body for ALL failures is the same generic shape;
 * the precise reason goes to operator audit only.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  verifyRequest as verifyHmac,
  type VerifyResult,
} from './control-plane-auth.js';
import { findLiveTunnel } from './tunnel-registry.js';
import type { RelayServer } from './relay-server.js';

/** Path the gateway POSTs to. */
export const ROUTE_PATH = '/internal/relay/route';
/** Internal-ingress port the relay listens on for control-plane traffic. */
const DEFAULT_PORT = 8081;
/** Cap matches the WSS frame cap (scope §3 decision (iii)). */
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
/** Backpressure threshold (scope §3 decision (iii)) — relay returns 503 above. */
const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;

export interface ControlPlaneServerOptions {
  /** RelayServer instance whose tunnels this control-plane routes against. */
  relay: RelayServer;
  /** The shared HMAC secret. Required; refuses to start if absent/empty. */
  secret: string;
  port?: number;
  bodyLimitBytes?: number;
  maxConcurrentRequests?: number;
}

/** Discriminated body for the gateway's POST. */
interface ControlPlaneRoutePayload {
  subtenantId: string;
  target: string;
  payload: unknown;
}

/**
 * The single client-visible error shape — generic across all failure reasons
 * so the client cannot distinguish (warden's no-info-leak principle).
 * The PRECISE reason is logged to the operator-facing audit channel (§4 step 8).
 */
interface ClientErrorBody {
  error: string;
}

/**
 * Operator-facing structured error event, NOT shipped in the HTTP body —
 * emitted to the relay's stderr log / future admin_audit_log destination.
 * Conservative-client + diagnostic-rich-server (analyst + warden pin).
 */
interface OperatorErrorEvent {
  kind: 'control_plane_error';
  reason:
    | 'malformed_body'
    | 'hmac_malformed'
    | 'hmac_timestamp_skew'
    | 'hmac_bad_signature'
    | 'hmac_replay'
    | 'tunnel_offline'
    | 'tunnel_timeout'
    | 'tunnel_disconnected'
    | 'capability_not_granted'
    | 'overloaded';
  subtenantId?: string;
  target?: string;
}

function logOperator(event: OperatorErrorEvent): void {
  // Step 8 will replace this with an admin_audit_log writer; for now stderr
  // is the operator-facing channel and is NOT shipped to clients.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ...event, ts: new Date().toISOString() }));
}

function clientError(message: string): ClientErrorBody {
  return { error: message };
}

export class ControlPlaneServer {
  private readonly app: FastifyInstance;
  private readonly opts: Required<ControlPlaneServerOptions>;
  private inFlight = 0;

  constructor(options: ControlPlaneServerOptions) {
    if (!options.secret || options.secret.length === 0) {
      throw new Error(
        'CONTROL_PLANE_SECRET is required — the relay refuses to start without an HMAC secret.',
      );
    }
    this.opts = {
      port: options.port ?? DEFAULT_PORT,
      bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
      maxConcurrentRequests: options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
      relay: options.relay,
      secret: options.secret,
    };

    this.app = Fastify({
      bodyLimit: this.opts.bodyLimitBytes,
      // The relay is internal; disable trust-proxy and rely on the ACA-internal
      // ingress + HMAC for auth. No remote IP semantics needed here.
    });

    // HMAC must verify over the EXACT bytes the gateway signed — re-serializing
    // the parsed JSON would reorder keys / change whitespace and break the
    // signature. Custom parser stashes the raw body on the request before
    // JSON.parse, so the route handler can pass it to verifyHmac unchanged.
    this.app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as { rawBody?: string }).rawBody = body as string;
        try {
          done(null, body.length === 0 ? {} : JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    this.app.post(ROUTE_PATH, (request, reply) => this.handleRoute(request, reply));
  }

  async start(): Promise<void> {
    await this.app.listen({ host: '0.0.0.0', port: this.opts.port });
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  /** Test helper — the address Fastify is bound to. */
  address(): { port: number } | null {
    const addr = this.app.server.address();
    return addr && typeof addr === 'object' ? { port: addr.port } : null;
  }

  private async handleRoute(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): Promise<void> {
    // Backpressure: refuse new requests when the in-flight ceiling is hit.
    if (this.inFlight >= this.opts.maxConcurrentRequests) {
      logOperator({ kind: 'control_plane_error', reason: 'overloaded' });
      reply.code(503).header('Retry-After', '1').send(clientError('overloaded'));
      return;
    }
    this.inFlight += 1;
    try {
      await this.routeImpl(request, reply);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async routeImpl(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): Promise<void> {
    // The raw body bytes the HMAC was computed over — stashed by the
    // custom application/json content-type parser registered in the
    // constructor, since re-serializing the parsed JSON would reorder keys
    // and break the signature.
    const rawBody = (request as { rawBody?: string }).rawBody ?? '';

    // HMAC verify FIRST — every other failure shape leaks more than the
    // generic 'unauthorized' for an unauthenticated request would.
    const hmacResult: VerifyResult = verifyHmac({
      secret: this.opts.secret,
      method: 'POST',
      path: ROUTE_PATH,
      body: rawBody,
      headers: {
        [HEADER_TIMESTAMP]: request.headers[HEADER_TIMESTAMP] as string | undefined,
        [HEADER_NONCE]: request.headers[HEADER_NONCE] as string | undefined,
        [HEADER_SIGNATURE]: request.headers[HEADER_SIGNATURE] as string | undefined,
      },
    });
    if (!hmacResult.ok) {
      // Map HMAC failure to operator-precise reason; client-visible 401 is
      // generic across all four HMAC failure shapes.
      const opReason: OperatorErrorEvent['reason'] =
        hmacResult.reason === 'malformed'
          ? 'hmac_malformed'
          : hmacResult.reason === 'timestamp_skew'
            ? 'hmac_timestamp_skew'
            : hmacResult.reason === 'bad_signature'
              ? 'hmac_bad_signature'
              : 'hmac_replay';
      logOperator({ kind: 'control_plane_error', reason: opReason });
      reply.code(401).send(clientError('unauthorized'));
      return;
    }

    // Body shape validation.
    const body = request.body as Partial<ControlPlaneRoutePayload> | undefined;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.subtenantId !== 'string' ||
      body.subtenantId.length === 0 ||
      typeof body.target !== 'string' ||
      body.target.length === 0 ||
      !('payload' in body)
    ) {
      logOperator({ kind: 'control_plane_error', reason: 'malformed_body' });
      reply.code(400).send(clientError('malformed_body'));
      return;
    }
    const { subtenantId, target, payload } = body as ControlPlaneRoutePayload;

    // Find the live tunnel for this subtenant.
    const tunnel = await findLiveTunnel(subtenantId);
    if (!tunnel) {
      logOperator({ kind: 'control_plane_error', reason: 'tunnel_offline', subtenantId, target });
      reply.code(404).send(clientError('tunnel_offline'));
      return;
    }

    // Capability gate is enforced by relay.sendRequest itself, but we map
    // the rejection to the precise (iv) failure-semantics code BEFORE
    // bubbling. sendRequest's rejection messages are deterministic strings;
    // we match them to the typed reasons rather than re-checking
    // tunnel.capabilities here (single source of truth in RelayServer).
    if (!this.opts.relay.holdsTunnel(tunnel.id)) {
      // Registry says the tunnel is online but THIS relay instance does not
      // hold its socket — multi-relay coordination is out of scope for PR #2
      // (single-relay assumed). Fail closed with the same external shape as
      // tunnel-offline; the operator log distinguishes.
      logOperator({
        kind: 'control_plane_error',
        reason: 'tunnel_offline',
        subtenantId,
        target,
      });
      reply.code(404).send(clientError('tunnel_offline'));
      return;
    }

    try {
      const response = await this.opts.relay.sendRequest(tunnel.id, target, payload);
      reply.code(200).send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not granted target')) {
        logOperator({
          kind: 'control_plane_error',
          reason: 'capability_not_granted',
          subtenantId,
          target,
        });
        reply.code(403).send(clientError('capability_not_granted'));
        return;
      }
      if (message.includes('timed out')) {
        logOperator({
          kind: 'control_plane_error',
          reason: 'tunnel_timeout',
          subtenantId,
          target,
        });
        reply.code(504).send(clientError('tunnel_timeout'));
        return;
      }
      // 'tunnel disconnected during registration' / 'tunnel disconnected' /
      // 'tunnel not held by this relay instance' (the last is structurally
      // already handled above).
      logOperator({
        kind: 'control_plane_error',
        reason: 'tunnel_disconnected',
        subtenantId,
        target,
      });
      reply.code(502).send(clientError('tunnel_disconnected'));
    }
  }
}

/**
 * Convenience: read the HMAC secret from env, fail loud if missing. The
 * relay boot sequence calls this alongside `assertInternalIngress`. Treats
 * the secret as required (not a default) — same posture as MASTER_KEY.
 */
export function requireControlPlaneSecret(): string {
  const value = process.env.CONTROL_PLANE_SECRET;
  if (!value || value.length === 0) {
    throw new Error(
      'CONTROL_PLANE_SECRET env var is required — the relay refuses to start ' +
        'without an HMAC secret for the gateway↔relay control-plane endpoint.',
    );
  }
  return value;
}
