import { describe, it, expect, vi } from 'vitest';
import {
  shouldCapturePrompt,
  captureArguments,
  summarizeResponse,
} from './prompt-capture.js';
import type { BillingGate } from '../billing/gate.js';
import type { OrgService } from '../org/org-service.js';

function makeGate(canUse: boolean): BillingGate {
  return { canUsePromptCapture: vi.fn().mockResolvedValue(canUse) } as unknown as BillingGate;
}

function makeOrgService(orgEnabled: boolean): OrgService {
  return { getPromptCaptureEnabled: vi.fn().mockResolvedValue(orgEnabled) } as unknown as OrgService;
}

describe('shouldCapturePrompt', () => {
  it('returns false when orgId is null (personal scope)', async () => {
    const result = await shouldCapturePrompt(makeOrgService(true), makeGate(true), null);
    expect(result).toBe(false);
  });

  it('returns false when orgId is undefined', async () => {
    const result = await shouldCapturePrompt(makeOrgService(true), makeGate(true), undefined);
    expect(result).toBe(false);
  });

  it('returns false when plan does not allow', async () => {
    const result = await shouldCapturePrompt(makeOrgService(true), makeGate(false), 'org-1');
    expect(result).toBe(false);
  });

  it('returns false when plan allows but org has not opted in', async () => {
    const result = await shouldCapturePrompt(makeOrgService(false), makeGate(true), 'org-1');
    expect(result).toBe(false);
  });

  it('returns true when plan allows AND org has opted in', async () => {
    const result = await shouldCapturePrompt(makeOrgService(true), makeGate(true), 'org-1');
    expect(result).toBe(true);
  });
});

describe('captureArguments', () => {
  it('returns null for null/undefined', () => {
    expect(captureArguments(null)).toBeNull();
    expect(captureArguments(undefined)).toBeNull();
  });

  it('stringifies plain objects', () => {
    expect(captureArguments({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('returns null for unstringifiable values (cycles)', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(captureArguments(cyclic)).toBeNull();
  });
});

describe('summarizeResponse', () => {
  it('returns null for null/undefined', () => {
    expect(summarizeResponse(null)).toBeNull();
    expect(summarizeResponse(undefined)).toBeNull();
  });

  it('passes through small payloads unchanged', () => {
    expect(summarizeResponse({ ok: true })).toBe('{"ok":true}');
  });

  it('truncates payloads larger than 8 KB to a fixed cap with ellipsis', () => {
    const big = { data: 'x'.repeat(20_000) };
    const out = summarizeResponse(big);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(8 * 1024); // exact cap
    expect(out!.endsWith('...')).toBe(true);
  });

  it('returns null for cyclic objects', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(summarizeResponse(cyclic)).toBeNull();
  });
});
