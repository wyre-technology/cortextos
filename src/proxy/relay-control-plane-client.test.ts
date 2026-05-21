import { describe, it, expect } from 'vitest';
import { RelayControlPlaneClient, readControlPlaneConfigFromEnv } from './relay-control-plane-client.js';

describe('RelayControlPlaneClient construction', () => {
  it('refuses to construct without a relayUrl', () => {
    expect(
      () =>
        new RelayControlPlaneClient({
          relayUrl: '',
          secret: 'x',
        }),
    ).toThrow(/relayUrl required/);
  });

  it('refuses to construct without a secret', () => {
    expect(
      () =>
        new RelayControlPlaneClient({
          relayUrl: 'http://internal-relay:8081',
          secret: '',
        }),
    ).toThrow(/secret required/);
  });

  it('constructs with valid relayUrl + secret', () => {
    const c = new RelayControlPlaneClient({
      relayUrl: 'http://internal-relay:8081',
      secret: 'shared-secret',
    });
    expect(c).toBeDefined();
  });

  it('returns control_plane_unreachable when the relay URL DNS-fails', async () => {
    const c = new RelayControlPlaneClient({
      relayUrl: 'http://this-host-definitely-does-not-exist-19283.invalid',
      secret: 'shared-secret',
      requestTimeoutMs: 1_000,
    });
    const result = await c.route({ subtenantId: 'org-1', target: 'echo', payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('control_plane_unreachable');
  });
});

describe('readControlPlaneConfigFromEnv', () => {
  const ORIG_URL = process.env.CONTROL_PLANE_RELAY_URL;
  const ORIG_SECRET = process.env.CONTROL_PLANE_SECRET;

  function restore() {
    if (ORIG_URL === undefined) delete process.env.CONTROL_PLANE_RELAY_URL;
    else process.env.CONTROL_PLANE_RELAY_URL = ORIG_URL;
    if (ORIG_SECRET === undefined) delete process.env.CONTROL_PLANE_SECRET;
    else process.env.CONTROL_PLANE_SECRET = ORIG_SECRET;
  }

  it('returns null fields when env is unset', () => {
    delete process.env.CONTROL_PLANE_RELAY_URL;
    delete process.env.CONTROL_PLANE_SECRET;
    const c = readControlPlaneConfigFromEnv();
    expect(c).toEqual({ relayUrl: null, secret: null });
    restore();
  });

  it('treats empty-string env as unset (null, not "")', () => {
    process.env.CONTROL_PLANE_RELAY_URL = '';
    process.env.CONTROL_PLANE_SECRET = '';
    const c = readControlPlaneConfigFromEnv();
    expect(c).toEqual({ relayUrl: null, secret: null });
    restore();
  });

  it('returns both fields when both env vars are set', () => {
    process.env.CONTROL_PLANE_RELAY_URL = 'http://internal-relay:8081';
    process.env.CONTROL_PLANE_SECRET = 'shared-secret';
    const c = readControlPlaneConfigFromEnv();
    expect(c).toEqual({ relayUrl: 'http://internal-relay:8081', secret: 'shared-secret' });
    restore();
  });
});
