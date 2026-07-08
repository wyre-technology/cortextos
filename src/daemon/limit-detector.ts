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
// Once the weekly-limit phrase is seen but the reset clause won't parse, keep
// waiting for up to this many additional fed characters (tracked independently
// of the sliding tail, since the phrase itself can scroll out of the tail
// before the reset clause ever arrives) before giving up and firing with
// resetsAt: null so downstream can fall back to its cooldown.
const WEEKLY_PENDING_LIMIT = 4000;

export class LimitDetector {
  private tail = '';
  private fired = new Set<LimitSignal['kind']>();
  private weeklyPending = false;
  private weeklyPendingChars = 0;

  constructor(private nowFn: Date | (() => Date) = () => new Date()) {}

  private now(): Date {
    return typeof this.nowFn === 'function' ? this.nowFn() : this.nowFn;
  }

  reset(): void {
    this.tail = '';
    this.fired.clear();
    this.weeklyPending = false;
    this.weeklyPendingChars = 0;
  }

  feed(chunk: string): LimitSignal | null {
    const clean = stripAnsi(chunk);
    this.tail = (this.tail + clean).slice(-TAIL_CHARS);

    if (!this.fired.has('weekly-limit')) {
      const sawPhrase = WEEKLY_RE.test(this.tail);
      if (sawPhrase && !this.weeklyPending) {
        this.weeklyPending = true;
        this.weeklyPendingChars = 0;
      }
      if (sawPhrase || this.weeklyPending) {
        const resetsAt = parseResetTime(this.tail, this.now());
        if (resetsAt !== null) {
          this.fired.add('weekly-limit');
          this.weeklyPending = false;
          this.weeklyPendingChars = 0;
          return { kind: 'weekly-limit', resetsAt };
        }
        this.weeklyPendingChars += clean.length;
        if (this.weeklyPendingChars >= WEEKLY_PENDING_LIMIT) {
          this.fired.add('weekly-limit');
          this.weeklyPending = false;
          this.weeklyPendingChars = 0;
          return { kind: 'weekly-limit', resetsAt: null };
        }
      }
    }
    if (!this.fired.has('not-logged-in') && NOT_LOGGED_IN_RE.test(this.tail)) {
      this.fired.add('not-logged-in');
      return { kind: 'not-logged-in' };
    }
    return null;
  }
}
