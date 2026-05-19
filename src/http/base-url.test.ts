import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getRequestBaseUrl } from './base-url.js';

function mockRequest(host: string, proto = 'https'): FastifyRequest {
  return {
    headers: { host, 'x-forwarded-proto': proto },
    protocol: proto,
  } as unknown as FastifyRequest;
}

describe('getRequestBaseUrl', () => {
  const allowed = ['mcp.wyre.ai', 'mcp.wyretechnology.com', 'localhost:8080'];

  it('returns https://host for an allowed host', () => {
    expect(getRequestBaseUrl(mockRequest('mcp.wyre.ai'), allowed)).toBe('https://mcp.wyre.ai');
    expect(getRequestBaseUrl(mockRequest('mcp.wyretechnology.com'), allowed)).toBe('https://mcp.wyretechnology.com');
  });

  it('respects x-forwarded-proto for localhost http', () => {
    expect(getRequestBaseUrl(mockRequest('localhost:8080', 'http'), allowed)).toBe('http://localhost:8080');
  });

  it('falls back to the first allowed host for an unknown Host header', () => {
    expect(getRequestBaseUrl(mockRequest('attacker.example'), allowed)).toBe('https://mcp.wyre.ai');
  });

  it('falls back when Host header is missing', () => {
    const req = { headers: {}, protocol: 'https' } as unknown as FastifyRequest;
    expect(getRequestBaseUrl(req, allowed)).toBe('https://mcp.wyre.ai');
  });

  // --- A3 regression: the malformed-redirect_uri / double-scheme class ------
  // Empty ALLOWED_HOSTS on staging gave config.allowedHosts = [], and the old
  // fallback `allowedHosts[0] ?? 'http://localhost:8080'` used a SCHEME-
  // CARRYING literal that then got `${proto}://` prepended — emitting
  // `https://http://localhost:8080/auth/microsoft/callback`, a redirect_uri
  // Microsoft rejects. A config mistake must fail LOUD, not ship a broken URL.

  it('throws (not a double-scheme URL) when the allowlist is empty', () => {
    const req = mockRequest('staging.conduit.wyre.ai');
    expect(() => getRequestBaseUrl(req, [])).toThrow(/ALLOWED_HOSTS/);
  });

  it('throws when the allowlist has only empty/whitespace entries', () => {
    const req = mockRequest('staging.conduit.wyre.ai');
    expect(() => getRequestBaseUrl(req, ['', '  '])).toThrow(/ALLOWED_HOSTS/);
  });

  it('never emits a double scheme — a scheme-prefixed allowlist entry is normalised', () => {
    // A misconfigured ALLOWED_HOSTS entry that carries a scheme must not
    // produce https://https://host. The entry is normalised to a bare host.
    const fallback = getRequestBaseUrl(mockRequest('unknown.example'), ['https://mcp.wyre.ai']);
    expect(fallback).toBe('https://mcp.wyre.ai');
    const matched = getRequestBaseUrl(mockRequest('mcp.wyre.ai'), ['https://mcp.wyre.ai']);
    expect(matched).toBe('https://mcp.wyre.ai');
  });
});