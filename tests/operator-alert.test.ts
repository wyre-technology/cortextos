import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOperatorChatCreds } from '../src/daemon/operator-alert.js';

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
