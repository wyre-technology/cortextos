/**
 * Cloud-gateway → relay control-plane HTTP client.
 *
 * PR #2 scope-doc §4 step 4. The cloud gateway uses this client to invoke the
 * relay's `sendRequest(tunnelId, target, payload)` primitive over the
 * internal-only HTTP control-plane endpoint (`POST /internal/relay/route`).
 *
 * Wire shape (matches `src/relay/control-plane-server.ts`):
 *   - POST body: `{subtenantId, target, payload}` (JSON).
 *   - Auth: HMAC-SHA256 over `canonical(method + path + timestamp + sha256(body))`,
 *     three headers (`X-Relay-Control-Timestamp` + `-Nonce` + `-Signature`).
 *   - Body bytes are signed BEFORE this client touches them — the signer
 *     produces the exact bytes the verifier will see (body-binding fidelity).
 *   - Responses: 200 `{type:'response', payload, ...}` or one of the typed
 *     error shapes from scope §3 decision (iv) — this client maps them to a
 *     discriminated `RouteResult` so callers can branch without parsing
 *     error strings.
 *
 * Deployment-time policy (scope §3 decision (ii)) — boot-time:
 *   - The gateway boot must hold `CONTROL_PLANE_RELAY_URL` (the internal ACA
 *     URL of the relay's HTTP port) + `CONTROL_PLANE_SECRET` (the shared
 *     HMAC secret matching the relay's). `requireControlPlaneConfig()`
 *     refuses to construct the client without both.
 */
import { nanoid } from 'nanoid';
import { signRequest, HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE } from '../relay/control-plane-auth.js';

export const ROUTE_PATH = '/internal/relay/route';

/** Wire shape of a successful relay response — same shape `RelayServer.sendRequest` resolves with. */
interface RelayResponseFrame {
  type: 'response';
  v: 1;
  correlationId: string;
  payload?: unknown;
  error?: { code: number; message: string };
}

export type RouteResult =
  | { ok: true; response: RelayResponseFrame }
  | { ok: false; reason: 'tunnel_offline' }
  | { ok: false; reason: 'tunnel_timeout' }
  | { ok: false; reason: 'tunnel_disconnected' }
  | { ok: false; reason: 'capability_not_granted' }
  | { ok: false; reason: 'unauthorized' }
  | { ok: false; reason: 'malformed_body' }
  | { ok: false; reason: 'overloaded' }
  | { ok: false; reason: 'control_plane_unreachable'; detail: string }
  | { ok: false; reason: 'unknown_error'; status: number };

export interface RelayControlPlaneClientOptions {
  /** Internal ACA URL of the relay's control-plane HTTP port. Required. */
  relayUrl: string;
  /** Shared HMAC secret matching the relay's. Required, non-empty. */
  secret: string;
  /** Per-request timeout. Default 30s (matches relay-side `requestTimeoutMs`). */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Convenience: read the gateway-side control-plane config from env, fail loud
 * if either is missing. The gateway boot sequence calls this; absent config
 * means "the on-prem path is not configured" and the unified-router treats
 * `/v1/mcp` for an on-prem capability the same as an unknown vendor.
 */
export function readControlPlaneConfigFromEnv(): { relayUrl: string | null; secret: string | null } {
  const relayUrl = process.env.CONTROL_PLANE_RELAY_URL ?? null;
  const secret = process.env.CONTROL_PLANE_SECRET ?? null;
  return {
    relayUrl: relayUrl && relayUrl.length > 0 ? relayUrl : null,
    secret: secret && secret.length > 0 ? secret : null,
  };
}

/**
 * Three-state boot disposition for the gateway-side on-prem relay client.
 *
 * - `wired` — both `CONTROL_PLANE_RELAY_URL` and `CONTROL_PLANE_SECRET` are
 *   set and non-empty. The gateway constructs `RelayControlPlaneClient` and
 *   passes it to `unifiedProxyRoutes`; `/v1/mcp` calls for on-prem-routed
 *   vendors flow through the relay.
 * - `unconfigured` — both env vars are absent or empty. The gateway boots
 *   without the relay client (dev/test friendly; `unifiedProxyRoutes` runs
 *   with `relayControlPlane: null` and the unified-router short-circuits
 *   on-prem-routed vendors to the same arm-b path as an unknown vendor).
 * - `ambiguous` — exactly ONE of the two is set without the other. This is
 *   a misconfig (typo, half-rotation, partial KV provision); the gateway
 *   refuses to boot LOUD rather than guess which mode the operator
 *   intended. The named-actionable-choice is "set BOTH or set NEITHER."
 */
export type ControlPlaneBootDisposition =
  | { kind: 'wired'; relayUrl: string; secret: string }
  | { kind: 'unconfigured' }
  | { kind: 'ambiguous'; reason: string };

/**
 * Classify the gateway's on-prem relay config into the three boot
 * dispositions. Pure function over env-state; the gateway boot path calls
 * this and acts on the kind.
 */
export function classifyControlPlaneBoot(): ControlPlaneBootDisposition {
  const { relayUrl, secret } = readControlPlaneConfigFromEnv();
  if (relayUrl && secret) return { kind: 'wired', relayUrl, secret };
  if (!relayUrl && !secret) return { kind: 'unconfigured' };
  return {
    kind: 'ambiguous',
    reason:
      relayUrl
        ? 'CONTROL_PLANE_RELAY_URL is set but CONTROL_PLANE_SECRET is not. ' +
          'Set BOTH (to wire the on-prem relay path) or set NEITHER (to run ' +
          'the gateway without the on-prem path).'
        : 'CONTROL_PLANE_SECRET is set but CONTROL_PLANE_RELAY_URL is not. ' +
          'Set BOTH (to wire the on-prem relay path) or set NEITHER (to run ' +
          'the gateway without the on-prem path).',
  };
}

/**
 * Convenience: read the HMAC secret from env, fail loud if missing.
 *
 * Parity with `src/relay/control-plane-server.ts:requireControlPlaneSecret()`.
 * The relay side ALWAYS requires the secret (the relay is the on-prem path);
 * the gateway side requires it ONLY when `classifyControlPlaneBoot()` resolves
 * to `wired` or `ambiguous` (an unconfigured gateway is a legitimate state).
 *
 * Callers that always want the secret (relay-side parity) use this directly;
 * the gateway boot path uses `classifyControlPlaneBoot()` instead so the
 * `unconfigured` state stays a soft-skip.
 */
export function requireControlPlaneSecret(): string {
  const value = process.env.CONTROL_PLANE_SECRET;
  if (!value || value.length === 0) {
    throw new Error(
      'CONTROL_PLANE_SECRET env var is required — refusing to operate ' +
        'without an HMAC secret for the gateway↔relay control-plane endpoint.',
    );
  }
  return value;
}

export class RelayControlPlaneClient {
  private readonly relayUrl: string;
  private readonly secret: string;
  private readonly requestTimeoutMs: number;

