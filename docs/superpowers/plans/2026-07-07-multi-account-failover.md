# Multi-Account Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the active Claude account hits its weekly usage limit, the fleet fails over to the next healthy account, alerts the operator once, and drains back automatically after reset.

**Architecture:** A pure `LimitDetector` watches each Claude PTY's output stream for the two known failure signatures. A per-daemon `AccountManager` owns the ordered account list, tokens (from Infisical via `cortex-secret`), and a health map shared across daemon instances via an atomic JSON file. Account selection runs at every session spawn, so failover, initial assignment, and drain-back are one code path.

**Tech Stack:** TypeScript (strict), vitest, tsup build, node-pty, existing `TelegramAPI` (`src/telegram/api.ts`).

**Spec:** `docs/superpowers/specs/2026-07-07-multi-account-failover-design.md`

## Global Constraints

- Claude PTYs only (`AgentPTY`); Hermes/Codex runtimes out of scope.
- Shared paths: config `~/.cortextos/shared/accounts.json`, health `~/.cortextos/shared/account-health.json`, token cache `~/.cortextos/shared/.account-tokens.cache` (chmod 600). Resolve `~` via `os.homedir()`; never hardcode `/Users/asachs`.
- Tokens never enter git, logs, or error messages. Log account *names* only.
- All health-file writes atomic (write tmp file, `renameSync` over target).
- Every "can't decide" path degrades to pre-failover behavior + operator alert. No silent stalls.
- Zero accounts configured → behave exactly as today (no token injection, warning log only). This keeps every existing install working.
- Weekly-limit reset parse failure → 6-hour cooldown.
- Failover session refreshes get 0–120 s random jitter.
- Conventional commits; update `CHANGELOG.md` (keepachangelog format) in the final task.
- Run `npm run typecheck` before every commit (repo has no separate lint).

---

### Task 1: Limit detector (pure module)

**Files:**
- Create: `src/daemon/limit-detector.ts`
- Test: `tests/limit-detector.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type LimitSignal = { kind: 'weekly-limit'; resetsAt: Date | null } | { kind: 'not-logged-in' }`
  - `parseResetTime(text: string, now: Date): Date | null`
  - `class LimitDetector { feed(chunk: string): LimitSignal | null; reset(): void }`
    — `feed` is called with raw PTY chunks (ANSI-laden, arbitrary fragment boundaries); fires each signal kind at most once until `reset()` (called on new session spawn).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/limit-detector.test.ts
import { describe, it, expect } from 'vitest';
import { LimitDetector, parseResetTime } from '../src/daemon/limit-detector.js';

// Real fixtures captured from ~/.cortextos/default/logs/boss/stdout.log
// during the 2026-07-06/07 outage. Do not "clean up" the escapes.
const BANNER_RAW =
  "\x1b[38;5;246m  ⎿  \x1b[38;5;211mYou've hit your weekly limit · resets Jul 12 at 2am (UTC)\x1b[1B\x1b[39m\n" +
  '     /usage-credits to finish what you’re working on.';
const NOT_LOGGED_IN_RAW = '\x1b[38;5;211mNot logged in · Please run /login\x1b[39m';
const NOW = new Date('2026-07-07T04:00:00Z');

describe('parseResetTime', () => {
  it('parses "Jul 12 at 2am (UTC)" against current year', () => {
    expect(parseResetTime('resets Jul 12 at 2am (UTC)', NOW)?.toISOString())
      .toBe('2026-07-12T02:00:00.000Z');
  });
  it('parses minutes and pm', () => {
    expect(parseResetTime('resets Jul 12 at 2:30pm (UTC)', NOW)?.toISOString())
      .toBe('2026-07-12T14:30:00.000Z');
  });
  it('handles 12am and 12pm correctly', () => {
    expect(parseResetTime('resets Jul 12 at 12am (UTC)', NOW)?.toISOString())
      .toBe('2026-07-12T00:00:00.000Z');
    expect(parseResetTime('resets Jul 12 at 12pm (UTC)', NOW)?.toISOString())
      .toBe('2026-07-12T12:00:00.000Z');
  });
  it('rolls to next year when the date already passed', () => {
    expect(parseResetTime('resets Jan 2 at 2am (UTC)', NOW)?.toISOString())
      .toBe('2027-01-02T02:00:00.000Z');
  });
  it('returns null on garbage', () => {
    expect(parseResetTime('resets whenever lol', NOW)).toBeNull();
  });
});

