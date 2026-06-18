import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tierGate, tierDeniedRpcMessage } from './tier-gate.js';

const mockConfig = vi.hoisted(() => ({
  features: { permissionTiers: false },
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const sqlCalls: Array<{ literals: TemplateStringsArray; values: unknown[] }> = vi.hoisted(
  () => [],
);

vi.mock('../db/context.js', () => {
  const sqlFn = (literals: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ literals, values });
    return { catch: (_handler: unknown) => undefined };
  };
  (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return {
    getSql: () => sqlFn,
  };
});

const baseCtx = {
  vendorSlug: 'autotask',
  toolName: 'autotask_create_ticket',
  orgId: 'org-1',
  actorId: 'user-1',
} as const;

beforeEach(() => {
  sqlCalls.length = 0;
  mockConfig.features.permissionTiers = false;
});

describe('tierGate — flag-off provable-no-effect', () => {
  it('returns allowed:true regardless of role/tool when flag is off', () => {
    mockConfig.features.permissionTiers = false;
    expect(tierGate({ ...baseCtx, effectiveRole: null }).allowed).toBe(true);
    expect(tierGate({ ...baseCtx, effectiveRole: 'member' }).allowed).toBe(true);
    expect(tierGate({ ...baseCtx, effectiveRole: 'owner', toolName: 'not_a_real_tool' }).allowed).toBe(true);
  });

  it('flag-off path emits NO audit (no SQL touched)', () => {
    mockConfig.features.permissionTiers = false;
    tierGate({ ...baseCtx, effectiveRole: null });
    tierGate({ ...baseCtx, effectiveRole: 'admin', toolName: 'not_a_real_tool' });
    expect(sqlCalls).toHaveLength(0);
  });
});

describe('tierGate — flag-on FAIL-CLOSED denies', () => {
  beforeEach(() => {
    mockConfig.features.permissionTiers = true;
  });

  it('DENIES with unresolvable-caller when effectiveRole is null', () => {
    const result = tierGate({ ...baseCtx, effectiveRole: null });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('unresolvable-caller');
  });

  it('DENIES with unclassified-tool when the tool is unknown', () => {
    const result = tierGate({ ...baseCtx, effectiveRole: 'admin', toolName: 'not_a_real_tool' });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('unclassified-tool');
  });

  it('DENIES with insufficient-tier when caller-tier < required-tier (member → admin tool)', () => {
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'member',
      toolName: 'autotask_raw_request', // classified admin
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('insufficient-tier');
    expect(result.callerTier).toBe('write');
    expect(result.requiredTier).toBe('admin');
  });

  it('ALLOWS when caller-tier covers required-tier (member → write tool)', () => {
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'member',
      toolName: 'autotask_create_ticket', // classified write
    });
    expect(result.allowed).toBe(true);
  });

  it('ALLOWS when owner → admin tool', () => {
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'owner',
      toolName: 'autotask_raw_request',
    });
    expect(result.allowed).toBe(true);
  });

  it('ALLOWS when admin → admin tool', () => {
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'admin',
      toolName: 'autotask_raw_request',
    });
    expect(result.allowed).toBe(true);
  });

  it('ALLOWS when member → read tool', () => {
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'member',
      toolName: 'autotask_search_companies', // classified read
    });
    expect(result.allowed).toBe(true);
  });
});

describe('tierGate — audit emission on DENY', () => {
  beforeEach(() => {
    mockConfig.features.permissionTiers = true;
  });

  it('emits an admin_audit_log INSERT on insufficient-tier DENY', () => {
    tierGate({
      ...baseCtx,
      effectiveRole: 'member',
      toolName: 'autotask_raw_request',
    });
    expect(sqlCalls).toHaveLength(1);
    const sqlText = sqlCalls[0].literals.join('');
    expect(sqlText).toContain('INSERT INTO admin_audit_log');
    expect(sqlText).toContain('event_type');
    // tier_denied event-type lands as a value, not a literal
    expect(sqlCalls[0].values).toContain('tier_denied');
  });

  it('emits an admin_audit_log INSERT on unresolvable-caller DENY', () => {
    tierGate({ ...baseCtx, effectiveRole: null });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].values).toContain('tier_denied');
  });

  it('emits an admin_audit_log INSERT on unclassified-tool DENY', () => {
    tierGate({ ...baseCtx, effectiveRole: 'admin', toolName: 'not_a_real_tool' });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].values).toContain('tier_denied');
  });

  it('audit metadata includes caller_tier + required_tier + reason for operator review', () => {
    tierGate({
      ...baseCtx,
      effectiveRole: 'member',
      toolName: 'autotask_raw_request',
    });
    const metadata = sqlCalls[0].values.find(
      (v): v is { reason: string; caller_tier: string; required_tier: string } =>
        typeof v === 'object' && v !== null && 'reason' in (v as object),
    );
    expect(metadata).toBeDefined();
    expect(metadata!.reason).toBe('insufficient-tier');
    expect(metadata!.caller_tier).toBe('write');
    expect(metadata!.required_tier).toBe('admin');
  });

  it('emits NO audit on ALLOW', () => {
    tierGate({
      ...baseCtx,
      effectiveRole: 'owner',
      toolName: 'autotask_raw_request',
    });
    expect(sqlCalls).toHaveLength(0);
  });
});

describe('tierGate — actingAs interaction', () => {
  beforeEach(() => {
    mockConfig.features.permissionTiers = true;
  });

  // Callers (router, cli-router, unified-router) MUST resolve actingAs.effectiveRole
  // before calling tier-gate. tier-gate itself only sees the resolved effectiveRole.
  // These tests document that contract: an operator acting-as a member-tier-customer
  // gets WRITE tier (the customer-role-mapping), not the operator's underlying ADMIN.
  it('operator acting-as member → write tier (gets the bound role, not their own)', () => {
    // Simulates the caller having computed effectiveRole = actingAs.effectiveRole = 'member'
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'member',
      toolName: 'autotask_raw_request', // admin tool
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toBe('insufficient-tier');
  });

  it('operator (no actingAs) → owner-tier full admin access', () => {
    const result = tierGate({
      ...baseCtx,
      effectiveRole: 'owner',
      toolName: 'autotask_raw_request',
    });
    expect(result.allowed).toBe(true);
  });
});

describe('tierDeniedRpcMessage — surface-clean, no internal-tier leak', () => {
  it('unresolvable-caller message does NOT leak that caller-tier is null', () => {
    const msg = tierDeniedRpcMessage('unresolvable-caller', 'autotask_create_ticket');
    expect(msg).toContain('autotask_create_ticket');
    expect(msg.toLowerCase()).not.toContain('null');
    expect(msg.toLowerCase()).not.toContain('admin');
  });

  it('unclassified-tool message does NOT leak required-tier', () => {
    const msg = tierDeniedRpcMessage('unclassified-tool', 'foo');
    expect(msg.toLowerCase()).not.toContain('admin');
    expect(msg.toLowerCase()).not.toContain('write');
    expect(msg.toLowerCase()).not.toContain('read');
  });

  it('insufficient-tier message does NOT leak which tier was required', () => {
    const msg = tierDeniedRpcMessage('insufficient-tier', 'autotask_raw_request');
    expect(msg).toContain('autotask_raw_request');
    expect(msg.toLowerCase()).not.toContain('admin');
    expect(msg.toLowerCase()).not.toContain('write');
  });
});
