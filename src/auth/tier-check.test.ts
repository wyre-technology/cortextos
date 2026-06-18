import { describe, it, expect } from 'vitest';
import {
  TIER_LEVEL,
  tierForToolConfig,
  requiredTierForTool,
  callerCanInvoke,
  type PermissionTier,
} from './tier-check.js';
import type { ToolConfig } from '../proxy/result-cache.js';

describe('TIER_LEVEL — strict superset ordering', () => {
  it('orders read < write < admin', () => {
    expect(TIER_LEVEL.read).toBeLessThan(TIER_LEVEL.write);
    expect(TIER_LEVEL.write).toBeLessThan(TIER_LEVEL.admin);
  });
});

describe('tierForToolConfig — pure mapping (every branch)', () => {
  const cfg = (over: Partial<ToolConfig>): ToolConfig => ({
    entityType: 'tickets',
    ttlMs: 0,
    isWrite: false,
    ...over,
  });

  it('null config → null (FAIL-CLOSED for unknown tool)', () => {
    expect(tierForToolConfig(null)).toBeNull();
  });

  it('isAdmin → admin (admin wins even if isWrite is false)', () => {
    expect(tierForToolConfig(cfg({ isAdmin: true, isWrite: false }))).toBe('admin');
  });

  it('isAdmin → admin (admin wins even if isWrite is true)', () => {
    expect(tierForToolConfig(cfg({ isAdmin: true, isWrite: true }))).toBe('admin');
  });

  it('isWrite (not admin) → write', () => {
    expect(tierForToolConfig(cfg({ isWrite: true }))).toBe('write');
  });

  it('read-only (no write, no admin) → read', () => {
    expect(tierForToolConfig(cfg({ isWrite: false }))).toBe('read');
  });
});

describe('requiredTierForTool — against the real VENDOR_TOOL_CONFIG', () => {
  it('classifies a known read tool as read', () => {
    expect(requiredTierForTool('autotask', 'autotask_search_tickets')).toBe('read');
  });

  it('classifies a known write tool as write', () => {
    expect(requiredTierForTool('autotask', 'autotask_create_ticket')).toBe('write');
  });

  it('returns null for an unknown vendor (FAIL-CLOSED)', () => {
    expect(requiredTierForTool('no-such-vendor', 'whatever')).toBeNull();
  });

  it('returns null for an unknown tool on a known vendor (FAIL-CLOSED)', () => {
    expect(requiredTierForTool('autotask', 'autotask_nonexistent_tool')).toBeNull();
  });
});

describe('callerCanInvoke — fail-closed tier comparison', () => {
  const read: PermissionTier = 'read';
  const write: PermissionTier = 'write';
  const admin: PermissionTier = 'admin';

  it('denies when caller tier is null (unresolvable caller)', () => {
    expect(callerCanInvoke(null, 'autotask', 'autotask_search_tickets')).toBe(false);
  });

  it('denies when tool is unknown even for an admin caller (fail-closed on tool)', () => {
    expect(callerCanInvoke(admin, 'autotask', 'autotask_nonexistent_tool')).toBe(false);
  });

  it('read caller can invoke a read tool', () => {
    expect(callerCanInvoke(read, 'autotask', 'autotask_search_tickets')).toBe(true);
  });

  it('read caller CANNOT invoke a write tool', () => {
    expect(callerCanInvoke(read, 'autotask', 'autotask_create_ticket')).toBe(false);
  });

  it('write caller can invoke both read and write tools', () => {
    expect(callerCanInvoke(write, 'autotask', 'autotask_search_tickets')).toBe(true);
    expect(callerCanInvoke(write, 'autotask', 'autotask_create_ticket')).toBe(true);
  });

  it('admin caller can invoke read and write tools (superset)', () => {
    expect(callerCanInvoke(admin, 'autotask', 'autotask_search_tickets')).toBe(true);
    expect(callerCanInvoke(admin, 'autotask', 'autotask_create_ticket')).toBe(true);
  });
});

describe('§2.5.1 superset-chain completeness — read ⊆ write ⊆ admin', () => {
  // A caller may invoke a tool iff caller-rank >= required-rank, for EVERY pairing.
  // This is the load-bearing tier invariant; lock it exhaustively while dormant.
  const tiers: PermissionTier[] = ['read', 'write', 'admin'];
  // Representative tools, one per required tier.
  const toolByRequiredTier: Record<PermissionTier, [string, string]> = {
    read: ['autotask', 'autotask_search_tickets'],
    write: ['autotask', 'autotask_create_ticket'],
    admin: ['autotask', 'autotask_create_ticket'], // overridden below via tierForToolConfig check
  };

  it('requiredTierForTool yields read for a read tool and write for a write tool', () => {
    expect(requiredTierForTool(...toolByRequiredTier.read)).toBe('read');
    expect(requiredTierForTool(...toolByRequiredTier.write)).toBe('write');
  });

  for (const caller of tiers) {
    for (const required of ['read', 'write'] as PermissionTier[]) {
      const [vendor, tool] = toolByRequiredTier[required];
      const expected = TIER_LEVEL[caller] >= TIER_LEVEL[required];
      it(`${caller} caller, ${required} tool → ${expected ? 'allow' : 'deny'}`, () => {
        expect(callerCanInvoke(caller, vendor, tool)).toBe(expected);
      });
    }
  }
});