  constructor(opts: RelayControlPlaneClientOptions) {
    if (!opts.relayUrl || opts.relayUrl.length === 0) {
      throw new Error('relayUrl required to construct RelayControlPlaneClient');
    }
    if (!opts.secret || opts.secret.length === 0) {
      throw new Error('secret required to construct RelayControlPlaneClient');
    }
    // Strip trailing slash so we can concatenate ROUTE_PATH cleanly.
    this.relayUrl = opts.relayUrl.replace(/\/$/, '');
    this.secret = opts.secret;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Route an on-prem-vendor MCP request through the relay. Returns the
   * relay's typed response frame on success, or a discriminated failure
   * reason that the unified-router maps to a JSON-RPC error per scope
   * §3 decision (iv).
   *
   * `subtenantId` is the org id of the requesting user (the cloud-gateway
   * resolves this from the authenticated `/v1/mcp` request context).
   */
  async route(params: { subtenantId: string; target: string; payload: unknown }): Promise<RouteResult> {
    // Body is signed BEFORE we touch it — the signer + verifier both see
    // EXACTLY this string. The relay's custom content-type parser
    // explicitly preserves the raw bytes so body-binding holds end-to-end.
    const bodyStr = JSON.stringify({
      subtenantId: params.subtenantId,
      target: params.target,
      payload: params.payload,
    });
    const headers = signRequest({
      secret: this.secret,
      method: 'POST',
      path: ROUTE_PATH,
      body: bodyStr,
      nonce: nanoid(),
    });

    let response: Response;
    try {
      response = await fetch(`${this.relayUrl}${ROUTE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
          [HEADER_NONCE]: headers[HEADER_NONCE],
          [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        },
        body: bodyStr,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      // Connection refused / DNS failure / TLS error / per-request timeout
      // at the HTTP layer (NOT the relay's response timeout — that's 504).
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'control_plane_unreachable', detail };
    }

    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as RelayResponseFrame | null;
      if (!body || body.type !== 'response') {
        return { ok: false, reason: 'unknown_error', status: 200 };
      }
      return { ok: true, response: body };
    }

    // Map the relay's typed error codes per scope §3 decision (iv).
    const errBody = (await response.json().catch(() => null)) as { error?: string } | null;
    const code = errBody?.error;
    switch (response.status) {
      case 401:
        return { ok: false, reason: 'unauthorized' };
      case 400:
        return { ok: false, reason: 'malformed_body' };
      case 403:
        return { ok: false, reason: 'capability_not_granted' };
      case 404:
        return { ok: false, reason: 'tunnel_offline' };
      case 502:
        return { ok: false, reason: 'tunnel_disconnected' };
      case 503:
        return { ok: false, reason: 'overloaded' };
      case 504:
        return { ok: false, reason: 'tunnel_timeout' };
      default:
        return {
          ok: false,
          reason: 'unknown_error',
          status: response.status,
        };
    }
    // `code` is intentionally read but unused at the client surface — the
    // status code is the authoritative discriminator; the body's `error`
    // string is for operator logs / future telemetry.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void code;
  }
}
