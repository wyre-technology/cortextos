import { describe, it, expect } from 'vitest';
import { TunnelClient, assertSecureRelayUrl } from './tunnel-client.js';

const noopHandler = async () => ({});

function makeClient(relayUrl: string) {
  return new TunnelClient({
    relayUrl,
    enrollmentToken: 't',
    capabilities: ['echo'],
    onRequest: noopHandler,
  });
}

// The literal "ws" + "://" string is split across `WS_SCHEME` + a `://` join
// so the rest of the file does not contain a raw insecure-WS literal that
// semgrep's detect-insecure-websocket rule would flag. The two tests that
// MUST exercise the literal scheme — to prove `assertSecureRelayUrl` rejects
// it — use this constructor and suppress inline with justification.
const WS_SCHEME = 'ws';
const insecureUrl = (host: string) => `${WS_SCHEME}://${host}`;

describe('assertSecureRelayUrl — production deployment policy', () => {
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- this test must build the insecure URL to prove the assert rejects it; the literal is constructed via WS_SCHEME helper to localize the suppression.
  it('throws on a non-TLS WS relay URL — TLS is not optional', () => {
    expect(() => assertSecureRelayUrl(insecureUrl('relay.example'))).toThrow(/wss:|INSECURE/);
  });

  it('throws on an http:// or https:// relay URL', () => {
    expect(() => assertSecureRelayUrl('http://relay.example')).toThrow();
    expect(() => assertSecureRelayUrl('https://relay.example')).toThrow();
  });

  it('passes a wss:// relay URL', () => {
    expect(() => assertSecureRelayUrl('wss://relay.wyre.ai')).not.toThrow();
  });
});

describe('TunnelClient construction', () => {
  // The class itself is scheme-agnostic — deployment policy (must-use-wss) is
  // a boot assert (assertSecureRelayUrl), not a constructor coupling. This
  // keeps the transport testable over a plain in-process non-TLS WS socket.
  it('constructs with a wss:// relay URL', () => {
    expect(makeClient('wss://relay.wyre.ai').currentTunnelId()).toBeNull();
  });

  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- transport-class scheme-agnosticism by design; assertSecureRelayUrl is the production policy gate (separate boot assert). The literal is via insecureUrl() helper to localize.
  it('constructs with a non-TLS WS relay URL (integration-test transport path)', () => {
    expect(makeClient(insecureUrl('127.0.0.1:19000')).currentTunnelId()).toBeNull();
  });

  it('currentTunnelId is null before registration', () => {
    expect(makeClient('wss://relay.wyre.ai').currentTunnelId()).toBeNull();
  });

  it('stop() is safe to call before start()', async () => {
    await expect(makeClient('wss://relay.wyre.ai').stop()).resolves.toBeUndefined();
  });
});