describe('LimitDetector', () => {
  it('detects the weekly-limit banner in raw ANSI output', () => {
    const d = new LimitDetector(NOW);
    const sig = d.feed(BANNER_RAW);
    expect(sig).toEqual({ kind: 'weekly-limit', resetsAt: new Date('2026-07-12T02:00:00.000Z') });
  });
  it('detects across chunk boundaries', () => {
    const d = new LimitDetector(NOW);
    const mid = Math.floor(BANNER_RAW.length / 2);
    expect(d.feed(BANNER_RAW.slice(0, mid))).toBeNull();
    expect(d.feed(BANNER_RAW.slice(mid))?.kind).toBe('weekly-limit');
  });
  it('fires each kind once until reset()', () => {
    const d = new LimitDetector(NOW);
    expect(d.feed(BANNER_RAW)?.kind).toBe('weekly-limit');
    expect(d.feed(BANNER_RAW)).toBeNull();
    d.reset();
    expect(d.feed(BANNER_RAW)?.kind).toBe('weekly-limit');
  });
  it('detects not-logged-in', () => {
    const d = new LimitDetector(NOW);
    expect(d.feed(NOT_LOGGED_IN_RAW)).toEqual({ kind: 'not-logged-in' });
  });
  it('ignores normal output', () => {
    const d = new LimitDetector(NOW);
    expect(d.feed('[boss] Injected 1047 bytes\nCogitating…')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/limit-detector.test.ts`
Expected: FAIL — cannot find module `../src/daemon/limit-detector.js`.

- [ ] **Step 3: Implement**

```typescript
// src/daemon/limit-detector.ts
export type LimitSignal =
  | { kind: 'weekly-limit'; resetsAt: Date | null }
  | { kind: 'not-logged-in' };

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Whitespace-tolerant: TUI cursor-positioning can perturb spacing.
const RESET_RE = /resets\s*([A-Za-z]{3})\s*(\d{1,2})\s*at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i;
const WEEKLY_RE = /You'?ve\s*hit\s*your\s*weekly\s*limit/i;
const NOT_LOGGED_IN_RE = /Not\s*logged\s*in\s*·\s*Please\s*run\s*\/login/i;

function stripAnsi(s: string): string {
  // CSI sequences, OSC sequences, and bare carriage returns.
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '\n');
}

export function parseResetTime(text: string, now: Date): Date | null {
  const m = stripAnsi(text).match(RESET_RE);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[2], 10);
  let hour = parseInt(m[3], 10) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const minute = m[4] ? parseInt(m[4], 10) : 0;
  let d = new Date(Date.UTC(now.getUTCFullYear(), month, day, hour, minute));
  // Reset times are always in the future; a past date means year rollover.
  if (d.getTime() < now.getTime() - 60 * 60 * 1000) {
    d = new Date(Date.UTC(now.getUTCFullYear() + 1, month, day, hour, minute));
  }
  return d;
}

const TAIL_CHARS = 2000;

export class LimitDetector {
  private tail = '';
  private fired = new Set<LimitSignal['kind']>();

  constructor(private nowFn: Date | (() => Date) = () => new Date()) {}

  private now(): Date {
    return typeof this.nowFn === 'function' ? this.nowFn() : this.nowFn;
  }

  reset(): void {
    this.tail = '';
    this.fired.clear();
  }

  feed(chunk: string): LimitSignal | null {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-TAIL_CHARS);
    if (!this.fired.has('weekly-limit') && WEEKLY_RE.test(this.tail)) {
      this.fired.add('weekly-limit');
      return { kind: 'weekly-limit', resetsAt: parseResetTime(this.tail, this.now()) };
    }
    if (!this.fired.has('not-logged-in') && NOT_LOGGED_IN_RE.test(this.tail)) {
      this.fired.add('not-logged-in');
      return { kind: 'not-logged-in' };
    }
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/limit-detector.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/daemon/limit-detector.ts tests/limit-detector.test.ts && git commit -m "feat(failover): add limit-signal detector with real outage fixtures"
```

---

### Task 2: AccountManager — config, health state, transitions

**Files:**
- Create: `src/daemon/account-manager.ts`
- Test: `tests/account-manager.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (tokens arrive in Task 4).
- Produces (used by Tasks 3–7):
  - `interface AccountHealth { status: 'healthy' | 'limited' | 'invalid'; limitedUntil?: string; lastError?: string }`
  - `class AccountManager`:
    - `constructor(opts?: { sharedDir?: string; log?: (msg: string) => void })` — `sharedDir` defaults to `join(os.homedir(), '.cortextos', 'shared')`; tests pass a tmp dir.
    - `loadConfig(): string[]` — ordered names from `accounts.json`; `[]` if absent/malformed.
    - `readHealth(): Record<string, AccountHealth>` — re-reads file each call; corrupt file → `{}` (fail open) + rewrite + `onAlert`.
    - `markLimited(account: string, until: Date | null): boolean` — returns `true` only on a fresh transition (debounce). `null` until → now + 6 h.
    - `markInvalid(account: string, error: string): boolean` — same debounce contract.
    - `earliestReset(): Date | null` — min `limitedUntil` across limited accounts; `null` if none limited.
    - `onTransition(cb: (account: string, health: AccountHealth) => void): void`
    - `onAlert(cb: (message: string) => void): void` — transport attached in Task 5.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/account-manager.test.ts
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
  it('earliestReset returns the soonest limitedUntil', () => {
    const m = mk();
    m.markLimited('wyretech', new Date('2026-07-12T02:00:00Z'));
    m.markLimited('personal', new Date('2026-07-10T02:00:00Z'));
    expect(m.earliestReset()?.toISOString()).toBe('2026-07-10T02:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/daemon/account-manager.ts
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface AccountHealth {
  status: 'healthy' | 'limited' | 'invalid';
  limitedUntil?: string;
  lastError?: string;
}

type HealthMap = Record<string, AccountHealth>;
const FALLBACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export class AccountManager {
  private sharedDir: string;
  private log: (msg: string) => void;
  private transitionCbs: Array<(account: string, health: AccountHealth) => void> = [];
  private alertCbs: Array<(message: string) => void> = [];

  constructor(opts: { sharedDir?: string; log?: (msg: string) => void } = {}) {
    this.sharedDir = opts.sharedDir ?? join(homedir(), '.cortextos', 'shared');
    this.log = opts.log ?? ((msg) => console.log(`[account-manager] ${msg}`));
    mkdirSync(this.sharedDir, { recursive: true });
  }

  onTransition(cb: (account: string, health: AccountHealth) => void): void {
    this.transitionCbs.push(cb);
  }

  onAlert(cb: (message: string) => void): void {
    this.alertCbs.push(cb);
  }

  private alert(message: string): void {
    this.log(`ALERT: ${message}`);
    for (const cb of this.alertCbs) {
      try { cb(message); } catch { /* alert transport must never break state */ }
    }
  }

  loadConfig(): string[] {
    const file = join(this.sharedDir, 'accounts.json');
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
      this.log(`accounts.json is not a string array; ignoring`);
      return [];
    } catch (err) {
      this.log(`accounts.json unreadable: ${err}`);
      return [];
    }
  }

  private healthFile(): string {
    return join(this.sharedDir, 'account-health.json');
  }

  readHealth(): HealthMap {
    const file = this.healthFile();
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as HealthMap;
    } catch {
      // Fail open: all accounts treated healthy. Rewrite so we only alert once.
      this.writeHealth({});
      this.alert('account-health.json was corrupt — reset to empty (all accounts treated healthy)');
      return {};
    }
  }

  private writeHealth(map: HealthMap): void {
    const file = this.healthFile();
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
    renameSync(tmp, file);
  }

  private transition(account: string, next: AccountHealth): boolean {
    const map = this.readHealth();
    const prev = map[account];
    if (prev && prev.status === next.status) return false; // debounce
    map[account] = next;
    this.writeHealth(map);
    for (const cb of this.transitionCbs) {
      try { cb(account, next); } catch (err) { this.log(`transition callback failed: ${err}`); }
    }
    return true;
  }

  markLimited(account: string, until: Date | null): boolean {
    const limitedUntil = (until ?? new Date(Date.now() + FALLBACK_COOLDOWN_MS)).toISOString();
    return this.transition(account, {
      status: 'limited',
      limitedUntil,
      lastError: until ? 'weekly limit banner' : 'weekly limit banner (reset time unparseable; 6h cooldown)',
    });
  }

  markInvalid(account: string, error: string): boolean {
    return this.transition(account, { status: 'invalid', lastError: error });
  }

  earliestReset(): Date | null {
    const map = this.readHealth();
    const times = Object.values(map)
      .filter((h) => h.status === 'limited' && h.limitedUntil)
      .map((h) => new Date(h.limitedUntil!).getTime());
    return times.length ? new Date(Math.min(...times)) : null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/daemon/account-manager.ts tests/account-manager.test.ts && git commit -m "feat(failover): AccountManager with shared atomic health state"
```

---

### Task 3: `selectAccount()` — Aaron's contribution

**Files:**
- Modify: `src/daemon/account-manager.ts` (add one method)
- Test: `tests/account-manager.test.ts` (append)

**Interfaces:**
- Consumes: `loadConfig()`, `readHealth()` from Task 2.
- Produces: `selectAccount(now?: Date): string | null` — name of the account the next spawn should use, or `null` when nothing usable. Tasks 6–7 call this.

**⚠️ Execution note:** The tests below define the agreed contract — write and commit them first. Then STOP and ask Aaron to implement the method body (~8 lines); this was reserved as his contribution during design review. The reference implementation below is the fallback if he defers, and the comparison point if his differs (a difference that passes the tests is fine — it's his policy call).

- [ ] **Step 1: Write the failing tests (append to tests/account-manager.test.ts)**

```typescript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts -t selectAccount`
Expected: FAIL — `selectAccount is not a function`.

- [ ] **Step 3: Commit the tests, then request Aaron's implementation**

```bash
cd /Users/asachs/cortextos && git add tests/account-manager.test.ts && git commit -m "test(failover): selectAccount policy contract"
```

Ask Aaron to implement `selectAccount` in `src/daemon/account-manager.ts`. Reference implementation (fallback only):

```typescript
  /**
   * Pick the account the next session spawn should use.
   * Policy: strict preference order; a limited account becomes eligible
   * again the moment its limitedUntil passes; invalid accounts never
   * auto-recover (operator must fix the token and clear the entry).
   */
  selectAccount(now: Date = new Date()): string | null {
    const health = this.readHealth();
    for (const name of this.loadConfig()) {
      const h = health[name];
      if (!h || h.status === 'healthy') return name;
      if (h.status === 'limited' && h.limitedUntil && new Date(h.limitedUntil) <= now) return name;
    }
    return null;
  }
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/daemon/account-manager.ts && git commit -m "feat(failover): selectAccount preference policy"
```

---

### Task 4: Token loading (Infisical + offline cache)

**Files:**
- Modify: `src/daemon/account-manager.ts`
- Test: `tests/account-manager.test.ts` (append)

**Interfaces:**
- Consumes: `loadConfig()` (Task 2).
- Produces:
  - `loadTokens(fetchSecret?: (name: string) => string | null): void` — call once at daemon boot. Default `fetchSecret` shells out to `cortex-secret get CLAUDE_OAUTH_TOKEN_<UPPERCASED_NAME>`; tests inject a fake.
  - `getToken(account: string): string | null`
  - Cache file `.account-tokens.cache` in `sharedDir` — JSON `{name: token}`, chmod `0o600`, written after each successful fetch, read as fallback when a fetch fails.

- [ ] **Step 1: Write the failing tests (append)**

```typescript
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
  it('runs with partial tokens and alerts about missing ones', () => {
    const m = mk();
    const alerts: string[] = [];
    m.onAlert((msg) => alerts.push(msg));
    m.loadTokens((name) => (name.endsWith('WYRETECH') ? 'tok-w' : null));
    expect(m.getToken('wyretech')).toBe('tok-w');
    expect(m.getToken('personal')).toBeNull();
    expect(alerts.some((a) => a.includes('personal'))).toBe(true);
  });
});
```

Add `statSync` to the fs import line at the top of the test file.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts -t "token loading"`
Expected: FAIL — `loadTokens is not a function`.

- [ ] **Step 3: Implement (add to AccountManager)**

```typescript
// Add imports at top of account-manager.ts:
import { spawnSync } from 'child_process';
import { statSync, chmodSync } from 'fs';  // merge into existing fs import

// Add fields:
  private tokens: Record<string, string> = {};

// Add methods:
  private defaultFetchSecret(secretName: string): string | null {
    const r = spawnSync('cortex-secret', ['get', secretName], { encoding: 'utf-8', timeout: 15000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    return null;
  }

  private cacheFile(): string {
    return join(this.sharedDir, '.account-tokens.cache');
  }

  loadTokens(fetchSecret?: (secretName: string) => string | null): void {
    const fetch = fetchSecret ?? ((n: string) => this.defaultFetchSecret(n));
    const missing: string[] = [];
    for (const name of this.loadConfig()) {
      const secretName = `CLAUDE_OAUTH_TOKEN_${name.toUpperCase()}`;
      const tok = fetch(secretName);
      if (tok) this.tokens[name] = tok;
      else missing.push(name);
    }
    if (missing.length > 0 && existsSync(this.cacheFile())) {
      try {
        const cached = JSON.parse(readFileSync(this.cacheFile(), 'utf-8')) as Record<string, string>;
        for (const name of [...missing]) {
          if (cached[name]) {
            this.tokens[name] = cached[name];
            missing.splice(missing.indexOf(name), 1);
          }
        }
        this.alert('token fetch failed for some accounts — using cached tokens');
      } catch { /* cache unreadable; missing stays as-is */ }
    }
    if (missing.length > 0) {
      this.alert(`no token available for account(s): ${missing.join(', ')} — they will be skipped`);
    }
    if (Object.keys(this.tokens).length > 0) {
      const tmp = `${this.cacheFile()}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.tokens), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmp, this.cacheFile());
      chmodSync(this.cacheFile(), 0o600); // rename preserves tmp mode, but be explicit
    }
  }

  getToken(account: string): string | null {
    return this.tokens[account] ?? null;
  }
```

Note the alert-count expectation in the fallback test: the cache covers all missing accounts, so only the "using cached tokens" alert fires. In the partial test the cache is empty, so only the "no token available" alert fires.

- [ ] **Step 4: Run tests**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/daemon/account-manager.ts tests/account-manager.test.ts && git commit -m "feat(failover): token loading via cortex-secret with 0600 offline cache"
```

---

### Task 5: Operator alert transport

**Files:**
- Create: `src/daemon/operator-alert.ts`
- Modify: `src/daemon/index.ts` (extract `getOperatorChatCreds`, currently defined around line 113; keep its curl-based crash path)
- Test: `tests/operator-alert.test.ts`

**Interfaces:**
- Consumes: `TelegramAPI` from `src/telegram/api.ts` (existing; `new TelegramAPI(botToken)`, `.sendMessage(chatId, text): Promise<...>`).
- Produces:
  - `getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null` — moved verbatim from `src/daemon/index.ts` (env `CTX_OPERATOR_CHAT_ID`/`CTX_OPERATOR_BOT_TOKEN` first, first agent `.env` fallback).
  - `sendOperatorAlert(frameworkRoot: string, message: string): Promise<boolean>` — best-effort, never throws.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/operator-alert.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/operator-alert.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Move the entire `getOperatorChatCreds` function body from `src/daemon/index.ts` into the new module unchanged (it is pure fs/env logic), then add the sender:

```typescript
// src/daemon/operator-alert.ts
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { TelegramAPI } from '../telegram/api.js';

export function getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
  // <moved verbatim from src/daemon/index.ts — do not edit the logic>
}

export async function sendOperatorAlert(frameworkRoot: string, message: string): Promise<boolean> {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error(`[operator-alert] no operator chat configured; dropping alert: ${message.slice(0, 120)}`);
    return false;
  }
  try {
    await new TelegramAPI(creds.botToken).sendMessage(creds.chatId, message);
    return true;
  } catch (err) {
    console.error(`[operator-alert] send failed: ${err}`);
    return false;
  }
}
```

In `src/daemon/index.ts`: delete the local `getOperatorChatCreds` definition and add `import { getOperatorChatCreds } from './operator-alert.js';`. The crash-loop curl path keeps working unchanged.

- [ ] **Step 4: Run tests**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/operator-alert.test.ts && npm run typecheck`
Expected: PASS; typecheck confirms index.ts still compiles.

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/daemon/operator-alert.ts src/daemon/index.ts tests/operator-alert.test.ts && git commit -m "refactor(failover): extract operator alert transport for reuse"
```

---

### Task 6: Wire detection, token injection, and jittered failover into the agent lifecycle

**Files:**
- Modify: `src/types/index.ts:587` (`CtxEnv` — add `oauthToken?: string`)
- Modify: `src/pty/agent-pty.ts` (inject token into ptyEnv; expose limit-signal callback from the `onData` handler at ~line 157)
- Modify: `src/daemon/agent-process.ts` (ctor param, spawn-time selection, signal handler, jittered refresh)
- Modify: `src/daemon/agent-manager.ts` (own the AccountManager, register the transition fan-out; find construction sites with `grep -n "new AgentProcess(" src/daemon/agent-manager.ts`)
- Modify: `src/daemon/index.ts` (instantiate AccountManager at boot: `loadTokens()`, wire `onAlert` → `sendOperatorAlert`; find the AgentManager construction with `grep -n "new AgentManager(" src/daemon/index.ts`)
- Test: `tests/failover-wiring.test.ts`

**Interfaces:**
- Consumes: `LimitDetector`/`LimitSignal` (Task 1), `AccountManager.selectAccount/getToken/markLimited/markInvalid/onTransition` (Tasks 2–4), `sendOperatorAlert` (Task 5).
- Produces:
  - `CtxEnv.oauthToken?: string` — read by `AgentPTY.spawn()`.
  - `AgentPTY.onLimitSignal(cb: (sig: LimitSignal) => void): void`
  - `AgentProcess` ctor gains optional 5th param `accountManager?: AccountManager`.
  - `AgentProcess.getCurrentAccount(): string | null`
  - `AgentProcess.scheduleFailoverRefresh(maxJitterMs?: number): void`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/failover-wiring.test.ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/failover-wiring.test.ts`
Expected: PASS already (it exercises Tasks 2–4) — this test pins the contract the wiring below relies on. Proceed.

- [ ] **Step 3: Make the five code changes**

**(a) `src/types/index.ts`** — inside `interface CtxEnv` (line 587), add:

```typescript
  /** OAuth token selected by AccountManager for this spawn; injected as CLAUDE_CODE_OAUTH_TOKEN. */
  oauthToken?: string;
```

**(b) `src/pty/agent-pty.ts`** — two edits.

After the agent `.env` sourcing block in `spawn()` (the block ending `ptyEnv[trimmed.slice(0, eqIdx).trim()] = ...`; dynamic selection must override any static token in `.env`):

```typescript
    // Multi-account failover: token chosen by AccountManager for this spawn.
    // Placed after .env sourcing so a dynamically selected account wins over
    // a static CLAUDE_CODE_OAUTH_TOKEN in the agent's .env.
    if (this.env.oauthToken) {
      ptyEnv['CLAUDE_CODE_OAUTH_TOKEN'] = this.env.oauthToken;
    }
```

In the `onData` handler (~line 157, where `this.outputBuffer.push(data)` happens), feed the detector; add the field, the registration method, and reset on spawn:

```typescript
// imports:
import { LimitDetector, LimitSignal } from '../daemon/limit-detector.js';

// fields:
  private limitDetector = new LimitDetector();
  private limitSignalCb: ((sig: LimitSignal) => void) | null = null;

// public method:
  onLimitSignal(cb: (sig: LimitSignal) => void): void {
    this.limitSignalCb = cb;
  }

// at the top of spawn(), before creating the pty:
    this.limitDetector.reset();

// inside the existing onData handler, after this.outputBuffer.push(data):
      const limitSig = this.limitDetector.feed(data);
      if (limitSig && this.limitSignalCb) {
        try { this.limitSignalCb(limitSig); } catch { /* handler must not kill the data pump */ }
      }
```

**(c) `src/daemon/agent-process.ts`** — four edits.

Constructor (line 73): add optional param and field:

```typescript
  private accountManager: AccountManager | null;
  private currentAccount: string | null = null;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn, accountManager?: AccountManager) {
    // ...existing body unchanged...
    this.accountManager = accountManager ?? null;
  }
