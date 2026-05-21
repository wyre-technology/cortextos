/**
 * Relay tier — the WYRE-cloud WSS terminator for on-prem tunnels.
 *
 * M1 scope doc decision (ii): the relay is a new dedicated component (it ships
 * as its own Azure Container App). It owns the WSS sockets so the multi-
 * instance cloud gateway stays stateless w.r.t. tunnels (connector-doc §5).
 *
 * Responsibilities (M1, build-step 1):
 *   - Terminate the WSS each on-prem gateway dials out to.
 *   - On connect: require a `register` frame, verify its enrollment token,
 *     bind the tunnel to its subtenant in the registry, hold the live socket.
 *   - Heartbeats → registry `last_seen`; socket drop → registry `offline`.
 *   - Request/response correlation: send a request frame down a tunnel and
 *     resolve when the matching response frame (same correlationId) returns.
 *     This is the primitive the cloud-gateway routing (build-step 4) calls.
 *
 * The live WebSocket handles live in an in-memory map keyed by tunnelId — a
 * socket is not serializable, so it cannot live in the registry table. The
 * table is the durable record of which tunnels exist + liveness; this map is
 * the process-local set of sockets currently held by THIS relay instance.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import {
  parseFrame,
  serializeFrame,
  type TunnelFrame,
  type RequestFrame,
} from './frame-protocol.js';
import { verifyEnrollmentToken } from './enrollment-token.js';
import {
  registerTunnel,
  recordHeartbeat,
  markOffline,
  sweepStaleTunnels,
} from './tunnel-registry.js';

/** A registered, live tunnel held by this relay instance. */
interface LiveTunnel {
  tunnelId: string;
  subtenantId: string;
  /**
   * The tunnel's granted capabilities — the SAME set the enrollment token
   * authoritatively granted, captured at registration. sendRequest checks
   * the target against this set so a registered tunnel cannot be SENT
   * requests for capabilities it was not granted (analyst 2026-05-21
   * structural pin: register-time grant-subset is enforced via
   * requestedBeyondGrant in handleRegister; this is the send-time half).
   */
  capabilities: ReadonlySet<string>;
  socket: WebSocket;
  /** correlationId → resolver for an in-flight request awaiting its response. */
  pending: Map<string, PendingRequest>;
}

