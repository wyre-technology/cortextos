import { describe, it, expect } from 'vitest';
import {
  RelayControlPlaneClient,
  readControlPlaneConfigFromEnv,
  classifyControlPlaneBoot,
  requireControlPlaneSecret,
} from './relay-control-plane-client.js';

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

describe('classifyControlPlaneBoot', () => {
  const ORIG_URL = process.env.CONTROL_PLANE_RELAY_URL;
  const ORIG_SECRET = process.env.CONTROL_PLANE_SECRET;

  function restore() {
    if (ORIG_URL === undefined) delete process.env.CONTROL_PLANE_RELAY_URL;
    else process.env.CONTROL_PLANE_RELAY_URL = ORIG_URL;
    if (ORIG_SECRET === undefined) delete process.env.CONTROL_PLANE_SECRET;
    else process.env.CONTROL_PLANE_SECRET = ORIG_SECRET;
  }

  it('classifies BOTH-set as `wired` with the live values', () => {
    process.env.CONTROL_PLANE_RELAY_URL = 'http://internal-relay:8081';
    process.env.CONTROL_PLANE_SECRET = 'shared-secret';
    const d = classifyControlPlaneBoot();
    expect(d).toEqual({
      kind: 'wired',
      relayUrl: 'http://internal-relay:8081',
      secret: 'shared-secret',
    });
    restore();
  });

  it('classifies BOTH-absent as `unconfigured` (dev/test-friendly state)', () => {
    delete process.env.CONTROL_PLANE_RELAY_URL;
    delete process.env.CONTROL_PLANE_SECRET;
    const d = classifyControlPlaneBoot();
    expect(d).toEqual({ kind: 'unconfigured' });
    restore();
  });

  it('classifies BOTH-empty-string as `unconfigured` (empty === absent)', () => {
    process.env.CONTROL_PLANE_RELAY_URL = '';
    process.env.CONTROL_PLANE_SECRET = '';
    const d = classifyControlPlaneBoot();
    expect(d).toEqual({ kind: 'unconfigured' });
    restore();
  });

  it('classifies URL-set, SECRET-absent as `ambiguous` with named-actionable-choice', () => {
    process.env.CONTROL_PLANE_RELAY_URL = 'http://internal-relay:8081';
    delete process.env.CONTROL_PLANE_SECRET;
    const d = classifyControlPlaneBoot();
    expect(d.kind).toBe('ambiguous');
    if (d.kind === 'ambiguous') {
      expect(d.reason).toMatch(/CONTROL_PLANE_RELAY_URL is set but CONTROL_PLANE_SECRET is not/);
      expect(d.reason).toMatch(/Set BOTH .* or set NEITHER/);
    }
    restore();
  });

  it('classifies SECRET-set, URL-absent as `ambiguous` with named-actionable-choice', () => {
    delete process.env.CONTROL_PLANE_RELAY_URL;
    process.env.CONTROL_PLANE_SECRET = 'shared-secret';
    const d = classifyControlPlaneBoot();
    expect(d.kind).toBe('ambiguous');
    if (d.kind === 'ambiguous') {
      expect(d.reason).toMatch(/CONTROL_PLANE_SECRET is set but CONTROL_PLANE_RELAY_URL is not/);
      expect(d.reason).toMatch(/Set BOTH .* or set NEITHER/);
    }
    restore();
  });
});

describe('requireControlPlaneSecret', () => {
  const ORIG_SECRET = process.env.CONTROL_PLANE_SECRET;

  function restore() {
    if (ORIG_SECRET === undefined) delete process.env.CONTROL_PLANE_SECRET;
    else process.env.CONTROL_PLANE_SECRET = ORIG_SECRET;
  }

  it('returns the secret when set', () => {
    process.env.CONTROL_PLANE_SECRET = 'shared-secret';
    expect(requireControlPlaneSecret()).toBe('shared-secret');
    restore();
  });

  it('throws LOUD when env is unset', () => {
    delete process.env.CONTROL_PLANE_SECRET;
    expect(() => requireControlPlaneSecret()).toThrow(/CONTROL_PLANE_SECRET/);
    restore();
  });

  it('throws LOUD when env is empty-string (no special-case for empty)', () => {
    process.env.CONTROL_PLANE_SECRET = '';
    expect(() => requireControlPlaneSecret()).toThrow(/CONTROL_PLANE_SECRET/);
    restore();
  });
});
