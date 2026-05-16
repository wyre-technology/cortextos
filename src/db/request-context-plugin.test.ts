import { describe, it, expect } from 'vitest';
import { isExempt } from './request-context-plugin.js';

describe('isExempt — request-context exemption matcher', () => {
  it('matches an exact exempt prefix, any method', () => {
    expect(isExempt('GET', '/health')).toBe(true);
    expect(isExempt('POST', '/api/webhooks/stripe')).toBe(true);
  });

  it('matches a path nested under an exempt prefix', () => {
    expect(isExempt('GET', '/health/vendors')).toBe(true);
  });

  it('ignores the query string when matching', () => {
    expect(isExempt('GET', '/health?probe=1')).toBe(true);
  });

  it('does NOT match a path that merely shares the prefix as a substring', () => {
    // The boundary bug: /healthz must not be exempted by the /health prefix.
    expect(isExempt('GET', '/healthz')).toBe(false);
    expect(isExempt('GET', '/health-internal')).toBe(false);
  });

  it('does not exempt a normal request-path route', () => {
    expect(isExempt('GET', '/api/orgs')).toBe(false);
    expect(isExempt('GET', '/settings')).toBe(false);
  });

  // The MCP SSE exemption is method-aware: a GET is a persistent heartbeat
  // stream (no DB work) and must NOT pin a request-pool connection; a POST is
  // the JSON-RPC call path and legitimately needs the request context.
  it('exempts GET on the unified MCP endpoint (SSE stream)', () => {
    expect(isExempt('GET', '/v1/mcp')).toBe(true);
  });

  it('exempts GET on the per-vendor MCP endpoint (SSE stream)', () => {
    expect(isExempt('GET', '/v1/autotask/mcp')).toBe(true);
    expect(isExempt('GET', '/v1/datto-rmm/mcp')).toBe(true);
  });

  it('does NOT exempt POST on the MCP endpoints — JSON-RPC needs the context', () => {
    expect(isExempt('POST', '/v1/mcp')).toBe(false);
    expect(isExempt('POST', '/v1/autotask/mcp')).toBe(false);
  });

  it('does not exempt non-MCP /v1 paths or deeper MCP sub-paths', () => {
    expect(isExempt('GET', '/v1/autotask/tools')).toBe(false);
    expect(isExempt('GET', '/v1/autotask/mcp/extra')).toBe(false);
    expect(isExempt('GET', '/v1')).toBe(false);
  });
});
