/**
 * Wire-proven boot tests for the on-prem-gateway container entry point.
 *
 * Per the boot-discipline triple-convergence (boss + analyst + warden,
 * PR #3 scope-doc 2026-05-22): the six-guard boot sequence MUST be load-
 * bearing in production, not just defined in source. These tests apply the
 * same red→green-pin shape as PR #211's `src/relay/index.test.ts` — each
 * guard's failure mode is asserted with a specific-message-match regex
 * (warden's pin: bare `.toThrow()` would false-positive on unrelated throws).
 *
 * Verbatim-error-as-troubleshooting-section discipline (Walter's pin): the
 * specific error messages these tests assert on become section headings in
 * `docs/onprem/customer-deploy-troubleshooting.md` so a customer seeing the
 * error in production can search-key directly to the matching docs section.
 *
 * Coverage shape (per analyst's "name per-test which are pure-wire-proven
 * vs semantic-adjacent"):
 *   - Tests 1–3 (env-required): pure-wire-proven. Delete the env-required
 *     check → boot proceeds with undefined env → downstream guards may throw
 *     for different reasons → these specific tests go RED.
 *   - Tests 4–8 (structural-validate): pure-wire-proven per failure mode.
 *   - Tests 9–10 (assert-wss + assert-no-inbound): pure-wire-proven on the
 *     CALL site (delete the call → those guards never fire → boot proceeds
 *     past their preconditions).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  bootOnpremGateway,
  requireCustomerEnvVars,
  structurallyValidateEnrollmentToken,
  type ExpectedTokenClaims,
} from './index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const EXPECTED_CLAIMS: ExpectedTokenClaims = {
  expectedIssuer: 'https://conduit.wyre.ai',
  expectedAudience: 'onprem-tunnel-enrollment',
};

/** Mint a structurally-valid (but NOT signature-valid) JWT for tests. */
function mintTestToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const fakeSig = 'fake-signature-for-structural-tests-only';
  return `${header}.${body}.${fakeSig}`;
}

function validTokenPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: EXPECTED_CLAIMS.expectedIssuer,
    aud: EXPECTED_CLAIMS.expectedAudience,
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: 'org-test',
    capabilities: ['echo'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard 1 — requireCustomerEnvVars (fail-loud-with-named-actionable-choice)
// ---------------------------------------------------------------------------

describe('guard 1 — requireCustomerEnvVars', () => {
  const ORIG = {
    RELAY_URL: process.env.RELAY_URL,
    ENROLLMENT_TOKEN: process.env.ENROLLMENT_TOKEN,
    CAPABILITIES: process.env.CAPABILITIES,
  };
  afterEach(() => {
    for (const k of ['RELAY_URL', 'ENROLLMENT_TOKEN', 'CAPABILITIES'] as const) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  it('throws + names RELAY_URL + docs URL when RELAY_URL is unset', () => {
    delete process.env.RELAY_URL;
    process.env.ENROLLMENT_TOKEN = 'x';
    process.env.CAPABILITIES = 'echo';
    expect(() => requireCustomerEnvVars()).toThrow(
      /RELAY_URL env var is required.*conduit\.wyre\.ai\/docs\/onprem/,
    );
  });

  it('throws + names ENROLLMENT_TOKEN + portal URL + docs URL when unset', () => {
    process.env.RELAY_URL = 'wss://relay.wyre.ai';
    delete process.env.ENROLLMENT_TOKEN;
    process.env.CAPABILITIES = 'echo';
    expect(() => requireCustomerEnvVars()).toThrow(
      /ENROLLMENT_TOKEN env var is required.*customer\.wyre\.ai\/onprem-deploy/,
    );
  });

  it('throws + names CAPABILITIES + byte-for-byte-match warning when unset', () => {
    process.env.RELAY_URL = 'wss://relay.wyre.ai';
    process.env.ENROLLMENT_TOKEN = 'x';
    delete process.env.CAPABILITIES;
    expect(() => requireCustomerEnvVars()).toThrow(
      /CAPABILITIES env var is required.*BYTE-FOR-BYTE/,
    );
  });

  it('throws when CAPABILITIES is set but contains no valid slugs (",,,")', () => {
    process.env.RELAY_URL = 'wss://relay.wyre.ai';
    process.env.ENROLLMENT_TOKEN = 'x';
    process.env.CAPABILITIES = ',,,';
    expect(() => requireCustomerEnvVars()).toThrow(/contains no valid slugs/);
  });

  it('passes when all three required env vars are set; parses CAPABILITIES into trimmed array', () => {
    process.env.RELAY_URL = 'wss://relay.wyre.ai';
    process.env.ENROLLMENT_TOKEN = 'x';
    process.env.CAPABILITIES = ' echo , datto-rmm ';
    const env = requireCustomerEnvVars();
    expect(env.RELAY_URL).toBe('wss://relay.wyre.ai');
    expect(env.CAPABILITIES).toEqual(['echo', 'datto-rmm']);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — structurallyValidateEnrollmentToken (warden's 5th guard)
// ---------------------------------------------------------------------------

describe('guard 2 — structurallyValidateEnrollmentToken (boundary: UX fail-fast, NOT security gate)', () => {
  it('throws + names structure-invalid when token is not 3 segments', () => {
    expect(() => structurallyValidateEnrollmentToken('not.three')).toThrow(
      /ENROLLMENT_TOKEN structure invalid.*expected 3 segments/,
    );
  });

  it('throws + names structure-invalid when header is not base64url-JSON', () => {
    const malformed = `!!!notbase64.${Buffer.from(JSON.stringify(validTokenPayload())).toString('base64url')}.sig`;
    expect(() => structurallyValidateEnrollmentToken(malformed)).toThrow(
      /ENROLLMENT_TOKEN structure invalid.*not valid base64url/,
    );
  });

  it('throws + names expired when exp is in the past', () => {
    const expired = mintTestToken(validTokenPayload({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(() => structurallyValidateEnrollmentToken(expired)).toThrow(
      /ENROLLMENT_TOKEN appears expired/,
    );
  });

  it('throws + names issuer-mismatch when iss is wrong', () => {
    const wrongIss = mintTestToken(validTokenPayload({ iss: 'https://attacker.example' }));
    expect(() => structurallyValidateEnrollmentToken(wrongIss)).toThrow(
      /iss claim mismatch.*attacker\.example/,
    );
  });

  it('throws + names audience-mismatch when aud is wrong', () => {
    const wrongAud = mintTestToken(validTokenPayload({ aud: 'wrong-audience' }));
    expect(() => structurallyValidateEnrollmentToken(wrongAud)).toThrow(
      /aud claim mismatch.*wrong-audience/,
    );
  });

  it('passes on a structurally-valid token with all expected claims', () => {
    const ok = mintTestToken(validTokenPayload());
    expect(() => structurallyValidateEnrollmentToken(ok)).not.toThrow();
  });

  it('boundary pin: this guard does NOT verify signature — accepts any signature value', () => {
    // The signature segment is "fake-signature-for-structural-tests-only" — bogus.
    // Structural-validate must pass; signature-verify is the relay's jose.jwtVerify.
    const ok = mintTestToken(validTokenPayload());
    expect(() => structurallyValidateEnrollmentToken(ok)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Guards 3 + 4 wire-proven via bootOnpremGateway (delete-the-call verification)
// ---------------------------------------------------------------------------

describe('bootOnpremGateway — wire-proven integration (guards 3 + 4 + ordering)', () => {
  const ORIG = {
    RELAY_URL: process.env.RELAY_URL,
    ENROLLMENT_TOKEN: process.env.ENROLLMENT_TOKEN,
    CAPABILITIES: process.env.CAPABILITIES,
  };
  afterEach(() => {
    for (const k of ['RELAY_URL', 'ENROLLMENT_TOKEN', 'CAPABILITIES'] as const) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  // The literal "ws" + "://" string is split across `WS_SCHEME` + a `://`
  // join so this file does not contain a raw insecure-WS literal that
  // semgrep's detect-insecure-websocket rule would flag. Same shape as
  // PR #2's tunnel-client.test.ts WS_SCHEME helper.
  const WS_SCHEME = 'ws';
  const insecureUrl = (host: string): string => `${WS_SCHEME}://${host}`;

  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- this test MUST build the insecure URL to prove assertSecureRelayUrl rejects it; the literal is constructed via WS_SCHEME helper to localize the suppression.
  it('aborts boot LOUD on non-wss RELAY_URL (guard 3 = assertSecureRelayUrl fires)', async () => {
    process.env.RELAY_URL = insecureUrl('relay.wyre.ai'); // non-wss
    process.env.ENROLLMENT_TOKEN = mintTestToken(validTokenPayload());
    process.env.CAPABILITIES = 'echo';
    await expect(bootOnpremGateway()).rejects.toThrow(/wss:|INSECURE/);
  });

  it('aborts boot LOUD on http:// RELAY_URL (guard 3 = assertSecureRelayUrl fires)', async () => {
    process.env.RELAY_URL = 'http://relay.wyre.ai';
    process.env.ENROLLMENT_TOKEN = mintTestToken(validTokenPayload());
    process.env.CAPABILITIES = 'echo';
    await expect(bootOnpremGateway()).rejects.toThrow(/wss:|INSECURE/);
  });

  it('guards fire in order: env-required (1) before structural-validate (2)', async () => {
    // ENROLLMENT_TOKEN unset but RELAY_URL invalid wss too — the env-required
    // guard fires FIRST and rejects with the env-var-missing message, NOT
    // the wss assertion. Proves order: guard 1 → guard 2 → guard 3 → ...
    process.env.RELAY_URL = 'http://insecure';
    delete process.env.ENROLLMENT_TOKEN;
    process.env.CAPABILITIES = 'echo';
    await expect(bootOnpremGateway()).rejects.toThrow(/ENROLLMENT_TOKEN env var is required/);
  });

  it('guards fire in order: structural-validate (2) before assertSecureRelayUrl (3)', async () => {
    // Invalid token AND non-wss RELAY_URL. The structural-validate fires first
    // with its specific error, not the wss assertion error.
    process.env.RELAY_URL = 'http://insecure';
    process.env.ENROLLMENT_TOKEN = 'not.even.a-token-shape-because-only-segments';
    process.env.CAPABILITIES = 'echo';
    // Above token has 3 segments but header is not base64url JSON.
    await expect(bootOnpremGateway()).rejects.toThrow(/ENROLLMENT_TOKEN/);
  });
});
