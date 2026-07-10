import { describe, it, expect } from 'vitest';
import { evaluateHang, mostRecentDeliveredFireMs } from '../../../src/daemon/hang-detector.js';

const MIN = 60_000;
const GRACE = 15 * MIN;
const NOW = 1_800_000_000_000; // fixed epoch ms (Date.now unavailable/irrelevant in pure tests)
const iso = (ms: number) => new Date(ms).toISOString();

describe('hang-detector — evaluateHang (fail-safe by construction)', () => {
  it('FIRES on a real hang: delivered fire past grace with no session beat since', () => {
    const T = NOW - 20 * MIN; // fire delivered 20min ago (> 15min grace)
    const S = T - 5 * MIN;    // last session beat was BEFORE the fire
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S });
    expect(r.hung).toBe(true);
  });

  it('does NOT fire within the grace window (fire delivered <N ago)', () => {
    const T = NOW - 5 * MIN; // only 5min ago
    const S = T - 5 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('does NOT fire when a session beat landed at/after the fire (healthy / idle-exit-resume)', () => {
    const T = NOW - 20 * MIN;
    const S = T + 2 * MIN; // Part-A beat ~2min after the fire
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('does NOT fire when last_session_heartbeat is ABSENT (deploy-transition / never beat)', () => {
    const T = NOW - 60 * MIN; // long past grace...
    const r = evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: null });
    expect(r.hung).toBe(false); // ...but no session baseline yet -> fail-safe
    expect(r.reason).toMatch(/deploy-transition|fail-safe/);
  });

  it('does NOT fire when there is no delivered fire recorded (absent fire)', () => {
    const S = NOW - 60 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: null, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('boundary: exactly at grace does NOT fire (strict > N)', () => {
    const T = NOW - GRACE; // now - T == grace, not > grace
    const S = T - MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(false);
  });

  it('boundary: session beat exactly at fire time (S == T) is healthy', () => {
    const T = NOW - 20 * MIN;
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: T }).hung).toBe(false);
  });
});

describe('hang-detector — mostRecentDeliveredFireMs (batching-aware)', () => {
  it('picks the MOST-RECENT fire across crons (batching: one beat after the latest fire)', () => {
    const crons = [
      { last_fire_attempted_at: iso(NOW - 40 * MIN) },
      { last_fire_attempted_at: iso(NOW - 10 * MIN) }, // most recent
      { last_fire_attempted_at: iso(NOW - 25 * MIN) },
    ];
    expect(mostRecentDeliveredFireMs(crons)).toBe(NOW - 10 * MIN);
  });

  it('returns null when no cron has a parseable last_fire_attempted_at', () => {
    expect(mostRecentDeliveredFireMs([{ last_fire_attempted_at: null }, {}, { last_fire_attempted_at: 'not-a-date' }])).toBeNull();
  });

  it('ignores unparseable timestamps but keeps valid ones', () => {
    const crons = [{ last_fire_attempted_at: 'garbage' }, { last_fire_attempted_at: iso(NOW - 12 * MIN) }];
    expect(mostRecentDeliveredFireMs(crons)).toBe(NOW - 12 * MIN);
  });

  it('feeds the sensor end-to-end: latest fire past grace + stale session beat = HUNG', () => {
    const crons = [{ last_fire_attempted_at: iso(NOW - 30 * MIN) }, { last_fire_attempted_at: iso(NOW - 18 * MIN) }];
    const T = mostRecentDeliveredFireMs(crons)!;
    const S = NOW - 40 * MIN; // last session beat older than the latest fire
    expect(evaluateHang({ now: NOW, graceMs: GRACE, deliveredFireAt: T, lastSessionHeartbeat: S }).hung).toBe(true);
  });
});
