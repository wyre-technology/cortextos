/**
 * On-prem tunnel WSS frame protocol.
 *
 * Shared by both ends of the tunnel:
 *   - the relay tier (WYRE cloud) — terminates the WSS, routes frames;
 *   - the on-prem gateway's WSS client shim — dials out, reads/writes frames.
 *
 * M1 scope doc decision (iv) — boss + analyst pre-ack green: frames are JSON
 * with a correlation-id envelope, request/response multiplexed over the one
 * socket. JSON keeps M1 debuggable and matches the MCP `/v1/mcp` shape the
 * gateway already speaks; binary framing is a premature optimization for a
 * skeleton.
 *
 * One socket carries many concurrent in-flight requests. Every request frame
 * carries a `correlationId`; the matching response frame echoes it. This is
 * standard request/response multiplexing — the connector doc §5 routing model.
 */

/** Frame type discriminator. */
export type FrameType =
  /** on-prem gateway → relay, once on connect: present identity, bind subtenant. */
  | 'register'
  /** relay → on-prem gateway: registration accepted. */
  | 'register_ack'
  /** relay → on-prem gateway: registration rejected (bad/Revoked identity). */
  | 'register_nack'
  /** on-prem gateway → relay, periodic: liveness. */
  | 'heartbeat'
  /** relay → on-prem gateway: a request to execute against an on-prem MCP server. */
  | 'request'
  /** on-prem gateway → relay: the result of a `request`, echoes its correlationId. */
  | 'response';

/** Base envelope — every frame has a type; request/response frames add a correlationId. */
export interface BaseFrame {
  type: FrameType;
  /**
   * Protocol version. M1 = 1. Bumping is how the relay and a fleet of
   * already-deployed on-prem gateways negotiate forward-compatibly.
   */
  v: 1;
}

/**
 * `register` — first frame the on-prem gateway sends after the WSS opens.
 * M1 (decision (iii)): identity is a signed enrollment token. M2 (Gate A):
 * mTLS supersedes the token before any real MCP server or credential flows.
 */
export interface RegisterFrame extends BaseFrame {
  type: 'register';
  /** Per-tunnel signed enrollment token (M1). Bound to one subtenant. */
  enrollmentToken: string;
  /** Capabilities this tunnel offers. M1: ['echo']. */
  capabilities: string[];
}

export interface RegisterAckFrame extends BaseFrame {
  type: 'register_ack';
  /** The tunnel id the relay assigned / resolved for this connection. */
  tunnelId: string;
}

export interface RegisterNackFrame extends BaseFrame {
  type: 'register_nack';
  /** Generic reason — MUST NOT leak token/credential detail. */
  reason: 'invalid_identity' | 'revoked_identity' | 'malformed';
}

export interface HeartbeatFrame extends BaseFrame {
  type: 'heartbeat';
}

/**
 * `request` — relay → on-prem gateway. Carries a correlation id; the on-prem
 * gateway echoes it on the matching `response`. `payload` is JSON-RPC-shaped
 * (the MCP `/v1/mcp` request body) so the on-prem gateway can hand it to its
 * MCP-server layer unchanged.
 *
 * M1: the payload is routed to a trivial echo MCP server.
 */
export interface RequestFrame extends BaseFrame {
  type: 'request';
  correlationId: string;
  /** Vendor/MCP-server slug the request targets on-prem. M1: 'echo'. */
  target: string;
  /** JSON-RPC-shaped MCP request body. */
  payload: unknown;
}

/**
 * `response` — on-prem gateway → relay. Echoes the `request`'s correlationId.
 * `payload` is the JSON-RPC-shaped MCP response, or `error` is set on failure.
 */
export interface ResponseFrame extends BaseFrame {
  type: 'response';
  correlationId: string;
  payload?: unknown;
  error?: { code: number; message: string };
}

export type TunnelFrame =
  | RegisterFrame
  | RegisterAckFrame
  | RegisterNackFrame
  | HeartbeatFrame
  | RequestFrame
  | ResponseFrame;

const FRAME_TYPES: ReadonlySet<string> = new Set<FrameType>([
  'register',
  'register_ack',
  'register_nack',
  'heartbeat',
  'request',
  'response',
]);

/**
 * Parse + validate a raw WSS message into a TunnelFrame. Returns null on
 * anything malformed — the caller treats a null as a protocol violation
 * (drop the frame; for `register` specifically, respond register_nack).
 *
 * Validation is deliberately strict: an on-prem tunnel is a trust boundary,
 * and a frame that does not parse cleanly is never executed.
 */
export function parseFrame(raw: string): TunnelFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const f = obj as Record<string, unknown>;
  if (typeof f.type !== 'string' || !FRAME_TYPES.has(f.type)) return null;
  if (f.v !== 1) return null;

  switch (f.type) {
    case 'register':
      if (typeof f.enrollmentToken !== 'string' || f.enrollmentToken.length === 0) return null;
      if (!Array.isArray(f.capabilities) || !f.capabilities.every((c) => typeof c === 'string')) return null;
      return obj as RegisterFrame;
    case 'register_ack':
      if (typeof f.tunnelId !== 'string' || f.tunnelId.length === 0) return null;
      return obj as RegisterAckFrame;
    case 'register_nack':
      if (f.reason !== 'invalid_identity' && f.reason !== 'revoked_identity' && f.reason !== 'malformed') return null;
      return obj as RegisterNackFrame;
    case 'heartbeat':
      return obj as HeartbeatFrame;
    case 'request':
      if (typeof f.correlationId !== 'string' || f.correlationId.length === 0) return null;
      if (typeof f.target !== 'string' || f.target.length === 0) return null;
      if (!('payload' in f)) return null;
      return obj as RequestFrame;
    case 'response':
      if (typeof f.correlationId !== 'string' || f.correlationId.length === 0) return null;
      if (!('payload' in f) && !('error' in f)) return null;
      return obj as ResponseFrame;
    default:
      return null;
  }
}

/** Serialize a frame for the wire. */
export function serializeFrame(frame: TunnelFrame): string {
  return JSON.stringify(frame);
}
