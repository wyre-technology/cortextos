import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'fs';
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

  it('C1: an EXPIRED limited entry does not debounce the next limit (doom-loop fix)', () => {
    const m = mk();
    // A spent limited entry: reset time already in the past. Nothing writes
    // `healthy` back on drain-back, so this stale entry lingers on the shared
    // file. The NEXT real limit must still transition + fire callbacks.
    m.markLimited('wyretech', new Date(Date.now() - 1000));
    const seen: string[] = [];
    m.onTransition((a, h) => seen.push(`${a}:${h.status}:${h.limitedUntil}`));
    const future = new Date(Date.now() + 3_600_000);
    expect(m.markLimited('wyretech', future)).toBe(true); // NOT debounced
    expect(seen).toEqual([`wyretech:limited:${future.toISOString()}`]);
    expect(m.readHealth().wyretech.limitedUntil).toBe(future.toISOString());
  });

  it('C1: an UNEXPIRED limited entry still debounces (no double fan-out)', () => {
    const m = mk();
    const future = new Date(Date.now() + 3_600_000);
    expect(m.markLimited('wyretech', future)).toBe(true);
    expect(m.markLimited('wyretech', future)).toBe(false); // still debounced while live
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

describe('selectAccount token awareness (C2)', () => {
  const NOW = new Date('2026-07-08T00:00:00Z');

  it('with zero tokens loaded, the token check is skipped (pure-health carve-out)', () => {
    // No loadTokens() -> tokens map empty -> legacy pure-health behavior.
    writeFileSync(join(dir, 'accounts.json'), '["a","b"]');
    expect(mk().selectAccount(NOW)).toBe('a');
  });

  it('(a) skips a healthy-but-tokenless account and returns the next tokened one', () => {
    writeFileSync(join(dir, 'accounts.json'), '["a","b","c","d"]');
    const m = mk();
    m.loadTokens((n) => (n.endsWith('_A') ? null : `tok-${n}`)); // only 'a' has no token
    expect(m.selectAccount(NOW)).toBe('b');
  });

  it('(b) returns null when every usable account is tokenless (token map non-empty)', () => {
    writeFileSync(join(dir, 'accounts.json'), '["valid","invalid"]');
    const m = mk();
    // Exactly one token loaded, and it belongs to the invalid-status account —
    // so enforcement is ON but the only healthy account ('valid') has no token.
    m.loadTokens((n) => (n.endsWith('_INVALID') ? 'tok-invalid' : null));
    m.markInvalid('invalid', 'bad token');
    expect(m.selectAccount(NOW)).toBeNull();
  });

  it('(c) tokenless-first + rest limited parks with exactly one alert across two daemons (no storm)', () => {
    writeFileSync(join(dir, 'accounts.json'), '["a","b","c"]');
    const future = new Date(Date.now() + 3_600_000);
    const mkLoaded = () => {
      const m = new AccountManager({ sharedDir: dir });
      m.loadTokens((n) => (n.endsWith('_B') || n.endsWith('_C') ? `tok-${n}` : null)); // 'a' tokenless
      return m;
    };
    const d1 = mkLoaded();
    d1.markLimited('b', future);
    d1.markLimited('c', future);
    const d2 = mkLoaded();

    // Mirror AgentProcess.start()'s claude selection block: select, then verify
    // the picked account actually has a token — else the agent parks.
    const simulateStart = (m: AccountManager): 'ran' | 'parked' => {
      const acct = m.selectAccount(NOW);
      const tok = acct ? m.getToken(acct) : null;
      return acct && tok ? 'ran' : 'parked';
    };

    // 'a' is healthy but tokenless; b & c are limited -> no usable account.
    expect(simulateStart(d1)).toBe('parked');
    expect(simulateStart(d2)).toBe('parked');

    // ~18 agents split across the two daemons race to park. Before C2,
    // selectAccount returned the tokenless 'a' (non-null) and cleared the park
    // dedup flag on every call -> an alert per agent. Now it returns null and
    // the shared-file dedup holds: exactly one alert.
    let trueCount = 0;
    for (let i = 0; i < 9; i++) if (simulateStart(d1) === 'parked' && d1.shouldSendParkAlert()) trueCount++;
    for (let i = 0; i < 9; i++) if (simulateStart(d2) === 'parked' && d2.shouldSendParkAlert()) trueCount++;
    expect(trueCount).toBe(1);
  });
});

describe('token loading', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'accounts.json'), '["wyretech","personal"]');
  });
  it('fetches tokens per account and caches them (0600)', () => {
    const m = mk();
    m.loadTokens((name) => `tok-${name}`);
    expect(m.getToken('wyretech')).toBe('tok-CLAUDE_OAUTH_TOKEN_WYRETECH');
    const cachePath = join(dir, '.account-tokens.cache');
    const st = statSync(cachePath);
    expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cachePath, 'utf-8')).personal).toBe('tok-CLAUDE_OAUTH_TOKEN_PERSONAL');
  });
  it('falls back to the cache when fetch fails', () => {
    mk().loadTokens((name) => `tok-${name}`); // seed cache
    const m = mk();
    const alerts: string[] = [];
    m.onAlert((msg) => alerts.push(msg));
    m.loadTokens(() => null); // Infisical down
    expect(m.getToken('wyretech')).toBe('tok-CLAUDE_OAUTH_TOKEN_WYRETECH');
    expect(alerts.length).toBe(1);
  });
  it('maps hyphenated account names to underscore secret names', () => {
    writeFileSync(join(dir, 'accounts.json'), '["wyretech-team"]');
    const m = mk();
    m.loadTokens((name) => `tok-${name}`);
    expect(m.getToken('wyretech-team')).toBe('tok-CLAUDE_OAUTH_TOKEN_WYRETECH_TEAM');
  });
  it('runs with partial tokens and alerts about missing ones', () => {
    const m = mk();
    const alerts: string[] = [];
    m.onAlert((msg) => alerts.push(msg));
    m.loadTokens((name) => (name.endsWith('WYRETECH') ? 'tok-w' : null));
    expect(m.getToken('wyretech')).toBe('tok-w');
    expect(m.getToken('personal')).toBeNull();
    expect(alerts.some((a) => a.includes('personal'))).toBe(true);
  });
  it('does not claim cache fallback when the cache lacks the missing account', () => {
    // Seed a cache that contains ONLY wyretech
    mk().loadTokens((name) => (name.endsWith('WYRETECH') ? 'tok-w' : null));
    const m = mk();
    const alerts: string[] = [];
    m.onAlert((msg) => alerts.push(msg));
    // wyretech fetches live; personal fails and is NOT in the cache
    m.loadTokens((name) => (name.endsWith('WYRETECH') ? 'tok-w' : null));
    expect(m.getToken('personal')).toBeNull();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('personal');
    expect(alerts[0]).not.toContain('using cached');
  });
});

describe('park alert dedup', () => {
  it('first caller wins; resets when an account recovers', () => {
    writeFileSync(join(dir, 'accounts.json'), '["wyretech"]');
    const m = mk();
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    expect(m.shouldSendParkAlert()).toBe(true);
    expect(m.shouldSendParkAlert()).toBe(false);  // deduped (also across instances — persisted)
    expect(mk().shouldSendParkAlert()).toBe(false);
    m.clearParkAlert();
    expect(m.shouldSendParkAlert()).toBe(true);
  });

  it('I1: clearParkAlert() returns true only when it actually cleared a set flag', () => {
    writeFileSync(join(dir, 'accounts.json'), '["wyretech"]');
    const m = mk();
    expect(m.clearParkAlert()).toBe(false);   // nothing set yet
    expect(m.shouldSendParkAlert()).toBe(true);
    expect(m.clearParkAlert()).toBe(true);     // cleared the flag we just set
    expect(m.clearParkAlert()).toBe(false);    // already clear
  });
});