```

In `start()`, immediately before the PTY construction (`this.pty = this.config.runtime === 'hermes' ? ...`):

```typescript
    // Multi-account failover: pick the account for this session.
    if (this.accountManager) {
      const account = this.accountManager.selectAccount();
      const token = account ? this.accountManager.getToken(account) : null;
      if (account && token) {
        this.currentAccount = account;
        this.env.oauthToken = token;
        this.log(`Using account "${account}"`);
      } else if (this.accountManager.loadConfig().length > 0) {
        // Accounts are configured but none usable → park (Task 7 fills this in).
        this.currentAccount = null;
        this.env.oauthToken = undefined;
      } else {
        // Zero accounts configured: legacy behavior, no token injection.
        this.currentAccount = null;
        this.env.oauthToken = undefined;
      }
    }
```

After the PTY is constructed (next to the existing Codex Telegram re-wire), register the signal handler for Claude PTYs:

```typescript
    if (this.pty instanceof AgentPTY) {
      this.pty.onLimitSignal((sig) => this.handleLimitSignal(sig));
    }
```

New methods (place after `sessionRefresh()`):

```typescript
  private handleLimitSignal(sig: import('./limit-detector.js').LimitSignal): void {
    if (!this.accountManager || !this.currentAccount) return;
    if (sig.kind === 'weekly-limit') {
      this.log(`Weekly limit detected on account "${this.currentAccount}" (resets ${sig.resetsAt?.toISOString() ?? 'unknown'})`);
      this.accountManager.markLimited(this.currentAccount, sig.resetsAt);
    } else {
      this.log(`Auth failure detected on account "${this.currentAccount}"`);
      this.accountManager.markInvalid(this.currentAccount, 'Not logged in banner in session output');
    }
    // The AgentManager transition fan-out refreshes every affected agent,
    // including this one — no self-refresh here (avoids double refresh).
  }

  getCurrentAccount(): string | null {
    return this.currentAccount;
  }

  /** Session refresh with random jitter — avoids thundering-herd 429s when a whole fleet fails over. */
  scheduleFailoverRefresh(maxJitterMs = 120_000): void {
    const jitter = Math.floor(Math.random() * maxJitterMs);
    this.log(`Failover refresh scheduled in ${Math.round(jitter / 1000)}s`);
    setTimeout(() => {
      this.sessionRefresh().catch((err) => this.log(`Failover refresh failed: ${err}`));
    }, jitter);
  }
