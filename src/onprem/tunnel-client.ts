/**
 * On-prem gateway → WYRE relay: the WSS dial-out client shim.
 *
 * M1 scope doc build-step 2. The stripped on-prem gateway runs this client.
 * It is the gateway's ONLY network ingress — there is no LAN-listening port
 * (enforced by no-inbound-assert.ts). The client:
 *   - dials ONE persistent outbound WSS to the WYRE relay (TLS, 443);
 *   - verifies the relay's server certificate (mutual auth, connector-doc §6a:
 *     a connector lured into dialing an attacker endpoint hands it the
 *     request/result stream — so the relay's identity is verified);
 *   - registers with its per-tunnel enrollment token;
 *   - sends heartbeats; receives `request` frames, routes them to a local
 *     handler (M1: a trivial echo MCP server), returns `response` frames;
 *   - reconnects with backoff on socket drop.
 *
 * mTLS (the connector presenting a client cert) is the hard M2 gate (Gate A).
 * M1 presents a signed enrollment token; the relay-cert verification below is
 * the M1 half of mutual auth (the connector→relay direction). M2 adds the
 * client-cert half.
 */
import { WebSocket } from 'ws';
import {
  parseFrame,
  serializeFrame,
  type RequestFrame,
} from '../relay/frame-protocol.js';

/** A local handler for an inbound request frame — M1 wires this to the echo server. */
export type RequestHandler = (target: string, payload: unknown) => Promise<unknown>;

export interface TunnelClientOptions {
  /** The WYRE relay WSS URL, e.g. wss://relay.wyre.ai. MUST be wss:// (TLS). */
  relayUrl: string;
  /** Per-tunnel signed enrollment token (M1 identity). */
  enrollmentToken: string;
  /** Capabilities this on-prem gateway offers. M1: ['echo']. */
  capabilities: string[];
  /** Handler for inbound request frames. */
  onRequest: RequestHandler;
  /**
   * Optional sha256 fingerprint of the relay's server certificate. When set,
   * the client pins to exactly this cert (stricter than CA validation alone)
   * — connector-doc §6a. When unset, standard CA validation applies.
   */
  relayCertFingerprintSha256?: string;
  /** Heartbeat interval. Default 30s. */
  heartbeatMs?: number;
  /** Reconnect backoff ceiling. Default 30s. */
  maxBackoffMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * Production deployment policy: the on-prem gateway's relay URL MUST be wss://
 * — TLS is not optional, the WSS carries its own security (connector-doc §2).
 *
 * This is a boot-time assert, NOT a TunnelClient constructor coupling — the
 * same shape as no-inbound-assert.ts. The on-prem gateway boot sequence calls
 * assertNoInbound() + assertSecureRelayUrl() before dialing. Deployment policy
 * belongs in a loud boot assertion; the transport class itself stays
 * scheme-agnostic so the integration suite can exercise the frame protocol
 * over a plain in-process non-TLS WS socket without a TLS-in-test rabbit hole.
 */
export function assertSecureRelayUrl(relayUrl: string): void {
  if (!relayUrl.startsWith('wss://')) {
    throw new Error(
      `INSECURE RELAY URL — the on-prem gateway relay URL must be wss:// ` +
        `(TLS). Got: ${relayUrl.split('://')[0]}://… . Refusing to boot.`,
    );
  }
}

export class TunnelClient {
  private readonly opts: Required<Omit<TunnelClientOptions, 'relayCertFingerprintSha256'>> &
    Pick<TunnelClientOptions, 'relayCertFingerprintSha256'>;
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = BASE_BACKOFF_MS;
  private stopped = false;
  private tunnelId: string | null = null;

  constructor(opts: TunnelClientOptions) {
    this.opts = {
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      ...opts,
    };
  }

  /** Dial the relay and keep the tunnel up, reconnecting on drop, until stop(). */
  start(): void {
    this.stopped = false;
    this.dial();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  /** The tunnel id the relay assigned, once registered. Null until register_ack. */
  currentTunnelId(): string | null {
    return this.tunnelId;
  }

  private dial(): void {
    if (this.stopped) return;

    const socket = new WebSocket(this.opts.relayUrl, {
      // Relay server-cert verification — the connector→relay half of mutual
      // auth. CA validation is on by default (rejectUnauthorized); when a
      // pinned fingerprint is supplied, also require an exact match.
      rejectUnauthorized: true,
    });
    this.socket = socket;

    socket.on('open', () => {
      if (this.opts.relayCertFingerprintSha256) {
        // Defense-in-depth beyond CA validation: pin the exact relay cert.
        const cert = (socket as unknown as { _socket?: { getPeerCertificate?: () => { fingerprint256?: string } } })
          ._socket?.getPeerCertificate?.();
        const got = cert?.fingerprint256?.replace(/:/g, '').toLowerCase();
        const want = this.opts.relayCertFingerprintSha256.replace(/:/g, '').toLowerCase();
        if (got !== want) {
          // Wrong relay cert — refuse to proceed; do NOT send the token.
          socket.close();
          return;
        }
      }
      // Register: present the enrollment token.
      socket.send(
        serializeFrame({
          type: 'register',
          v: 1,
          enrollmentToken: this.opts.enrollmentToken,
          capabilities: this.opts.capabilities,
        }),
      );
    });

    socket.on('message', (data) => {
      void this.onMessage(socket, data.toString());
    });

    socket.on('close', () => {
      this.onClose();
    });

    socket.on('error', () => {
      // ws emits 'error' then 'close'; reconnect is driven by the close handler.
    });
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame) {
      // Unparseable frame from the relay — drop the socket, reconnect.
      socket.close();
      return;
    }

    switch (frame.type) {
      case 'register_ack':
        this.tunnelId = frame.tunnelId;
        this.backoffMs = BASE_BACKOFF_MS; // a clean registration resets backoff.
        this.startHeartbeat(socket);
        break;

      case 'register_nack':
        // The relay rejected our identity — reconnecting will not help until
        // the operator fixes the token. Stop dialing; surface loudly.
        this.stopped = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        socket.close();
        break;

      case 'request': {
        await this.handleRequest(socket, frame);
        break;
      }

      // heartbeat / register / response arriving FROM the relay are protocol
      // violations — the relay only legitimately sends register_ack/nack +
      // request. Ignore.
      default:
        break;
    }
  }

  private async handleRequest(socket: WebSocket, frame: RequestFrame): Promise<void> {
    try {
      const payload = await this.opts.onRequest(frame.target, frame.payload);
      socket.send(
        serializeFrame({ type: 'response', v: 1, correlationId: frame.correlationId, payload }),
      );
    } catch (err) {
      socket.send(
        serializeFrame({
          type: 'response',
          v: 1,
          correlationId: frame.correlationId,
          error: { code: -32000, message: err instanceof Error ? err.message : 'on-prem handler error' },
        }),
      );
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serializeFrame({ type: 'heartbeat', v: 1 }));
      }
    }, this.opts.heartbeatMs);
  }

  private onClose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.tunnelId = null;
    this.socket = null;
    if (this.stopped) return;

    // Reconnect with exponential backoff, capped.
    this.reconnectTimer = setTimeout(() => this.dial(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
  }
}
