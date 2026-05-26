/**
 * Relay container entry point.
 *
 * PR #2 §4 step 0b + boss/analyst/warden triple-convergence on α (2026-05-21):
 * the relay's boot-time security asserts MUST be CALLED, not just defined.
 * `defined-but-not-called` is the same defect class as `documented-but-not-
 * shipped` — the structural pin requires the wiring, not just the definition.
 * This entry point is the wire.
 *
 * Boot sequence — fail-loud at the FIRST guard that fails. Order is
 * deliberate: cheapest + earliest-misconfig check first, then progressively
 * heavier resources. No partial initialization on misconfig.
 *
 *   1. assertInternalIngress() — refuses boot if CONTROL_PLANE_INGRESS env
 *      var is not `internal`. Pair with the deploy-time CI bicep falsifier
 *      (assert ingress.external === false) — two falsifiers, different
 *      levels, complementary failure modes (warden scope-stage pin).
 *   2. requireControlPlaneSecret() — refuses boot if CONTROL_PLANE_SECRET
 *      env var is unset/empty. Cheap fail-loud before any TCP listen.
 *   3. RelayServer.start() — opens the WSS terminator on its public port.
 *   4. ControlPlaneServer.start() — opens the HTTP control-plane on its
 *      INTERNAL-only port (the half assertInternalIngress confirmed).
 *
 * If any of (1)/(2) throws, NOTHING binds a port — boot aborts before any
 * potentially-mis-configured listener accepts a connection.
 *
 * Process-management:
 *   - SIGTERM / SIGINT → graceful stop (await ControlPlaneServer.stop()
 *     then RelayServer.stop() — order reversed from start so the WSS
 *     drains cleanly before the HTTP front-end exits).
 *   - Uncaught errors during boot → process.exit(1) with the error logged.
 */
import { assertInternalIngress } from './assert-internal-ingress.js';
import { RelayServer } from './relay-server.js';
import { ControlPlaneServer, requireControlPlaneSecret } from './control-plane-server.js';
import { initPools } from '../db/context.js';
import { config } from '../config.js';

/** Default ports — override via env. */
const DEFAULT_WSS_PORT = 8080;
const DEFAULT_CONTROL_PLANE_PORT = 8081;

export interface BootOptions {
  /** WSS terminator port (the public-facing port on-prem tunnels dial). */
  wssPort?: number;
  /** Control-plane HTTP port (internal-only). */
  controlPlanePort?: number;
}

/**
 * Boot the relay container. Returns the started servers so callers can
 * graceful-shutdown them; throws (refuses to boot) if any guard fails.
 *
 * This is the load-bearing wire that pairs with the three boot asserts: the
 * pure existence of `assertInternalIngress` is necessary-but-not-sufficient
 * for the no-misconfigured-ingress invariant; the invariant holds only when
 * the assert is INVOKED before the HTTP listener opens. This function is the
 * invocation.
 */
export async function bootRelay(opts: BootOptions = {}): Promise<{
  relay: RelayServer;
  controlPlane: ControlPlaneServer;
}> {
  // 1 — assertInternalIngress: env-driven boot guard, paired with the
  // deploy-time CI bicep falsifier (different-level falsifier, same property).
  assertInternalIngress();

  // 2 — HMAC secret required; fail-loud before any listen() call.
  const secret = requireControlPlaneSecret();

  // 2b — Initialise the DB pools BEFORE anything touches the database. The
  // relay's only DB user is the system-path tunnel-registry (findLiveTunnel +
  // the periodic sweepStaleTunnels safety net scheduled by RelayServer.start()
  // below), all via runAsSystem → systemPool(). Without this, the very first
  // sweep tick throws "DB pools not initialised" and crashes the process after
  // boot. The gateway calls initPools at src/index.ts boot; the relay is a
  // separate entrypoint and must do the same. Same two-connection-class config
  // (system = BYPASSRLS for the registry; request kept for parity even though
  // the relay has no request-path). Cheap guards (1, 2) run first so a misconfig
  // fails loud before we open any pool; pools open before start() schedules the
  // sweep timer.
  initPools({
    systemUrl: config.databaseUrl,
    requestUrl: config.databaseUrlRequest,
  });

  // 3 — WSS terminator first (the public port; on-prem tunnels dial it).
  const wssPort = opts.wssPort ?? Number(process.env.RELAY_WSS_PORT ?? DEFAULT_WSS_PORT);
  const relay = new RelayServer({ port: wssPort });
  relay.start();

  // 4 — Control-plane HTTP last (the INTERNAL-only port; assertInternalIngress
  // already confirmed the deployment policy).
  const controlPlanePort =
    opts.controlPlanePort ?? Number(process.env.CONTROL_PLANE_PORT ?? DEFAULT_CONTROL_PLANE_PORT);
  const controlPlane = new ControlPlaneServer({
    relay,
    secret,
    port: controlPlanePort,
  });
  await controlPlane.start();

  return { relay, controlPlane };
}

/**
 * Graceful shutdown. Reverse-order from boot: control-plane HTTP front-end
 * closes first (no new requests accepted) so the WSS drain happens with no
 * inbound traffic competing for tunnels.
 */
export async function shutdownRelay(handles: {
  relay: RelayServer;
  controlPlane: ControlPlaneServer;
}): Promise<void> {
  await handles.controlPlane.stop();
  await handles.relay.stop();
}

/**
 * Main entry — called when this module is the process entry point. Boot,
 * register signal handlers, await graceful shutdown. Errors during boot exit
 * with code 1; misconfigs (via assert/require throws) propagate to the same
 * exit path so the deploy never quietly serves a half-configured relay.
 */
export async function main(): Promise<void> {
  let handles: { relay: RelayServer; controlPlane: ControlPlaneServer };
  try {
    handles = await bootRelay();
  } catch (err) {
    process.stderr.write(
      `RELAY BOOT FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  process.stdout.write('relay container ready\n');

  const onSignal = (sig: NodeJS.Signals): void => {
    process.stdout.write(`received ${sig}, shutting down\n`);
    shutdownRelay(handles)
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(
          `shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

// Only execute main() when this file is the process entry point, not when
// imported by tests (which exercise bootRelay() directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