```

Also extend the `.session-refresh` marker: `sessionRefresh()` currently writes the literal `'session-time-cap rollover\n'`. Change the signature to `async sessionRefresh(reason = 'session-time-cap rollover'): Promise<void>` and write `` `${reason}\n` ``; `scheduleFailoverRefresh` calls `this.sessionRefresh()` — update that call to `this.sessionRefresh('account failover')`. The crash-alert hook keys on the marker's existence, not its content, so both reasons stay quiet.

Add the imports: `import { AccountManager } from './account-manager.js';` and `import { AgentPTY } from '../pty/agent-pty.js';` (the latter is already imported — verify, don't duplicate).

**(d) `src/daemon/agent-manager.ts`** — run `grep -n "new AgentProcess(" src/daemon/agent-manager.ts`; at each construction site pass `this.accountManager` as the 5th argument. Add to the class:

```typescript
  private accountManager: AccountManager;

  // In the constructor (after existing init):
  this.accountManager = accountManager; // new required ctor param, threaded from index.ts
  this.accountManager.onTransition((account, health) => {
    if (health.status !== 'limited' && health.status !== 'invalid') return;
    for (const agent of this.getAllAgentProcesses()) {
      if (agent.getCurrentAccount() === account) {
        agent.scheduleFailoverRefresh();
      }
    }
  });
