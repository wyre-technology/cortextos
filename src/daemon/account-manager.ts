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
