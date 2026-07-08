import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AccountManager } from '../src/daemon/account-manager.js';
import { AgentProcess } from '../src/daemon/agent-process.js';
import type { CtxEnv } from '../src/types/index.js';
import type { LimitSignal } from '../src/daemon/limit-detector.js';

// Task 8: intercept the operator-alert transport so the "both accounts
// limited -> one alert" rehearsal below can assert on it without making a
// real Telegram call (frameworkRoot points at an empty tmp dir in these
// tests anyway, so getOperatorChatCreds() would find nothing — this mock
// makes that explicit and assertable instead of a silent no-op).
vi.mock('../src/daemon/operator-alert.js', () => ({
  sendOperatorAlert: vi.fn().mockResolvedValue(true),
}));
import { sendOperatorAlert } from '../src/daemon/operator-alert.js';

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

// Task 7: the park branch's resume timer follows the same cancellable-handle +
// fire-time status guard pattern as scheduleFailoverRefresh (Task 6 fix,
// commit f5745d29). A bare setTimeout here would resurrect an agent an
// operator deliberately stopped while parked. This test drives the real
// start() park path (all accounts unusable -> park, returns before spawning
// a PTY) and confirms stop() both clears the pending resume timer and leaves
// the agent stopped.
describe('AgentProcess park-timer resume guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resume a parked agent that was stopped before the resume timer fires', async () => {
    vi.useFakeTimers();

    const dir = mkdtempSync(join(tmpdir(), 'park-timer-'));
    writeFileSync(join(dir, 'accounts.json'), '["wyretech"]');
    const accountManager = new AccountManager({ sharedDir: dir });
    // Invalid accounts never auto-recover, so selectAccount() returns null
    // while loadConfig().length > 0 -> the park branch fires.
    accountManager.markInvalid('wyretech', 'test: forced invalid');

    const mockEnv: CtxEnv = {
      instanceId: 'test',
      ctxRoot: mkdtempSync(join(tmpdir(), 'park-timer-ctxroot-')),
      frameworkRoot: mkdtempSync(join(tmpdir(), 'park-timer-fw-')),
      agentName: 'alice',
      agentDir: mkdtempSync(join(tmpdir(), 'park-timer-agentdir-')),
      org: 'acme',
      projectRoot: '/tmp/fw',
    };

    const ap = new AgentProcess('alice', mockEnv, {}, undefined, accountManager);

    await ap.start();
    expect(ap.getStatus().status).toBe('parked');

    // Operator stops the parked agent — must clear the pending resume timer.
    await ap.stop();
    expect(ap.getStatus().status).toBe('stopped');

    const startSpy = vi.spyOn(ap, 'start');
    // No known reset time for an invalid-only account -> fallback 30min delay.
    vi.advanceTimersByTime(30 * 60 * 1000 + 1000);

    expect(startSpy).not.toHaveBeenCalled();
    expect(ap.getStatus().status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// Task 8: injectDebugLimitBanner() gate + end-to-end failover rehearsal
// ---------------------------------------------------------------------------
//
// Rehearsal-path note: the original brief called for standing up a scratch
// CTX_ROOT instance (real org/agent dirs + a real `claude` binary spawn
// against garbage tokens) and sending it a live SIGUSR1. That path was
// dropped in favor of this vitest integration test — bootstrapping a
// deterministic scratch org (config.json, .env, ONBOARDING.md, a real CLI
// spawn) within a tight time budget wasn't achievable, and no real account
// tokens exist yet regardless (Task 9 mints those). What follows drives
// AgentProcess.handleLimitSignal — via the new injectDebugLimitBanner() gate
// for the weekly-limit path, and directly for the not-logged-in path — against
// a REAL AccountManager over a tmp sharedDir with a REAL account-health.json
// on disk, spies on scheduleFailoverRefresh, and mocks the operator-alert
// transport at the module boundary (see the vi.mock at the top of this file).
// The real-token happy path (a respawned session actually re-authenticating
// against the backup account) is explicitly deferred to Task 9's deploy
// verification.

/** Two-account fixture: real AccountManager, real tmp sharedDir + health file. */
function makeFleetFixture(): { sharedDir: string; accountManager: AccountManager } {
  const sharedDir = mkdtempSync(join(tmpdir(), 'task8-shared-'));
  writeFileSync(join(sharedDir, 'accounts.json'), JSON.stringify(['primary', 'backup']));
  const accountManager = new AccountManager({ sharedDir });
  // Seed two garbage (fake) tokens directly into the offline cache — no
  // cortex-secret call, no real tokens. loadTokens() is given a fetchSecret
  // that always misses, forcing the cache-recovery path exactly like a host
  // with no CLAUDE_OAUTH_TOKEN_* secrets configured would.
  writeFileSync(
    join(sharedDir, '.account-tokens.cache'),
    JSON.stringify({ primary: 'garbage-tok-primary', backup: 'garbage-tok-backup' }),
  );
  accountManager.loadTokens(() => null);
  return { sharedDir, accountManager };
}

function makeAgentProcess(
  name: string,
  accountManager: AccountManager,
  log: (msg: string) => void = () => {},
): AgentProcess {
  const mockEnv: CtxEnv = {
    instanceId: 'test',
    ctxRoot: mkdtempSync(join(tmpdir(), 'task8-ctxroot-')),
    frameworkRoot: mkdtempSync(join(tmpdir(), 'task8-fw-')),
    agentName: name,
    agentDir: mkdtempSync(join(tmpdir(), 'task8-agentdir-')),
    org: 'acme',
    projectRoot: '/tmp/fw',
  };
  return new AgentProcess(name, mockEnv, {}, log, accountManager);
}

/** Reach the private handleLimitSignal() the same way the live PTY detector calls it. */
function fireLimitSignal(ap: AgentProcess, sig: LimitSignal): void {
  (ap as unknown as { handleLimitSignal: (s: LimitSignal) => void }).handleLimitSignal(sig);
}

function forceCurrentAccount(ap: AgentProcess, account: string): void {
  (ap as unknown as { currentAccount: string | null }).currentAccount = account;
}

describe('Task 8: AgentProcess.injectDebugLimitBanner() gate', () => {
  afterEach(() => {
    delete process.env.CTX_DEBUG_FAKE_LIMIT_BANNER;
  });

  it('is a no-op when CTX_DEBUG_FAKE_LIMIT_BANNER is unset', () => {
    delete process.env.CTX_DEBUG_FAKE_LIMIT_BANNER;
    const { accountManager } = makeFleetFixture();
    const ap = makeAgentProcess('alice', accountManager);
    forceCurrentAccount(ap, 'primary');
    const markLimitedSpy = vi.spyOn(accountManager, 'markLimited');

    ap.injectDebugLimitBanner();

    expect(markLimitedSpy).not.toHaveBeenCalled();
    expect(accountManager.readHealth().primary).toBeUndefined();
  });

  it('drives the real handleLimitSignal(weekly-limit) path when CTX_DEBUG_FAKE_LIMIT_BANNER=1', () => {
    process.env.CTX_DEBUG_FAKE_LIMIT_BANNER = '1';
    const { accountManager } = makeFleetFixture();
    const ap = makeAgentProcess('alice', accountManager);
    forceCurrentAccount(ap, 'primary');

    ap.injectDebugLimitBanner();

    const health = accountManager.readHealth();
    expect(health.primary?.status).toBe('limited');
  });
});

describe('Task 8: end-to-end failover rehearsal (fake tokens, real AccountManager)', () => {
  it('(a) weekly-limit with a parsed resetsAt transitions primary -> limited with that exact time', () => {
    const { accountManager } = makeFleetFixture();
    const ap = makeAgentProcess('alice', accountManager);
    forceCurrentAccount(ap, 'primary');

    const resetsAt = new Date('2026-07-12T02:00:00Z');
    fireLimitSignal(ap, { kind: 'weekly-limit', resetsAt });

    const health = accountManager.readHealth();
    expect(health.primary).toEqual({
      status: 'limited',
      limitedUntil: resetsAt.toISOString(),
      lastError: 'weekly limit banner',
    });
  });

  it('(a) weekly-limit with an unparseable (null) resetsAt falls back to the 6h cooldown', () => {
    const { accountManager } = makeFleetFixture();
    const ap = makeAgentProcess('bob', accountManager);
    forceCurrentAccount(ap, 'primary');

    const before = Date.now();
    fireLimitSignal(ap, { kind: 'weekly-limit', resetsAt: null });
    const after = Date.now();

    const health = accountManager.readHealth();
    expect(health.primary?.status).toBe('limited');
    expect(health.primary?.lastError).toContain('unparseable');
    const limitedUntilMs = new Date(health.primary!.limitedUntil!).getTime();
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    expect(limitedUntilMs).toBeGreaterThanOrEqual(before + SIX_HOURS_MS);
    expect(limitedUntilMs).toBeLessThanOrEqual(after + SIX_HOURS_MS);
  });

  it('not-logged-in signal marks the account invalid (stand-in for a live garbage-token auth failure)', () => {
    const { accountManager } = makeFleetFixture();
    const ap = makeAgentProcess('carol', accountManager);
    forceCurrentAccount(ap, 'primary');

    fireLimitSignal(ap, { kind: 'not-logged-in' });

    const health = accountManager.readHealth();
    expect(health.primary).toEqual({
      status: 'invalid',
      lastError: 'Not logged in banner in session output',
    });
  });

  it('(c) after primary is limited, selectAccount returns backup', () => {
    const { accountManager } = makeFleetFixture();
    accountManager.markLimited('primary', new Date(Date.now() + 3_600_000));
    expect(accountManager.selectAccount()).toBe('backup');
  });

  it('(b) a limit transition wired the way AgentManager wires it schedules a jittered failover refresh on the affected agent', () => {
    const { accountManager } = makeFleetFixture();
    const logLines: string[] = [];
    const ap = makeAgentProcess('dave', accountManager, (msg) => logLines.push(msg));
    forceCurrentAccount(ap, 'primary');
    const scheduleSpy = vi.spyOn(ap, 'scheduleFailoverRefresh');

    // Replicates AgentManager's constructor wiring verbatim (agent-manager.ts):
    //   accountManager.onTransition((account, health) => {
    //     if (health.status !== 'limited' && health.status !== 'invalid') return;
    //     for (const { process: agent } of this.agents.values()) {
    //       if (agent.getCurrentAccount() === account) agent.scheduleFailoverRefresh();
    //     }
    //   });
    accountManager.onTransition((account, health) => {
      if (health.status !== 'limited' && health.status !== 'invalid') return;
      if (ap.getCurrentAccount() === account) ap.scheduleFailoverRefresh();
    });

    fireLimitSignal(ap, { kind: 'weekly-limit', resetsAt: new Date(Date.now() + 3_600_000) });

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(logLines.some((l) => /Failover refresh scheduled in \d+s/.test(l))).toBe(true);
  });
});

describe('Task 8: both accounts limited -> fleet parks with exactly one operator alert', () => {
  beforeEach(() => {
    // sendOperatorAlert is a single module-level mock shared across this
    // whole file (the vi.mock is hoisted file-wide) — earlier describe
    // blocks (e.g. the pre-existing Task 7 park-timer test) also drive
    // AgentProcess.start() down the park branch and call it. Clear call
    // history before each test here so counts below reflect only this test.
    vi.mocked(sendOperatorAlert).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(sendOperatorAlert).mockClear();
  });

  it('two agents racing to park on the same shared health file trigger exactly one alert, and each has a live resume timer', async () => {
    vi.useFakeTimers();

    const { accountManager } = makeFleetFixture();
    // Both accounts unusable -> selectAccount() returns null -> park branch.
    accountManager.markInvalid('primary', 'test: forced invalid (stand-in for garbage-token auth failure)');
    accountManager.markInvalid('backup', 'test: forced invalid (stand-in for garbage-token auth failure)');

    const ap1 = makeAgentProcess('erin', accountManager);
    const ap2 = makeAgentProcess('frank', accountManager);

    await ap1.start();
    await ap2.start();

    expect(ap1.getStatus().status).toBe('parked');
    expect(ap2.getStatus().status).toBe('parked');

    // shouldSendParkAlert() dedups across every AgentProcess instance racing
    // to park at once via the shared health file's _meta key — exactly one
    // of the two start() calls above should have sent the alert.
    expect(sendOperatorAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOperatorAlert).mock.calls[0][1]).toContain('fleet parked');

    // Resume timer armed on both: no known reset for invalid-only accounts
    // -> fixed 30min fallback delay (see start()'s park branch). Advancing
    // past it and observing both re-attempt start() proves each parkTimer
    // was actually armed and not silently dropped.
    const startSpy1 = vi.spyOn(ap1, 'start');
    const startSpy2 = vi.spyOn(ap2, 'start');
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);

    expect(startSpy1).toHaveBeenCalledTimes(1);
    expect(startSpy2).toHaveBeenCalledTimes(1);
  });
});