```

`getAllAgentProcesses()` — use the existing collection AgentManager keeps (find it with `grep -n "agents" src/daemon/agent-manager.ts | head`; it is a `Map<string, AgentProcess>` — iterate `this.agents.values()`; add a small getter only if no iterable exists).

**(e) `src/daemon/index.ts`** — at daemon boot, before the AgentManager is constructed:

```typescript
import { AccountManager } from './account-manager.js';
import { sendOperatorAlert } from './operator-alert.js';

const accountManager = new AccountManager({});
accountManager.onAlert((msg) => { void sendOperatorAlert(frameworkRoot, `⚠️ [accounts] ${msg}`); });
accountManager.onTransition((account, health) => {
  void sendOperatorAlert(frameworkRoot,
    health.status === 'limited'
      ? `🔄 Account "${account}" hit its weekly limit (resets ${health.limitedUntil}). Fleet failing over.`
      : `🚫 Account "${account}" auth is broken (${health.lastError}). Fix its token and clear account-health.json.`);
});
accountManager.loadTokens();
```

Pass `accountManager` into the AgentManager constructor (add the parameter there). `frameworkRoot` is already in scope at that point in index.ts (it's what `getOperatorChatCreds` was being called with).

- [ ] **Step 4: Typecheck, run the full suite**

Run: `cd /Users/asachs/cortextos && npm run typecheck && npx vitest run tests/limit-detector.test.ts tests/account-manager.test.ts tests/operator-alert.test.ts tests/failover-wiring.test.ts`
Expected: clean typecheck, all PASS. Then run the whole pre-existing suite to catch regressions: `npm test`. Expected: no new failures relative to `git stash && npm test` baseline (some suites may be environment-dependent; compare, don't assume green).

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/types/index.ts src/pty/agent-pty.ts src/daemon/agent-process.ts src/daemon/agent-manager.ts src/daemon/index.ts tests/failover-wiring.test.ts && git commit -m "feat(failover): wire detection, per-spawn token selection, jittered fleet failover"
```

