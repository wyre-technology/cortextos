import { describe, it, expect } from 'vitest';
import { decideOnpremRoute, type OnpremForkInputs } from './onprem-fork-decision.js';

function inputs(overrides: Partial<OnpremForkInputs> = {}): OnpremForkInputs {
  return {
    userId: 'user-1',
    orgId: 'org-1',
    onpremCaps: { tunnelId: 'tunnel-1', capabilities: ['echo'] },
    vendorSlug: 'echo',
    hasControlPlaneClient: true,
    ...overrides,
  };
}

describe('decideOnpremRoute — boss pin 4 case (a) fall_through_to_cloud', () => {
  it('returns fall_through when userId is null (unauth)', () => {
    expect(decideOnpremRoute(inputs({ userId: null })).kind).toBe('fall_through_to_cloud');
  });

  it('returns fall_through when userId is a service-client (svc:*)', () => {
    expect(
      decideOnpremRoute(inputs({ userId: 'svc:org-1:client-1' })).kind,
    ).toBe('fall_through_to_cloud');
  });

  it('returns fall_through when the user has no primary org', () => {
    expect(decideOnpremRoute(inputs({ orgId: null })).kind).toBe('fall_through_to_cloud');
  });

  it('returns fall_through when the org has no live tunnel', () => {
    expect(decideOnpremRoute(inputs({ onpremCaps: null })).kind).toBe('fall_through_to_cloud');
  });

  it('returns fall_through when the slug is NOT in tunnel.capabilities', () => {
    expect(
      decideOnpremRoute(
        inputs({
          onpremCaps: { tunnelId: 'tunnel-1', capabilities: ['echo'] },
          vendorSlug: 'datto-rmm',
        }),
      ).kind,
    ).toBe('fall_through_to_cloud');
  });

  it('canonical-slug-match: case-different slug does NOT match (pin 3)', () => {
    // capabilities are 'echo'; vendor slug 'Echo' must NOT match — exact byte equality.
    expect(
      decideOnpremRoute(
        inputs({
          onpremCaps: { tunnelId: 'tunnel-1', capabilities: ['echo'] },
          vendorSlug: 'Echo',
        }),
      ).kind,
    ).toBe('fall_through_to_cloud');
  });

  it('canonical-slug-match: prefix-overlap does NOT match (pin 3)', () => {
    // 'echo-server' is not 'echo' — no fuzzy/prefix match.
    expect(
      decideOnpremRoute(
        inputs({
          onpremCaps: { tunnelId: 'tunnel-1', capabilities: ['echo-server'] },
          vendorSlug: 'echo',
        }),
      ).kind,
    ).toBe('fall_through_to_cloud');
  });
});

describe('decideOnpremRoute — boss pin 4 case (b) configured_but_unreachable', () => {
  // The regression-loud anchor: (b) is the case that's easiest to silently
  // regress into (c)-with-fallthrough-to-cloud. This is the test that pins
  // "do NOT fall through to cloud when control-plane absent."
  it('returns configured_but_unreachable when slug IS in caps but no control-plane client', () => {
    const decision = decideOnpremRoute(inputs({ hasControlPlaneClient: false }));
    expect(decision.kind).toBe('configured_but_unreachable');
  });

  it('does NOT return fall_through_to_cloud when (b) — operator-choice preservation', () => {
    // The whole point of (b): the operator deliberately registered an on-prem
    // capability; a missing control-plane client on this gateway instance
    // does NOT silently revert to cloud routing.
    const decision = decideOnpremRoute(inputs({ hasControlPlaneClient: false }));
    expect(decision.kind).not.toBe('fall_through_to_cloud');
    expect(decision.kind).not.toBe('dispatch_via_control_plane');
  });
});

describe('decideOnpremRoute — boss pin 4 case (c) dispatch_via_control_plane', () => {
  it('returns dispatch_via_control_plane when slug in caps + client present', () => {
    const decision = decideOnpremRoute(inputs());
    expect(decision.kind).toBe('dispatch_via_control_plane');
    if (decision.kind === 'dispatch_via_control_plane') {
      expect(decision.subtenantId).toBe('org-1');
      expect(decision.tunnelId).toBe('tunnel-1');
    }
  });

  it('carries the resolved tunnel id from onpremCaps, not from elsewhere', () => {
    const decision = decideOnpremRoute(
      inputs({ onpremCaps: { tunnelId: 'tunnel-from-caps', capabilities: ['echo'] } }),
    );
    if (decision.kind === 'dispatch_via_control_plane') {
      expect(decision.tunnelId).toBe('tunnel-from-caps');
    } else {
      throw new Error('expected dispatch_via_control_plane');
    }
  });

  it('handles multi-capability tunnels — any granted slug dispatches', () => {
    for (const slug of ['echo', 'ldap', 'sql']) {
      const decision = decideOnpremRoute(
        inputs({
          onpremCaps: { tunnelId: 'multi', capabilities: ['echo', 'ldap', 'sql'] },
          vendorSlug: slug,
        }),
      );
      expect(decision.kind).toBe('dispatch_via_control_plane');
    }
  });
});

describe('decideOnpremRoute — discriminated-union exhaustiveness', () => {
  // The three case-kinds are the ONLY three a caller has to handle.
  it('every input produces exactly one of the three discriminants', () => {
    const cases: OnpremForkInputs[] = [
      inputs(),
      inputs({ hasControlPlaneClient: false }),
      inputs({ orgId: null }),
      inputs({ onpremCaps: null }),
      inputs({ vendorSlug: 'not-in-caps' }),
      inputs({ userId: null }),
      inputs({ userId: 'svc:o:c' }),
    ];
    for (const c of cases) {
      const d = decideOnpremRoute(c);
      expect(['fall_through_to_cloud', 'configured_but_unreachable', 'dispatch_via_control_plane']).toContain(d.kind);
    }
  });
});
