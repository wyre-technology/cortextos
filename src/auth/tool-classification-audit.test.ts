import { describe, it, expect } from 'vitest';
import { auditToolClassification } from './tool-classification-audit.js';
import type { ToolConfig } from '../proxy/result-cache.js';

describe('auditToolClassification', () => {
  it('counts vendors, tools, and tiers over the real VENDOR_TOOL_CONFIG with no warnings', () => {
    const { stats, warnings } = auditToolClassification();
    // The shipped config is well-formed: zero structural warnings.
    expect(warnings).toEqual([]);
    expect(stats.vendors).toBeGreaterThanOrEqual(7); // the 7 pre-classified vendors
    expect(stats.tools).toBe(stats.read + stats.write + stats.admin);
    expect(stats.read).toBeGreaterThan(0);
    expect(stats.write).toBeGreaterThan(0);
  });

  it('buckets tiers correctly: admin > write > read precedence', () => {
    const config = {
      acme: {
        acme_get_thing: { entityType: 'tickets', ttlMs: 0, isWrite: false } as ToolConfig,
        acme_create_thing: { entityType: 'tickets', ttlMs: 0, isWrite: true } as ToolConfig,
        acme_manage_members: { entityType: 'tickets', ttlMs: 0, isWrite: true, isAdmin: true } as ToolConfig,
      },
    };
    const { stats } = auditToolClassification(config);
    expect(stats).toEqual({ vendors: 1, tools: 3, read: 1, write: 1, admin: 1 });
  });

  it('warns on a malformed entry (bad entityType, negative ttl, non-boolean isAdmin)', () => {
    const config = {
      acme: {
        // deliberately malformed — cast through unknown to bypass the compile-time guard
        acme_bad: { entityType: 'nope', ttlMs: -5, isWrite: true, isAdmin: 'yes' } as unknown as ToolConfig,
      },
    };
    const { warnings } = auditToolClassification(config);
    expect(warnings.some((w) => w.includes('unknown entityType'))).toBe(true);
    expect(warnings.some((w) => w.includes('ttlMs'))).toBe(true);
    expect(warnings.some((w) => w.includes('isAdmin'))).toBe(true);
  });

  it('returns zeroed stats for an empty config', () => {
    expect(auditToolClassification({})).toEqual({
      stats: { vendors: 0, tools: 0, read: 0, write: 0, admin: 0 },
      warnings: [],
    });
  });
});
