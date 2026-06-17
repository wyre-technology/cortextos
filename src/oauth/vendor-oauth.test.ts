import { describe, it, expect } from 'vitest';
import { validateCallbackIssuer } from './vendor-oauth.js';

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
