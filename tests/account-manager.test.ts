import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AccountManager } from '../src/daemon/account-manager.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acctmgr-')); });

const mk = () => new AccountManager({ sharedDir: dir });

describe('AccountManager config', () => {
  it('loads ordered account names', () => {
    writeFileSync(join(dir, 'accounts.json'), '["wyretech","personal"]');
    expect(mk().loadConfig()).toEqual(['wyretech', 'personal']);
  });
  it('returns [] when file is absent or malformed', () => {
    expect(mk().loadConfig()).toEqual([]);
    writeFileSync(join(dir, 'accounts.json'), '{not json');
    expect(mk().loadConfig()).toEqual([]);
  });
});

describe('AccountManager health transitions', () => {
  it('markLimited transitions once and persists', () => {
    const m = mk();
    const until = new Date('2026-07-12T02:00:00Z');
    expect(m.markLimited('wyretech', until)).toBe(true);
    expect(m.markLimited('wyretech', until)).toBe(false); // debounced
    const onDisk = JSON.parse(readFileSync(join(dir, 'account-health.json'), 'utf-8'));
    expect(onDisk.wyretech.status).toBe('limited');
    expect(onDisk.wyretech.limitedUntil).toBe('2026-07-12T02:00:00.000Z');
  });
  it('null reset time falls back to a ~6h cooldown', () => {
    const m = mk();
    m.markLimited('wyretech', null);
    const until = new Date(m.readHealth().wyretech.limitedUntil!);
    const hours = (until.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(5.9);
    expect(hours).toBeLessThan(6.1);
  });
  it('another instance sees the transition (shared file)', () => {
    mk().markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    expect(mk().readHealth().wyretech.status).toBe('limited');
  });
  it('markInvalid transitions and debounces', () => {
    const m = mk();
    expect(m.markInvalid('personal', 'Not logged in')).toBe(true);
    expect(m.markInvalid('personal', 'Not logged in')).toBe(false);
    expect(m.readHealth().personal.status).toBe('invalid');
  });
  it('fires onTransition only on fresh transitions', () => {
    const m = mk();
    const seen: string[] = [];
    m.onTransition((a, h) => seen.push(`${a}:${h.status}`));
    m.markLimited('wyretech', null);
    m.markLimited('wyretech', null);
    expect(seen).toEqual(['wyretech:limited']);
  });
  it('corrupt health file fails open and alerts', () => {
    writeFileSync(join(dir, 'account-health.json'), '{corrupt');
    const m = mk();
    const alerts: string[] = [];
    m.onAlert((msg) => alerts.push(msg));
    expect(m.readHealth()).toEqual({});
    expect(alerts.length).toBe(1);
  });
  it('valid-JSON-but-non-object health file fails open and alerts', () => {
    writeFileSync(join(dir, 'account-health.json'), 'null');
    const m = mk();
    const alerts: string[] = [];
    m.onAlert((msg) => alerts.push(msg));
    expect(m.readHealth()).toEqual({});
    expect(alerts.length).toBe(1);
    expect(m.markLimited('wyretech', null)).toBe(true); // downstream no longer crashes
  });
  it('earliestReset returns the soonest limitedUntil', () => {
    const m = mk();
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    m.markLimited('personal', new Date('2026-07-10T02:00:00Z'));
    expect(m.earliestReset()?.toISOString()).toBe('2026-07-10T02:00:00.000Z');
  });
});

describe('selectAccount', () => {
  const NOW = new Date('2026-07-08T00:00:00Z');
  beforeEach(() => {
    writeFileSync(join(dir, 'accounts.json'), '["wyretech","personal"]');
  });
  it('picks the first account when all healthy', () => {
    expect(mk().selectAccount(NOW)).toBe('wyretech');
  });
  it('skips a limited account', () => {
    const m = mk();
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    expect(m.selectAccount(NOW)).toBe('personal');
  });
  it('drains back after the reset time passes', () => {
    const m = mk();
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    expect(m.selectAccount(new Date('2026-07-12T02:00:01Z'))).toBe('wyretech');
  });
  it('skips invalid accounts (no auto-recovery)', () => {
    const m = mk();
    m.markInvalid('wyretech', 'Not logged in');
    expect(m.selectAccount(new Date('2027-01-01T00:00:00Z'))).toBe('personal');
  });
  it('returns null when every account is unusable', () => {
    const m = mk();
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    m.markInvalid('personal', 'Not logged in');
    expect(m.selectAccount(NOW)).toBeNull();
  });
  it('returns null with zero accounts configured', () => {
    writeFileSync(join(dir, 'accounts.json'), '[]');
    expect(mk().selectAccount(NOW)).toBeNull();
  });
});
