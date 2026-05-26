/**
 * On-prem-gateway container entry point.
 *
 * PR #3 scope-doc §4 (locked green from boss + analyst + warden 2026-05-22).
 * Closes the defined-but-not-called gap on PR #1's assertSecureRelayUrl +
 * assertNoInbound — same discipline applied at PR #211's `src/relay/index.ts`,
 * extended to the customer-deploy surface with the warden-pinned 5th guard
 * (pre-dial ENROLLMENT_TOKEN structural-validate).
 *
 * SIX-GUARD BOOT SEQUENCE — every guard MUST fire before the next runs, and
 * ANY guard failure means the gateway refuses to boot (no partial init, no
 * silent fallback). Order is deliberate: cheapest checks first, progressively
 * heavier resources, no port-bind / no WSS dial until the entire stack is
 * validated.
 *
 *   1. requireCustomerEnvVars()  — RELAY_URL + ENROLLMENT_TOKEN + CAPABILITIES
 *      MUST be set. Fail-loud-with-named-actionable-choice (boss + analyst
 *      pin): each error message names the env var + WHY required + WHERE to
 *      get the value (portal URL) + docs anchor link.
 *   2. structurallyValidateEnrollmentToken() — pre-dial structural-validate
 *      of the JWT (3-segment shape + base64url-decodable header/payload +
 *      exp-not-expired + iss/aud-match). Warden's 5th guard. NOT a security
 *      primitive (the relay's jose.jwtVerify IS the security gate); a UX +
 *      bad-token-noise-reduction layer. Source comment pins the boundary
 *      explicitly for the next reader.
 *   3. assertSecureRelayUrl(RELAY_URL) — PR #1's must-use-wss boot assert.
 *      The customer's RELAY_URL MUST be wss:// (production = wss://relay.wyre.ai).
 *   4. assertNoInbound() — PR #1's no-LAN-listener boot assert. The on-prem
 *      gateway binds NO inbound port; the WSS dial-out is its only ingress.
 *   5. new TunnelClient({...}) — construction with validated config.
 *   6. client.start() — dial the relay, register, hold the live tunnel.
 *
 * Per the boot-discipline-in-code pedagogical-artifact pattern (boss
 * observation #5 on PR #211): this file header explicitly NAMES the rule
 * — "defined-but-not-called = documented-but-not-shipped — the structural
 * pin requires the wiring, not just the definition. This entry point IS the
 * wire."
 *
 * Process-management:
 *   - SIGTERM / SIGINT → graceful stop via client.stop() (drains pending
 *     requests; same lifecycle-observable-boundary discipline as PR #211's
 *     `RelayServer.stop()` drain fix).
 *   - Uncaught errors during boot → process.exit(1) with the error logged.
 */
import { assertNoInbound } from './no-inbound-assert.js';
import { TunnelClient, assertSecureRelayUrl } from './tunnel-client.js';
import { handleEchoMcp } from './echo-mcp-server.js';

/** Docs URL base — the customer-facing quickstart. */
const DOCS_BASE = 'https://conduit.wyre.ai/docs/guides/onprem';
const CUSTOMER_PORTAL_URL = 'https://customer.wyre.ai/onprem-deploy';

/** Env vars the customer MUST set. */
interface CustomerEnv {
  RELAY_URL: string;
  ENROLLMENT_TOKEN: string;
  CAPABILITIES: string[];
}

/**
 * Required-env-var check with fail-loud-with-named-actionable-choice (Walter's
 * "is AND, not OR" framing — the error message INCLUDES the actionable next-step:
 * env var name + WHY + WHERE to get it + docs URL). Apply uniformly to all three.
 */