---

### Task 7: Parking and auto-resume

**Files:**
- Modify: `src/types/index.ts:793` (add `'parked'` to the status union: `'running' | 'stopped' | 'crashed' | 'starting' | 'halted' | 'parked'`)
- Modify: `src/daemon/agent-process.ts` (park branch in `start()`, resume timer)
- Modify: `src/daemon/account-manager.ts` (park-alert dedup flag)
- Test: `tests/account-manager.test.ts` (append)

**Interfaces:**
- Consumes: `selectAccount()`, `earliestReset()`, `onAlert` (Tasks 2–4).
- Produces:
  - `AccountManager.shouldSendParkAlert(): boolean` — true once per park episode (dedup via `_meta.parkAlertSentAt` in the health file; cleared whenever any account transitions back to usable).
  - `AgentProcess` status `'parked'` + automatic retry at `earliestReset()` + 0–120 s jitter (fallback retry: 30 min if `earliestReset()` is null).

- [ ] **Step 1: Write the failing tests (append to tests/account-manager.test.ts)**

```typescript
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts -t "park alert"`
Expected: FAIL — `shouldSendParkAlert is not a function`.

- [ ] **Step 3: Implement**

**(a) AccountManager** — the health file gains a reserved `_meta` key (excluded from account iteration; `readHealth()` callers in earlier tasks iterate `Object.entries` — filter `_meta` inside `earliestReset()` and `selectAccount()` by skipping keys starting with `_`):

