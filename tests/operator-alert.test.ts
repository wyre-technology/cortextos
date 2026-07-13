import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOperatorChatCreds, formatAccountTransitionAlert } from '../src/daemon/operator-alert.js';

afterEach(() => {
  delete process.env.CTX_OPERATOR_CHAT_ID;
  delete process.env.CTX_OPERATOR_BOT_TOKEN;
});

describe('getOperatorChatCreds', () => {
  it('prefers explicit operator env vars', () => {
    process.env.CTX_OPERATOR_CHAT_ID = '12345';
    process.env.CTX_OPERATOR_BOT_TOKEN = '99:AAbbCC_dd';
    expect(getOperatorChatCreds('/nonexistent')).toEqual({ chatId: '12345', botToken: '99:AAbbCC_dd' });
  });
  it('falls back to the first agent .env', () => {
    const root = mkdtempSync(join(tmpdir(), 'opalert-'));
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=11:ZZyyXX_ww\nCHAT_ID=777\n');
    expect(getOperatorChatCreds(root)).toEqual({ chatId: '777', botToken: '11:ZZyyXX_ww' });
  });
  it('returns null when nothing is configured', () => {
    expect(getOperatorChatCreds(mkdtempSync(join(tmpdir(), 'opalert2-')))).toBeNull();
  });
});

describe('formatAccountTransitionAlert (M2)', () => {
  it('limited with a parsed reset time: standard failover copy, no unparseable clause', () => {
    const msg = formatAccountTransitionAlert('wyretech', {
      status: 'limited',
      limitedUntil: '2026-07-12T02:00:00.000Z',
      lastError: 'weekly limit banner',
    });
    expect(msg).toContain('hit its weekly limit');
    expect(msg).toContain('2026-07-12T02:00:00.000Z');
    expect(msg).toContain('Fleet failing over.');
    expect(msg).not.toContain('unparseable');
  });

  it('limited with an unparseable reset time: appends the 6h-cooldown honesty clause', () => {
    const msg = formatAccountTransitionAlert('wyretech', {
      status: 'limited',
      limitedUntil: '2026-07-08T07:00:00.000Z',
      // exact lastError markLimited(null) writes
      lastError: 'weekly limit banner (reset time unparseable; 6h cooldown)',
    });
    expect(msg).toContain('(reset time unparseable — 6h cooldown)');
  });

  it('invalid: auth-broken copy carries the lastError', () => {
    const msg = formatAccountTransitionAlert('personal', {
      status: 'invalid',
      lastError: 'Not logged in banner in session output',
    });
    expect(msg).toContain('auth is broken');
    expect(msg).toContain('Not logged in banner in session output');
  });
});