interface PendingRequest {
  resolve: (frame: TunnelFrame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Connection lifecycle states for the pre-registration TOCTOU fix (warden
 * 2026-05-21 must-fix). A socket lives on a strict state machine from open
 * to closed; the registerDeadline + the async handleRegister coordinate
 * through `state`, so a deadline that fires mid-handshake can't leave a
 * tunnel half-registered (the .then sees state==='closed' and cleans up).
 *
 *   waiting     — socket open, no register frame received yet
 *   registering — register frame received, handleRegister in-flight
 *   registered  — handleRegister succeeded; tunnel held + live
 *   closed      — socket dropped (deadline, error, intentional, register failure)
 */
type ConnState = 'waiting' | 'registering' | 'registered' | 'closed';

export interface RelayServerOptions {
  /** Port the WSS listens on. */
  port: number;
  /** Heartbeat staleness window — a tunnel silent longer than this is swept offline. */
  staleMs?: number;
  /** Per-request timeout for the send-and-await primitive. */
  requestTimeoutMs?: number;
}

const DEFAULT_STALE_MS = 90_000; // 3× a 30s heartbeat.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const REGISTER_DEADLINE_MS = 10_000; // a socket must `register` within this or it is dropped.
/**
 * WSS frame size cap (analyst fold 2026-05-21, share-style hardening). ws's
 * default maxPayload is 100 MB — far beyond a legit MCP envelope. Cap to
 * 1 MB so a malicious tunnel cannot ship gigabyte frames before parseFrame
 * even sees them; legit MCP payloads are well below this.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;

export class RelayServer {
  private readonly wss: WebSocketServer;
  private readonly tunnels = new Map<string, LiveTunnel>();
  private readonly staleMs: number;
  private readonly requestTimeoutMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(opts: RelayServerOptions) {
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.wss = new WebSocketServer({ port: opts.port, maxPayload: DEFAULT_MAX_PAYLOAD_BYTES });
    this.wss.on('connection', (socket) => this.onConnection(socket));
  }

  /** Start the periodic stale-tunnel sweep (safety net beneath socket-drop detection). */
  start(): void {
    this.sweepTimer = setInterval(() => {
      void sweepStaleTunnels(this.staleMs);
    }, Math.floor(this.staleMs / 2));
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.tunnels.values()) t.socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** Tunnels currently held live by this relay instance. */
  liveTunnelCount(): number {
    return this.tunnels.size;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    // A freshly-dialed socket is UNTRUSTED until it sends a valid `register`.
    // It gets REGISTER_DEADLINE_MS to do so, then it is dropped — an
    // unregistered socket can never receive a request frame.
    //
    // The state machine (warden 2026-05-21 must-fix) closes a TOCTOU race
    // between the registerDeadline and the async handleRegister: if the
    // deadline fires while handleRegister is in-flight, state goes to
    // 'closed' before the .then resolves; the .then then sees state ===
    // 'closed' and cleans up the just-registered tunnel rather than leaking
    // it (DB markOffline, tunnels-map delete, pending-timer clear). Also
    // closes the back-to-back-register race: a second register frame arriving
    // before the first completes finds state !== 'waiting' and drops the
    // socket rather than spawning a parallel handleRegister.
    let state: ConnState = 'waiting';
    let registered: LiveTunnel | null = null;

    const closeAndCleanup = (live: LiveTunnel | null): void => {
      if (!live) return;
      this.tunnels.delete(live.tunnelId);
      for (const pending of live.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('tunnel disconnected during registration'));
      }
      live.pending.clear();
      void markOffline(live.tunnelId);
    };

    const registerDeadline = setTimeout(() => {
      if (state === 'waiting' || state === 'registering') {
        state = 'closed';
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    }, REGISTER_DEADLINE_MS);

    socket.on('message', (data) => {
      const frame = parseFrame(data.toString());
      if (!frame) {
        // Unparseable frame on a trust boundary — drop the socket.
        socket.close();
        return;
      }

      if (state === 'registered' && registered) {
        // Registered tunnel — dispatch the frame.
        this.handleFrame(registered, frame);
        return;
      }

      if (state !== 'waiting') {
        // Concurrent / post-close register attempts: drop the socket. This
        // closes warden's "two back-to-back registers within 10s" race.
        socket.close();
        return;
      }

      // The only frame accepted in `waiting` is `register`.
      if (frame.type !== 'register') {
        socket.close();
        return;
      }

      state = 'registering';
      void this.handleRegister(socket, frame.enrollmentToken, frame.capabilities).then((live) => {
        if (state === 'closed') {
          // Deadline or socket-close raced us. handleRegister may have already
          // INSERTed the tunnel + held the socket — undo both.
          closeAndCleanup(live);
          return;
        }
        if (live) {
          state = 'registered';
          registered = live;
          clearTimeout(registerDeadline);
        } else {
          // handleRegister already sent register_nack.
          state = 'closed';
          socket.close();
        }
      });
    });

    socket.on('close', () => {
      clearTimeout(registerDeadline);
      if (state === 'registered' && registered) {
        this.onDisconnect(registered);
      }
      // If state === 'registering', the in-flight .then handles cleanup when
      // it observes state === 'closed' (set here). For 'waiting' and 'closed'
      // there is nothing to clean up.
      state = 'closed';
    });

    socket.on('error', () => {
      // ws emits 'error' then 'close'; close handler does the cleanup.
    });
  }

  private async handleRegister(
    socket: WebSocket,
    enrollmentToken: string,
    capabilities: string[],
  ): Promise<LiveTunnel | null> {
    const verdict = await verifyEnrollmentToken(enrollmentToken);
    if (!verdict.ok) {
      socket.send(serializeFrame({ type: 'register_nack', v: 1, reason: verdict.reason }));
      return null;
    }

    // The token's bound capabilities are authoritative — a tunnel cannot
    // self-declare capabilities beyond what its enrollment granted.
    const grantedCaps = verdict.claims.capabilities;
    const requestedBeyondGrant = capabilities.some((c) => !grantedCaps.includes(c));
    if (requestedBeyondGrant) {
      socket.send(serializeFrame({ type: 'register_nack', v: 1, reason: 'invalid_identity' }));
      return null;
    }

    const tunnel = await registerTunnel({
      subtenantId: verdict.claims.subtenantId,
      identityFingerprint: verdict.fingerprint,
      capabilities: grantedCaps,
    });

    const live: LiveTunnel = {
      tunnelId: tunnel.id,
      subtenantId: tunnel.subtenantId,
      capabilities: new Set(grantedCaps),
      socket,
      pending: new Map(),
    };
    this.tunnels.set(tunnel.id, live);
    socket.send(serializeFrame({ type: 'register_ack', v: 1, tunnelId: tunnel.id }));
    return live;
  }

  private handleFrame(live: LiveTunnel, frame: TunnelFrame): void {
    switch (frame.type) {
      case 'heartbeat':
        void recordHeartbeat(live.tunnelId);
        break;
      case 'response': {
        const pending = live.pending.get(frame.correlationId);
        if (pending) {
          clearTimeout(pending.timer);
          live.pending.delete(frame.correlationId);
          pending.resolve(frame);
        }
        // A response with no matching pending request is stale — drop silently.
        break;
      }
      // `register` after registration, or relay-only frame types arriving
      // from the on-prem side, are protocol violations — ignore them. The
      // on-prem gateway only legitimately sends heartbeat + response.
      default:
        break;
    }
  }

  private onDisconnect(live: LiveTunnel): void {
    this.tunnels.delete(live.tunnelId);
    for (const pending of live.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('tunnel disconnected'));
    }
    live.pending.clear();
    void markOffline(live.tunnelId);
  }