export function requireCustomerEnvVars(): CustomerEnv {
  const relayUrl = process.env.RELAY_URL;
  if (!relayUrl || relayUrl.length === 0) {
    throw new Error(
      `FATAL: RELAY_URL env var is required. The on-prem-gateway refuses to start without ` +
        `a WYRE relay endpoint to dial. Set RELAY_URL=wss://relay.wyre.ai (or your staging ` +
        `equivalent). See: ${DOCS_BASE}/reference#relay-url`,
    );
  }
  const enrollmentToken = process.env.ENROLLMENT_TOKEN;
  if (!enrollmentToken || enrollmentToken.length === 0) {
    throw new Error(
      `FATAL: ENROLLMENT_TOKEN env var is required. The on-prem-gateway refuses to start ` +
        `without a WYRE-issued enrollment token. Get yours at ${CUSTOMER_PORTAL_URL}. See: ` +
        `${DOCS_BASE}/reference#enrollment-token`,
    );
  }
  const capabilitiesRaw = process.env.CAPABILITIES;
  if (!capabilitiesRaw || capabilitiesRaw.length === 0) {
    throw new Error(
      `FATAL: CAPABILITIES env var is required. The on-prem-gateway refuses to start without ` +
        `a declared capability list (comma-separated MCP slugs the tunnel exposes). For M2 ` +
        `(echo-only), set CAPABILITIES=echo. NOTE: slug match is BYTE-FOR-BYTE AFTER per-entry ` +
        `trim — case must match exactly (Echo ≠ echo); whitespace WITHIN a slug must match; ` +
        `surrounding whitespace per entry is auto-trimmed. See: ` +
        `${DOCS_BASE}/reference#capabilities`,
    );
  }
  // Parse + reject empty entries (e.g. "echo,,foo" → would silently include "" without filter).
  const capabilities = capabilitiesRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (capabilities.length === 0) {
    throw new Error(
      `FATAL: CAPABILITIES env var is set but contains no valid slugs (after trim + ` +
        `empty-filter). See: ${DOCS_BASE}/reference#capabilities`,
    );
  }
  return { RELAY_URL: relayUrl, ENROLLMENT_TOKEN: enrollmentToken, CAPABILITIES: capabilities };
}

/**
 * Pre-dial structural-validate of the ENROLLMENT_TOKEN (warden's 5th guard).
 *
 * **BOUNDARY (warden's explicit pin):** structural-fail-fast for UX +
 * reduces noisy bad-token attempts at the relay; the relay's `jose.jwtVerify`
 * IS the security gate. This is NOT a security primitive — no key is
 * available on the on-prem side. Common misconfigs this catches:
 *   - expired token from sitting too long after issuance
 *   - copy-paste truncation
 *   - wrong env var set entirely (not a JWT shape)
 *   - iss/aud mismatch from misconfigured customer-portal output
 *
 * Each specific failure mode throws with a specific message so the docs's
 * troubleshooting section can match the customer's exact error verbatim
 * (Walter's "verbatim-error-as-troubleshooting-section-heading" discipline).
 */
export interface ExpectedTokenClaims {
  expectedIssuer: string;
  expectedAudience: string;
}

const DEFAULT_EXPECTED_CLAIMS: ExpectedTokenClaims = {
  expectedIssuer: 'https://conduit.wyre.ai',
  expectedAudience: 'onprem-tunnel-enrollment',
};

export function structurallyValidateEnrollmentToken(
  token: string,
  expected: ExpectedTokenClaims = DEFAULT_EXPECTED_CLAIMS,
): void {
  // (a) 3-segment JWT shape — header.payload.signature.
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(
      `FATAL: ENROLLMENT_TOKEN structure invalid — expected 3 segments (header.payload.signature), ` +
        `got ${parts.length}. Likely cause: copy-paste truncation or wrong env var value. ` +
        `See: ${DOCS_BASE}/troubleshooting#enrollment-token-structure-invalid`,
    );
  }

  // (b) base64url-decodable header + payload.
  let payload: { exp?: number; iss?: string; aud?: string | string[] };
  try {
    const headerBytes = Buffer.from(parts[0], 'base64url');
    JSON.parse(headerBytes.toString('utf8'));
    const payloadBytes = Buffer.from(parts[1], 'base64url');
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new Error(
      `FATAL: ENROLLMENT_TOKEN structure invalid — header or payload is not valid base64url-` +
        `encoded JSON. Likely cause: copy-paste corruption. ` +
        `See: ${DOCS_BASE}/troubleshooting#enrollment-token-structure-invalid`,
    );
  }

  // (c) exp claim not expired.
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) {
    throw new Error(
      `FATAL: ENROLLMENT_TOKEN appears expired (exp=${payload.exp ?? 'absent'}, now=${nowSec}). ` +
        `Get a fresh token at ${CUSTOMER_PORTAL_URL}. ` +
        `See: ${DOCS_BASE}/troubleshooting#enrollment-token-expired`,
    );
  }

  // (d) iss + aud match expected.
  if (payload.iss !== expected.expectedIssuer) {
    throw new Error(
      `FATAL: ENROLLMENT_TOKEN iss claim mismatch (got '${payload.iss ?? 'absent'}', ` +
        `expected '${expected.expectedIssuer}'). Likely cause: token from wrong environment ` +
        `(staging-token-against-prod or vice versa). ` +
        `See: ${DOCS_BASE}/troubleshooting#enrollment-token-issuer-mismatch`,
    );
  }
  const audList = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audList.includes(expected.expectedAudience)) {
    throw new Error(
      `FATAL: ENROLLMENT_TOKEN aud claim mismatch (got ${JSON.stringify(audList)}, ` +
        `expected '${expected.expectedAudience}'). ` +
        `See: ${DOCS_BASE}/troubleshooting#enrollment-token-audience-mismatch`,
    );
  }
}

