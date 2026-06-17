import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateCallbackIssuer,
  exchangeCodeForTokens,
  refreshAccessToken,
} from './vendor-oauth.js';
import type { OAuthVendorConfig } from '../credentials/vendor-config.js';

/**
 * Tests for validateCallbackIssuer (RFC 9207 — OAuth 2.0 Authorization Server
 * Issuer Identification, mix-up attack defense).
 *
 * Ported from mcp-gateway/src/oauth/vendor-oauth.test.ts (the first describe
 * block — validateCallbackIssuer (RFC 9207) — verbatim). Gateway's test file
 * has two other describe blocks (host-aware OAuth callback URLs + BYOC OAuth
 * credentials) that depend on features conduit doesn't have yet:
 *
 *  - Host-aware callbacks: WYREAI-91 fast-follow (multi-host dynamic base
 *    URL via getRequestBaseUrl + allowedHosts).
 *  - BYOC (tenant-supplied client_id/secret): separate parity-audit surface
 *    (see WYREAI-74 vendor catalog parity for related work).
 *
 * Those describe blocks port when the underlying features land in conduit.
 *
 * WYREAI-75 PR B (RFC 9207 issuer-validation wire-in).
 */
describe('validateCallbackIssuer (RFC 9207)', () => {
  // WYREAI-92: issuer is now mandatory — there is no opt-in/skip path. A
  // missing actual `iss` always fails closed.
  it('returns missing_iss when actual iss is absent (no skip path)', () => {
    expect(validateCallbackIssuer('https://example.com', undefined)).toBe('missing_iss');
  });

  it('returns iss_mismatch when expected and actual differ', () => {
    expect(validateCallbackIssuer('https://example.com', 'https://evil.com')).toBe('iss_mismatch');
  });

  it('returns null when expected and actual match exactly', () => {
    expect(validateCallbackIssuer('https://oauth.platform.intuit.com/op/v1', 'https://oauth.platform.intuit.com/op/v1')).toBeNull();
  });

  // Tenant-templated issuers (Microsoft Entra): {tenantid} matches the GUID
  // in the actual iss, but only a single non-slash segment, anchored.
  describe('{tenantid} template (Microsoft Entra)', () => {
    const tmpl = 'https://login.microsoftonline.com/{tenantid}/v2.0';

    it('matches a real tenant-specific issuer', () => {
      expect(
        validateCallbackIssuer(tmpl, 'https://login.microsoftonline.com/12345678-90ab-cdef-1234-567890abcdef/v2.0'),
      ).toBeNull();
    });

    it('still fails closed on a missing iss', () => {
      expect(validateCallbackIssuer(tmpl, undefined)).toBe('missing_iss');
    });

    it('rejects a different host even with a tenant-shaped segment', () => {
      expect(
        validateCallbackIssuer(tmpl, 'https://login.evil.com/12345678-90ab-cdef-1234-567890abcdef/v2.0'),
      ).toBe('iss_mismatch');
    });

    it('rejects an iss with an extra path segment (placeholder is single-segment, anchored)', () => {
      expect(
        validateCallbackIssuer(tmpl, 'https://login.microsoftonline.com/tenant/evil/v2.0'),
      ).toBe('iss_mismatch');
    });

    it('rejects a suffix-embedding attempt (anchored match)', () => {
      expect(
        validateCallbackIssuer(tmpl, 'https://login.microsoftonline.com/tenant/v2.0.evil.com'),
      ).toBe('iss_mismatch');
    });
  });
});

/**
 * Public-client + PKCE substrate gating (Calendly wire-in, boss
 * msg-1781709824601 / 2026-06-17). The token-exchange path MUST:
 *
 *   - omit the client_secret form-field when oauthConfig.publicClient is true
 *   - SUPPLY the client_secret when oauthConfig.publicClient is unset/false
 *
 * The refresh-token path mirrors the same gating. These tests pin both
 * directions so a regression on either side fails loudly. Sibling to
 * ruby's set-boundary-via-external-source-citation discipline — the
 * authoritative source for the flag is the vendor's RFC 8414 discovery
 * doc (Calendly: token_endpoint_auth_methods=["none"]).
 */
describe('publicClient + PKCE token exchange gating', () => {
  const CONFIDENTIAL: OAuthVendorConfig = {
    authorizeUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    scopes: ['scope.read'],
    clientIdEnv: 'TEST_CONFIDENTIAL_ID',
    clientSecretEnv: 'TEST_CONFIDENTIAL_SECRET',
    issuer: 'https://example.com',
  };
  const PUBLIC_CLIENT: OAuthVendorConfig = {
    authorizeUrl: 'https://calendly.com/oauth/authorize',
    tokenUrl: 'https://calendly.com/oauth/token',
    scopes: ['mcp:scheduling:read'],
    clientIdEnv: 'TEST_PUBLIC_ID',
    issuer: 'https://calendly.com',
    publicClient: true,
  };

  // Untyped because vi.spyOn over globalThis.fetch confuses TS — the
  // mock-instance shape is consistent and only `.mock.calls[0][1]` is
  // referenced downstream, which is read as RequestInit anyway.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    vi.stubEnv('TEST_CONFIDENTIAL_ID', 'cid_conf');
    vi.stubEnv('TEST_CONFIDENTIAL_SECRET', 'sec_conf');
    vi.stubEnv('TEST_PUBLIC_ID', 'cid_pub');
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 't', refresh_token: 'r', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseFormBody(spy: any): URLSearchParams {
    const init = spy.mock.calls[0]![1] as RequestInit;
    return new URLSearchParams(init.body as string);
  }

  it('exchangeCodeForTokens — confidential client SUPPLIES client_secret', async () => {
    await exchangeCodeForTokens(CONFIDENTIAL, 'code123', 'verifier456');
    const body = parseFormBody(fetchSpy);
    expect(body.get('client_id')).toBe('cid_conf');
    expect(body.get('client_secret')).toBe('sec_conf');
    expect(body.get('code_verifier')).toBe('verifier456');
  });

  it('exchangeCodeForTokens — publicClient OMITS client_secret entirely', async () => {
    await exchangeCodeForTokens(PUBLIC_CLIENT, 'code123', 'verifier456');
    const body = parseFormBody(fetchSpy);
    expect(body.get('client_id')).toBe('cid_pub');
    // SECURITY: no client_secret leaks even as empty-string. PKCE
    // code_verifier replaces the secret.
    expect(body.has('client_secret')).toBe(false);
    expect(body.get('code_verifier')).toBe('verifier456');
  });

  it('exchangeCodeForTokens — confidential client without clientSecretEnv throws fail-closed', async () => {
    const broken: OAuthVendorConfig = {
      ...CONFIDENTIAL,
      clientSecretEnv: undefined,
    };
    await expect(
      exchangeCodeForTokens(broken, 'code', 'verifier'),
    ).rejects.toThrow(/missing clientSecretEnv/);
  });

  it('refreshAccessToken — confidential client SUPPLIES client_secret', async () => {
    await refreshAccessToken(CONFIDENTIAL, 'rtok');
    const body = parseFormBody(fetchSpy);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_secret')).toBe('sec_conf');
  });

  it('refreshAccessToken — publicClient OMITS client_secret entirely', async () => {
    await refreshAccessToken(PUBLIC_CLIENT, 'rtok');
    const body = parseFormBody(fetchSpy);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.has('client_secret')).toBe(false);
  });
});