  // -------------------------------------------------------------------------
  // Request routing — the primitive cloud-gateway routing (build-step 4) calls
  // -------------------------------------------------------------------------

  /**
   * Send a request down a live tunnel and resolve with the matching response
   * frame. Rejects if the tunnel is not held by this relay instance, if the
   * tunnel disconnects mid-flight, or on per-request timeout.
   *
   * `target` is the on-prem MCP-server slug; M1 routes to a trivial echo
   * server. `payload` is the JSON-RPC-shaped MCP request body.
   */
  sendRequest(tunnelId: string, target: string, payload: unknown): Promise<TunnelFrame> {
    const live = this.tunnels.get(tunnelId);
    if (!live) {
      return Promise.reject(new Error('tunnel not held by this relay instance'));
    }
    // Send-time target-in-grant check (analyst 2026-05-21 structural pin).
    // handleRegister already refuses tunnels that self-claim caps beyond the
    // token grant; this is the parallel check at the OTHER end of the cycle —
    // the relay refuses to SEND a request for a target the tunnel was not
    // granted. M1's grant is ['echo'] so this fires for any non-echo target;
    // it becomes load-bearing in M2 when tunnels carry multiple capabilities.
    if (!live.capabilities.has(target)) {
      return Promise.reject(new Error(`tunnel ${tunnelId} is not granted target ${target}`));
    }
    const correlationId = nanoid();
    const frame: RequestFrame = { type: 'request', v: 1, correlationId, target, payload };

    return new Promise<TunnelFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(correlationId);
        reject(new Error('tunnel request timed out'));
      }, this.requestTimeoutMs);
      live.pending.set(correlationId, { resolve, reject, timer });
      live.socket.send(serializeFrame(frame));
    });
  }

  /** Is this relay instance currently holding a live socket for this tunnel? */
  holdsTunnel(tunnelId: string): boolean {
    return this.tunnels.has(tunnelId);
  }
}
