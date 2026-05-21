import { describe, it, expect } from 'vitest';
import { checkNoInbound, registerAllowedListener } from './no-inbound-assert.js';

/** A synthetic handle shaped like a listening net.Server. */
function fakeListener(addr: string, port: number) {
  return {
    listening: true,
    address: () => ({ address: addr, port, family: 'IPv4' }),
  };
}

describe('no-inbound-assert checkNoInbound', () => {
  it('passes when there are no active handles', () => {
    const result = checkNoInbound([]);
    expect(result.ok).toBe(true);
    expect(result.unaccountedListeners).toEqual([]);
  });

  it('passes when active handles contain no listening servers', () => {
    // A non-listening handle (e.g. an outbound socket) is not a listener.
    const outboundSocket = { listening: false };
    const timer = { foo: 'bar' };
    const result = checkNoInbound([outboundSocket, timer]);
    expect(result.ok).toBe(true);
  });

  it('FAILS when an unaccounted listening server is present', () => {
    const result = checkNoInbound([fakeListener('0.0.0.0', 8080)]);
    expect(result.ok).toBe(false);
    expect(result.unaccountedListeners).toHaveLength(1);
    expect(result.unaccountedListeners[0].address).toBe('0.0.0.0:8080');
  });

  it('reports every unaccounted listener, not just the first', () => {
    const result = checkNoInbound([fakeListener('0.0.0.0', 8080), fakeListener('127.0.0.1', 9090)]);
    expect(result.ok).toBe(false);
    expect(result.unaccountedListeners).toHaveLength(2);
  });

  it('a registered listener does not count as unaccounted', () => {
    const allowed = fakeListener('127.0.0.1', 3000);
    // @ts-expect-error — fakeListener is a structural Server stand-in for the test.
    registerAllowedListener(allowed, 'test-only deliberately-allowed listener');
    const result = checkNoInbound([allowed]);
    expect(result.ok).toBe(true);
  });

  it('registerAllowedListener rejects a missing / trivial justification', () => {
    const allowed = fakeListener('127.0.0.1', 3001);
    // @ts-expect-error — structural stand-in.
    expect(() => registerAllowedListener(allowed, '')).toThrow();
    // @ts-expect-error — structural stand-in.
    expect(() => registerAllowedListener(allowed, 'short')).toThrow();
  });
});
