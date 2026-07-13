import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

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
  private tokens: Record<string, string> = {};

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
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      // Validate result is a plain object (not null, not array, not primitive)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Invalid health file: not a plain object');
      }
      return parsed as HealthMap;
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
    if (prev && prev.status === next.status && !this.isSpentLimit(prev)) {
      return false; // debounce: same live status, no new information
    }
    map[account] = next;
    this.writeHealth(map);
    for (const cb of this.transitionCbs) {
      try { cb(account, next); } catch (err) { this.log(`transition callback failed: ${err}`); }
    }
    return true;
  }

  /**
   * C1: a `limited` entry whose limitedUntil has already passed is SPENT.
   * Nothing writes `healthy` back on drain-back, so a stale expired entry
   * lingers on the shared file; debouncing the next real limit against it
   * swallows the transition (no fan-out, no alert) and the fleet dead-loops
   * on a dead account. A spent entry carries no live information, so a fresh
   * write over it must be allowed through with its callbacks.
   */
  private isSpentLimit(h: AccountHealth): boolean {
    return h.status === 'limited' && !!h.limitedUntil && new Date(h.limitedUntil).getTime() <= Date.now();
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
    const times = Object.entries(map)
      .filter(([key, h]) => !key.startsWith('_') && h.status === 'limited' && h.limitedUntil)
      .map(([, h]) => new Date(h.limitedUntil!).getTime());
    return times.length ? new Date(Math.min(...times)) : null;
  }

  /**
   * Pick the account the next session spawn should use.
   * Policy: strict preference order; a limited account becomes eligible
   * again the moment its limitedUntil passes; invalid accounts never
   * auto-recover (operator must fix the token and clear the entry); a
   * healthy account with no loaded token is skipped (C2).
   *
   * Pure query — no side effects. The park-alert dedup flag is cleared by
   * start() on the success path (I1), so the one-time fleet-resume alert can
   * be threaded off the boolean clearParkAlert() returns.
   */
  selectAccount(now: Date = new Date()): string | null {
    const health = this.readHealth();
    // C2: a healthy account with no loaded token is as unusable as a limited
    // one — start() would park on it AND, worse, the old return-non-null path
    // wiped the park-alert dedup on every spawn, storming ~18 park alerts per
    // cycle. Skip tokenless accounts here so selection matches reality.
    // Carve-out: when NO tokens are loaded at all (empty map — tests, zero-
    // config, legacy single-credential installs), skip the token check so
    // pure-health selection still stands.
    const enforceTokens = Object.keys(this.tokens).length > 0;
    for (const name of this.loadConfig()) {
      if (name.startsWith('_')) continue;
      const h = health[name];
      const healthUsable =
        !h || h.status === 'healthy' ||
        (h.status === 'limited' && !!h.limitedUntil && new Date(h.limitedUntil) <= now);
      if (!healthUsable) continue;
      if (enforceTokens && this.getToken(name) === null) continue;
      return name;
    }
    return null;
  }

  /**
   * True the first time it's called while all accounts are unusable; false
   * on every subsequent call until clearParkAlert() resets the flag.
   * Dedup state lives in the shared health file's reserved `_meta` key
   * (excluded from account iteration above) so the dedup holds across daemon
   * restarts and across every AgentProcess instance racing to park at once.
   */
  shouldSendParkAlert(): boolean {
    const map = this.readHealth() as HealthMap & { _meta?: { parkAlertSentAt?: string } };
    if (map._meta?.parkAlertSentAt) return false;
    map._meta = { ...(map._meta ?? {}), parkAlertSentAt: new Date().toISOString() };
    this.writeHealth(map);
    return true;
  }

  /**
   * Clear the park-alert dedup flag. Returns true ONLY when it actually cleared
   * a set flag — i.e. THIS call is the one that lifted the park. start() threads
   * that boolean to send the one-time fleet-resume alert (I1), with the same
   * cross-daemon race tolerance as the park alert (the flag transitions once
   * per episode, so exactly one racing caller sees true).
   */
  clearParkAlert(): boolean {
    const map = this.readHealth() as HealthMap & { _meta?: { parkAlertSentAt?: string } };
    if (!map._meta?.parkAlertSentAt) return false;
    delete map._meta.parkAlertSentAt;
    this.writeHealth(map);
    return true;
  }

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
      const secretName = `CLAUDE_OAUTH_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
      const tok = fetch(secretName);
      if (tok) this.tokens[name] = tok;
      else missing.push(name);
    }
    if (missing.length > 0 && existsSync(this.cacheFile())) {
      try {
        const cached = JSON.parse(readFileSync(this.cacheFile(), 'utf-8')) as Record<string, string>;
        let recovered = 0;
        for (const name of [...missing]) {
          if (cached[name]) {
            this.tokens[name] = cached[name];
            missing.splice(missing.indexOf(name), 1);
            recovered++;
          }
        }
        if (recovered > 0) {
          this.alert('token fetch failed for some accounts — using cached tokens');
        }
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
}
