/**
 * No-inbound build invariant — the load-bearing security property of the
 * on-prem gateway.
 *
 * M1 scope doc §2 (Preserved) + forge scope §3 (KEPT) + boss pre-ack 2026-05-20:
 * the on-prem gateway binds NO LAN-listening port. Its only ingress is the
 * outbound-dialed WSS tunnel. This is what neutralizes the "self-hosted
 * gateway has a listening ingress" concern — and boss confirmed it as a HARD
 * BUILD INVARIANT, not a default a future change can quietly erode.
 *
 * This module is that enforcement. `assertNoInbound()` is called once at
 * on-prem-gateway boot, BEFORE the tunnel client dials. If anything in the
 * process has opened a listening TCP/IP socket, it throws and the gateway
 * refuses to boot — a loud abort, never silent corruption.
 *
 * Why a runtime boot assert and not just code review: a listening port can
 * be introduced indirectly — a transitively-added dependency that starts a
 * health server, a debug endpoint, a metrics exporter. Code review catches
 * what is in the diff; this assert catches what is in the *process*. The
 * invariant is enforced against runtime reality, not against intent.
 */
import type { Server } from 'node:net';

/**
 * Inspect the process for active listening sockets. Node does not expose a
 * global socket registry, so the on-prem gateway must REGISTER any server it
 * deliberately creates here — and M1's gateway deliberately creates none.
 * Any `net`/`http` server the build (or a dependency) starts without
 * registering is, by construction, an unaccounted listener.
 *
 * The registry is the allowlist. M1's allowlist is empty: the on-prem gateway
 * has zero legitimate listeners. If M2 ever needs one (it should not — the
 * tunnel is the only ingress by design), it is added here consciously and
 * re-reviewed, never slipped in.
 */
const ALLOWED_LISTENERS = new Set<Server>();

/**
 * Register a deliberately-created listener as allowed. M1 calls this zero
 * times. Exists so that IF a future milestone has a defensible listener, the
 * exception is explicit and greppable — not an erosion of the assert.
 */
export function registerAllowedListener(server: Server, justification: string): void {
  if (!justification || justification.length < 10) {
    throw new Error('registerAllowedListener requires a substantive justification');
  }
  ALLOWED_LISTENERS.add(server);
}

export interface NoInboundResult {
  ok: boolean;
  /** Listeners found that were not registered as allowed. */
  unaccountedListeners: { address: string }[];
}

/**
 * Scan for unaccounted listening sockets. Pure-ish: takes the set of active
 * handles so it is testable without standing up real servers.
 *
 * `activeHandles` is `process._getActiveHandles()` in production — an
 * internal API, hence injected so tests pass synthetic handles.
 */
export function checkNoInbound(activeHandles: unknown[]): NoInboundResult {
  const unaccounted: { address: string }[] = [];
  for (const handle of activeHandles) {
    if (!isListeningServer(handle)) continue;
    if (ALLOWED_LISTENERS.has(handle as Server)) continue;
    const addr = (handle as Server).address();
    unaccounted.push({
      address: typeof addr === 'string' ? addr : addr ? `${addr.address}:${addr.port}` : 'unknown',
    });
  }
  return { ok: unaccounted.length === 0, unaccountedListeners: unaccounted };
}

/** A handle is a listening server if it exposes `.address()` and `.listening === true`. */
function isListeningServer(handle: unknown): handle is Server {
  if (typeof handle !== 'object' || handle === null) return false;
  const h = handle as Record<string, unknown>;
  return h.listening === true && typeof h.address === 'function';
}

/**
 * Boot-time assertion. Call once at on-prem-gateway startup, before dialing
 * the tunnel. Throws — refusing to boot — if any unaccounted listener exists.
 * A loud abort is the correct failure: a silently-listening on-prem gateway
 * is precisely the attack surface the no-inbound invariant exists to deny.
 *
 * KNOWN LIMITATION — single-shot boot snapshot. This assert catches listeners
 * present AT BOOT. A transitively-imported dependency that lazily starts a
 * health server / debug endpoint AFTER boot is not caught by this snapshot.
 * M2 hardening options (carried as a line item, not addressed in M1): (a)
 * periodic re-check on a short interval, or (b) wrap `node:net`
 * `Server.prototype.listen` / `node:http` `createServer` to register-or-throw
 * at listener-creation time (catches at-source, not by polling). M1 ships the
 * boot snapshot because boot-time is the load-bearing window for the M1
 * scope; M2's wider attack surface (real MCP server present) warrants
 * tightening to listener-creation-time enforcement.
 */
export function assertNoInbound(): void {
  // process._getActiveHandles is internal Node API — stable today but not
  // part of the public contract. If a future Node version renames/removes
  // it, we MUST refuse to boot rather than silently fail-open on a load-
  // bearing security invariant (boss-diff 2026-05-21). Same loud-abort
  // posture as the listener-detected branch below.
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getHandles !== 'function') {
    throw new Error(
      `NO-INBOUND INVARIANT CANNOT BE ENFORCED — process._getActiveHandles ` +
        `is not available in this Node runtime. The on-prem gateway refuses ` +
        `to boot rather than fail-open on a load-bearing security invariant.`,
    );
  }
  const handles = getHandles.call(process);
  const result = checkNoInbound(handles);
  if (!result.ok) {
    const list = result.unaccountedListeners.map((l) => l.address).join(', ');
    throw new Error(
      `NO-INBOUND INVARIANT VIOLATED — the on-prem gateway has unaccounted ` +
        `listening socket(s): [${list}]. The on-prem gateway binds NO LAN port; ` +
        `the dialed WSS tunnel is its only ingress. Refusing to boot.`,
    );
  }
}