```typescript
  shouldSendParkAlert(): boolean {
    const map = this.readHealth() as HealthMap & { _meta?: { parkAlertSentAt?: string } };
    if (map._meta?.parkAlertSentAt) return false;
    map._meta = { ...(map._meta ?? {}), parkAlertSentAt: new Date().toISOString() };
    this.writeHealth(map);
    return true;
  }

  clearParkAlert(): void {
    const map = this.readHealth() as HealthMap & { _meta?: { parkAlertSentAt?: string } };
    if (!map._meta?.parkAlertSentAt) return;
    delete map._meta.parkAlertSentAt;
    this.writeHealth(map);
  }
```

In `transition()`: when a transition makes any account usable again is hard to detect cheaply — instead call `clearParkAlert()` inside `selectAccount()` whenever it returns non-null. (Selection runs at every spawn, so the flag clears on the first successful un-park.)

**(b) AgentProcess.start() park branch** — replace the Task 6 placeholder comment (`// Accounts are configured but none usable → park`) with:

```typescript
        this.currentAccount = null;
        this.env.oauthToken = undefined;
        this.status = 'parked';
        const resumeAt = this.accountManager.earliestReset();
        const delay = resumeAt
          ? Math.max(resumeAt.getTime() - Date.now(), 0) + Math.floor(Math.random() * 120_000)
          : 30 * 60 * 1000; // no known reset — re-probe in 30 min
        this.log(`All accounts limited/invalid — parked. Retrying at ${new Date(Date.now() + delay).toISOString()}`);
        if (this.accountManager.shouldSendParkAlert()) {
          void sendOperatorAlert(this.env.frameworkRoot,
            `⏸️ All Claude accounts are limited — fleet parked. Auto-resume ~${resumeAt?.toISOString() ?? 'in 30 min (no reset time known)'}. Inbound messages queue in agent inboxes.`);
        }
        setTimeout(() => {
          this.start().catch((err) => this.log(`Un-park failed: ${err}`));
        }, delay);
        return; // do not spawn a doomed session
```

Add `import { sendOperatorAlert } from './operator-alert.js';` to agent-process.ts. Inbound injections while parked already fail soft as `NOT_RUNNING` and accumulate through the existing inbox path — no change needed there (the continue-mode bootstrap prompt already says "Check inbox").

- [ ] **Step 4: Run tests**

Run: `cd /Users/asachs/cortextos && npx vitest run tests/account-manager.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/asachs/cortextos && git add src/types/index.ts src/daemon/agent-process.ts src/daemon/account-manager.ts tests/account-manager.test.ts && git commit -m "feat(failover): park fleet with deduped alert and timed auto-resume"
```

---

### Task 8: Debug injector + end-to-end verification

**Files:**
- Modify: `src/daemon/agent-process.ts` (debug trigger)
- Modify: `src/daemon/index.ts` (env gate documentation comment next to `CTX_DEBUG_ALLOW_CRASH_TRIGGER` precedent in `ecosystem.config.js` style)
- Test: `tests/failover-wiring.test.ts` (append)

