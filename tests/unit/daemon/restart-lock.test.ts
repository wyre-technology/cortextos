import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tryAcquireRestartLock, releaseRestartLock } from '../../../src/daemon/restart-lock.js';

describe('restart-lock — cross-path restart-in-flight guard', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'restart-lock-test-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('acquires the lock when none is held', () => {
    const r = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(r.acquired).toBe(true);
    expect(existsSync(join(stateDir, '.restart-in-flight'))).toBe(true);
  });

  it('a SECOND caller (different source) is a clean no-op while the first lock is fresh — the core cross-path race fix', () => {
    // Simulates the confirmed storm mechanism: the automated hang-detector actuator
    // acquires first; the manual/CLI restart path (a different call site entirely)
    // attempts the same agent moments later and must be blocked, not double-spawn.
    const first = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(first.acquired).toBe(true);

    const second = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(second.acquired).toBe(false);
    expect(second.reason).toMatch(/hang-detector/); // names which source is holding it, for logging
  });

  it('a SECOND caller from the SAME source is also blocked (not just cross-path — any concurrent attempt)', () => {
    const first = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(first.acquired).toBe(true);
    const second = tryAcquireRestartLock(stateDir, 'hang-detector');
    expect(second.acquired).toBe(false);
  });

  it('releaseRestartLock clears it — a subsequent acquire succeeds', () => {
    tryAcquireRestartLock(stateDir, 'hang-detector');
    releaseRestartLock(stateDir);
    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(true);
  });

  it('releaseRestartLock on an already-clear lock is a harmless no-op (no throw)', () => {
    expect(() => releaseRestartLock(stateDir)).not.toThrow();
  });

  it('a STALE lock (older than the timeout — e.g. the holder crashed mid-restart) is reclaimed, not honored forever', () => {
    // Write a lock file that's already "old" by writing a backdated timestamp directly,
    // rather than waiting in real time.
    const staleAt = Date.now() - 5 * 60_000; // 5min old — well past any real restart duration
    writeFileSync(join(stateDir, '.restart-in-flight'), JSON.stringify({ source: 'hang-detector', at: staleAt }), 'utf-8');

    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(true); // stale lock does not block forever
  });

  it('a FRESH lock (just under the staleness threshold) is still honored', () => {
    const recentAt = Date.now() - 5_000; // 5s old
    writeFileSync(join(stateDir, '.restart-in-flight'), JSON.stringify({ source: 'hang-detector', at: recentAt }), 'utf-8');

    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(false);
  });

  it('fails OPEN (acquires) on a corrupt/unparseable lock file — never blocks a real restart on lock-mechanism trouble', () => {
    writeFileSync(join(stateDir, '.restart-in-flight'), 'not valid json{{{', 'utf-8');
    const r = tryAcquireRestartLock(stateDir, 'manual-cli-restart');
    expect(r.acquired).toBe(true);
  });

  it('the lock file records the acquiring source and a fresh timestamp', () => {
    const before = Date.now();
    tryAcquireRestartLock(stateDir, 'context-handoff');
    const data = JSON.parse(readFileSync(join(stateDir, '.restart-in-flight'), 'utf-8'));
    expect(data.source).toBe('context-handoff');
    expect(data.at).toBeGreaterThanOrEqual(before);
  });
});
