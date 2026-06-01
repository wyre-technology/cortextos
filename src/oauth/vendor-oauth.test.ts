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
  it('returns null when no expected issuer is configured (opt-in)', () => {
    expect(validateCallbackIssuer(undefined, undefined)).toBeNull();
    expect(validateCallbackIssuer(undefined, 'https://example.com')).toBeNull();
  });

  it('returns missing_iss when expected is set but actual is missing', () => {
    expect(validateCallbackIssuer('https://example.com', undefined)).toBe('missing_iss');
  });

  it('returns iss_mismatch when expected and actual differ', () => {
    expect(validateCallbackIssuer('https://example.com', 'https://evil.com')).toBe('iss_mismatch');
  });

  it('returns null when expected and actual match exactly', () => {
    expect(validateCallbackIssuer('https://oauth.platform.intuit.com/op/v1', 'https://oauth.platform.intuit.com/op/v1')).toBeNull();
  });
});