**Interfaces:**
- Consumes: everything prior.
- Produces: `CTX_DEBUG_FAKE_LIMIT_BANNER=1` — when set, `AgentProcess.injectDebugLimitBanner()` feeds the real captured banner string through the live PTY detector path, driving an actual failover in a test instance without burning a real weekly limit.

- [ ] **Step 1: Add the debug method (gated, no test-first — it IS test tooling)**

```typescript
// agent-process.ts
  /**
   * DEBUG ONLY (CTX_DEBUG_FAKE_LIMIT_BANNER=1): push the captured limit
   * banner through the live detector path to rehearse a failover.
   * Same pattern as CTX_DEBUG_ALLOW_CRASH_TRIGGER.
   */
  injectDebugLimitBanner(): void {
    if (process.env.CTX_DEBUG_FAKE_LIMIT_BANNER !== '1') {
      this.log('injectDebugLimitBanner ignored (CTX_DEBUG_FAKE_LIMIT_BANNER != 1)');
      return;
    }
    this.handleLimitSignal({ kind: 'weekly-limit', resetsAt: new Date(Date.now() + 60_000) });
  }
```

Expose it through whatever operator surface the daemon already has for debug commands — check `grep -n "SIGUSR2\|CTX_DEBUG" src/daemon/index.ts src/daemon/agent-manager.ts` and mirror the crash-trigger pattern (signal handler or IPC command; follow what exists, do not invent a new mechanism).

- [ ] **Step 2: End-to-end rehearsal in a scratch instance**

```bash
# 1. Scratch instance with 2 fake accounts; do NOT touch ~/.cortextos/shared
export CTX_ROOT=$(mktemp -d)/instance && mkdir -p "$CTX_ROOT/../shared"
# ... configure accounts.json with ["primary","backup"], seed .account-tokens.cache
#     with two real setup tokens (or one real + one garbage for the invalid path)
# 2. Start a single-agent test org with CTX_DEBUG_FAKE_LIMIT_BANNER=1
# 3. Trigger the injector; observe:
#    - account-health.json: primary → limited
#    - agent log: "Failover refresh scheduled in Ns" then "Using account \"backup\""
#    - operator Telegram: one 🔄 failover alert
# 4. Set primary's limitedUntil to the past; trigger a session refresh;
#    observe drain-back: "Using account \"primary\""
```

Record actual observed output in the PR/commit body.

- [ ] **Step 3: Full suite + build**

Run: `cd /Users/asachs/cortextos && npm run typecheck && npm test && npm run build`
Expected: no new failures vs. baseline; build success.

- [ ] **Step 4: Commit**

```bash
cd /Users/asachs/cortextos && git add -A src/ tests/ && git commit -m "feat(failover): debug banner injector + e2e failover rehearsal"
```

---

### Task 9: Ops rollout — tokens, config, changelog, deploy

**Files:**
- Modify: `CHANGELOG.md` (keepachangelog `## [Unreleased]` → `### Added` entry)
- Create: `~/.cortextos/shared/accounts.json` (runtime, not repo)
- Modify: `docs/superpowers/specs/2026-07-07-multi-account-failover-design.md` (status → Implemented)

**Interfaces:** none — operator steps.

- [ ] **Step 1: Aaron mints one token per account** (interactive; cannot be done by the executor)

```bash
claude setup-token   # once logged into wyretech account → CLAUDE_OAUTH_TOKEN_WYRETECH
claude setup-token   # once logged into personal account → CLAUDE_OAUTH_TOKEN_PERSONAL
```

Store both in Infisical via the cortex-secrets flow (names exactly as above). Verify: `cortex-secret get CLAUDE_OAUTH_TOKEN_WYRETECH | head -c 12` prints `sk-ant-oat01`.

- [ ] **Step 2: Write runtime config**

```bash
mkdir -p ~/.cortextos/shared
printf '["wyretech","personal"]\n' > ~/.cortextos/shared/accounts.json
```

- [ ] **Step 3: CHANGELOG entry**

```markdown
### Added
- Multi-account failover: the daemon detects Claude weekly-limit and auth
  failures in agent sessions, fails the fleet over to the next healthy
  account (tokens from Infisical), alerts the operator once per transition,
  parks with auto-resume when all accounts are exhausted, and drains back
  automatically after limits reset.
```

- [ ] **Step 4: Deploy** (⚠️ bounces the whole fleet — confirm timing with Aaron)

```bash
cd /Users/asachs/cortextos && npm run build && pm2 restart cortextos-daemon cortextos-daemon-wyre-gateway --update-env && pm2 save
```

Verify: `pm2 logs cortextos-daemon --lines 30` shows `Using account "wyretech"` per agent, no `Not logged in`, no limit banners; `cat ~/.cortextos/shared/account-health.json` sensible.

- [ ] **Step 5: Final commit + spec status**

```bash
cd /Users/asachs/cortextos && git add CHANGELOG.md docs/superpowers/specs/2026-07-07-multi-account-failover-design.md && git commit -m "docs(failover): changelog + spec marked implemented"
```

Also remove the copied-credentials bridge artifact once the fleet is confirmed on tokens: `rm -f ~/.claude/.credentials.json.bak-old-account` (operator judgment).
