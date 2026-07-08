import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AccountManager } from '../src/daemon/account-manager.js';

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