export interface BootOptions {
  /** Override the expected JWT claims (for staging environments). */
  expectedTokenClaims?: ExpectedTokenClaims;
}

/**
 * Boot the on-prem-gateway. Runs all six guards in order; throws on ANY
 * guard failure — refusing to boot — and returns the started TunnelClient
 * + the validated env on success. The structural pin REQUIRES every guard
 * to fire before the next runs.
 */
export async function bootOnpremGateway(opts: BootOptions = {}): Promise<{
  client: TunnelClient;
  env: CustomerEnv;
}> {
  // Guard 1 — required env vars (fail-loud + actionable).
  const env = requireCustomerEnvVars();

  // Guard 2 — pre-dial ENROLLMENT_TOKEN structural-validate (warden 5th guard).
  structurallyValidateEnrollmentToken(env.ENROLLMENT_TOKEN, opts.expectedTokenClaims);

  // Guard 3 — must-use-wss (PR #1 boot assert; now CALLED, not just defined).
  assertSecureRelayUrl(env.RELAY_URL);

  // Guard 4 — no LAN-listener (PR #1 boot assert; now CALLED, not just defined).
  assertNoInbound();

  // Guard 5 — TunnelClient construction with validated config.
  const client = new TunnelClient({
    relayUrl: env.RELAY_URL,
    enrollmentToken: env.ENROLLMENT_TOKEN,
    capabilities: env.CAPABILITIES,
    // M2 echo carries forward; real MCP-server integration is M2 work post-launch.
    onRequest: async (_target, payload) => handleEchoMcp(payload),
  });

  // Guard 6 — dial. After this returns, the tunnel is connecting; register
  // happens asynchronously and is observable via client.currentTunnelId().
  client.start();

  return { client, env };
}

/**
 * Graceful shutdown — same lifecycle-observable-boundary discipline as
 * PR #211's RelayServer.stop drain fix. client.stop() drains pending
 * requests + closes the socket; await before exit.
 */
export async function shutdownOnpremGateway(handles: { client: TunnelClient }): Promise<void> {
  await handles.client.stop();
}

/**
 * Main entry — called when this module is the process entry point. Boot,
 * register signal handlers, await graceful shutdown. Errors during boot
 * exit with code 1; misconfigs (via guard throws) propagate to the same
 * exit path so the deploy never quietly serves a half-configured gateway.
 */
export async function main(): Promise<void> {
  let handles: { client: TunnelClient; env: CustomerEnv };
  try {
    handles = await bootOnpremGateway();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `on-prem-gateway ready: dialing ${handles.env.RELAY_URL} ` +
      `with capabilities=[${handles.env.CAPABILITIES.join(',')}]\n`,
  );

  const onSignal = (sig: NodeJS.Signals): void => {
    process.stdout.write(`received ${sig}, shutting down\n`);
    shutdownOnpremGateway(handles)
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
// imported by tests (which exercise bootOnpremGateway() / the guards directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
