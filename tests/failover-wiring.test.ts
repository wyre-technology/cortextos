import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AccountManager } from '../src/daemon/account-manager.js';
import { AgentProcess } from '../src/daemon/agent-process.js';
import type { CtxEnv } from '../src/types/index.js';

// The full AgentProcess lifecycle needs a PTY; these tests cover the pure
// decision helpers. The end-to-end path is Task 8's integration test.
describe('failover decision flow', () => {
  it('a weekly-limit signal marks the account and reports transition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-'));
    writeFileSync(join(dir, 'accounts.json'), '["wyretech","personal"]');
    const m = new AccountManager({ sharedDir: dir });
    m.loadTokens((n) => `tok-${n}`);
    const transitions: string[] = [];
    m.onTransition((a) => transitions.push(a));

    // simulate what AgentProcess.handleLimitSignal does
    const before = m.selectAccount(new Date('2026-07-08T00:00:00Z'));
    expect(before).toBe('wyretech');
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    expect(transitions).toEqual(['wyretech']);
    expect(m.selectAccount(new Date('2026-07-08T00:00:00Z'))).toBe('personal');
  });
});

// Task 6 fix: scheduleFailoverRefresh() used to fire a bare setTimeout with no
// stored handle and no status guard. A pending timer that outlived a
// stop()/crash-halt would spawn a zombie PTY (via sessionRefresh -> start())
// invisible to the manager, or flip a halted agent back to running. These
// tests exercise the status guard directly — AgentProcess is constructed but
// start() is never called, so no real PTY is spawned (status stays 'stopped',
// its constructed default).
describe('AgentProcess.scheduleFailoverRefresh status guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start the agent when the pending timer fires after the agent is no longer running', () => {
    vi.useFakeTimers();

    const dir = mkdtempSync(join(tmpdir(), 'failover-timer-'));
    writeFileSync(join(dir, 'accounts.json'), '["wyretech"]');
    const accountManager = new AccountManager({ sharedDir: dir });

    const mockEnv: CtxEnv = {
      instanceId: 'test',
      ctxRoot: '/tmp/test-ctx',
      frameworkRoot: '/tmp/fw',
      agentName: 'alice',
      agentDir: '/tmp/fw/orgs/acme/agents/alice',
      org: 'acme',
      projectRoot: '/tmp/fw',
    };

    const ap = new AgentProcess('alice', mockEnv, {}, undefined, accountManager);
    const startSpy = vi.spyOn(ap, 'start');

    // Freshly constructed AgentProcess defaults to 'stopped' — simulates an
    // operator having stopped the agent (or a crash-halt) before the pending
    // failover timer fires.
    expect(ap.getStatus().status).toBe('stopped');

    ap.scheduleFailoverRefresh(120_000);

    // Advance past the full 0-120s jitter window.
    vi.advanceTimersByTime(120_001);

    expect(ap.getStatus().status).toBe('stopped');
    expect(startSpy).not.toHaveBeenCalled();
  });
});
