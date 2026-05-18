/**
 * #88 M1 — proxy header allowlist guard.
 *
 * The deprecated per-vendor proxy's reply.from rewriteRequestHeaders used
 * to forward every client header verbatim to the vendor MCP container,
 * stripping only Authorization — leaking Cookie / X-Forwarded-* /
 * arbitrary client headers into the container. The transform is now
 * buildUpstreamHeaders: a fixed allowlist (accept, content-type) + the
 * injected vendor credentials, with only mcp-session-id carried through
 * from the client.
 *
 * buildUpstreamHeaders is a pure headers-in / headers-out function, so the
 * allowlist contract is unit-testable directly — no proxy harness, no fake
 * container. The kitchen-sink test below feeds it every header a real
 * client might send and asserts the output is EXACTLY the allowlist: a
 * regression that re-spreads client headers shows up immediately as a
 * non-allowlisted key (e.g. `cookie`) in the output.
 */
import { describe, it, expect } from 'vitest';
import { buildUpstreamHeaders } from './router.js';

describe('#88 M1 — buildUpstreamHeaders allowlist', () => {
  // Everything a browser / MCP client might attach to the request.
  const KITCHEN_SINK = {
    authorization: 'Bearer gateway-jwt-should-not-leak',
    cookie: 'session=secret; csrf=abc',
    'x-forwarded-for': '203.0.113.7',
    'x-real-ip': '203.0.113.7',
    'user-agent': 'evil/1.0',
    accept: 'text/html',           // client's accept — must be overridden
    'content-type': 'text/plain',  // client's content-type — must be overridden
    'x-custom-junk': 'whatever',
  };
  const INJECTION = { 'X-Vendor-Api-Key': 'vendor-secret', 'X-Vendor-Region': 'us' };

  it('forwards only the allowlist + injected vendor credentials — no client headers', () => {
    const out = buildUpstreamHeaders(KITCHEN_SINK, INJECTION);
    expect(out).toEqual({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'X-Vendor-Api-Key': 'vendor-secret',
      'X-Vendor-Region': 'us',
    });
  });

  it('drops the dangerous client headers specifically', () => {
    const out = buildUpstreamHeaders(KITCHEN_SINK, INJECTION);
    // Named explicitly so the guard reads as intent, not just a shape match.
    expect(out.authorization).toBeUndefined();
    expect(out.cookie).toBeUndefined();
    expect(out['x-forwarded-for']).toBeUndefined();
    expect(out['x-real-ip']).toBeUndefined();
    expect(out['x-custom-junk']).toBeUndefined();
  });

  it('overrides the client-supplied accept / content-type with the MCP values', () => {
    const out = buildUpstreamHeaders(KITCHEN_SINK, {});
    expect(out.accept).toBe('application/json, text/event-stream');
    expect(out['content-type']).toBe('application/json');
  });

  it('carries mcp-session-id through when the client sends one', () => {
    // The one client header the MCP Streamable HTTP protocol needs.
    const out = buildUpstreamHeaders({ ...KITCHEN_SINK, 'mcp-session-id': 'sess-123' }, INJECTION);
    expect(out['mcp-session-id']).toBe('sess-123');
  });

  it('omits mcp-session-id when absent or empty rather than forwarding undefined', () => {
    expect(buildUpstreamHeaders({}, {})).not.toHaveProperty('mcp-session-id');
    expect(buildUpstreamHeaders({ 'mcp-session-id': '' }, {})).not.toHaveProperty('mcp-session-id');
    // An array-valued header (duplicated by the client) is not a valid
    // session id — it must not be forwarded.
    expect(buildUpstreamHeaders({ 'mcp-session-id': ['a', 'b'] }, {})).not.toHaveProperty(
      'mcp-session-id',
    );
  });
});
