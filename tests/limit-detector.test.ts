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
  it('fires with null resetsAt when the reset clause never parses', () => {
    const d = new LimitDetector(NOW);
    expect(d.feed("You've hit your weekly limit · resets soon-ish")).toBeNull();
    let sig: ReturnType<typeof d.feed> = null;
    for (let i = 0; i < 50 && !sig; i++) sig = d.feed('x'.repeat(100));
    expect(sig).toEqual({ kind: 'weekly-limit', resetsAt: null });
  });
});
