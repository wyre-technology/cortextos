// Hang detector — the SENSOR half of the freeze-cure DETECTION path (analyst spec,
// 2026-07-07 TRIGGER-SPEC). Distinct from the context-handoff PREVENTION path: this
// catches non-context / environmental hangs where a `--continue`-resumed session is
// frozen and processes no cron fires, which no context-% threshold can detect.
//
// The signal (why it's reliable): the always-heartbeat-FIRST convention (Part A)
// guarantees a HEALTHY session's first action on ANY delivered cron fire is a
// session-authored `update-heartbeat` (source=session), which advances
// last_session_heartbeat. So: a delivered fire with NO session-authored beat after it
// is an unambiguous hang. We key on that — NEVER on last-seen staleness, which the
// 50-min watchdog beat and log-event bumps keep fresh even for a dead session.
//
// GOVERNING PRINCIPLE — FAIL SAFE TOWARD NOT-RESTARTING: a missed hang is cheap (the
// next delivered fire re-catches it); a false restart disrupts a healthy agent and, at
// fleet scale, is itself a mini-storm. So on ANY uncertainty — absent last_session
// _heartbeat (deploy-transition / never-beat-yet), absent delivered fire, unparseable
// timestamp — we DO NOT flag. HUNG requires a positive assertion on every input.

export interface Cronish {
  /** ISO 8601 of the most recent fire DISPATCHED to the session (persisted pre-dispatch). */
  last_fire_attempted_at?: string | null;
  enabled?: boolean;
}

export interface HangEvalInput {
  now: number;
  /** Grace window N (ms). A healthy session beats within ~1-3min of a fire; N ~= 15min. */
  graceMs: number;
  /** Most-recent DELIVERED fire (ms), or null if none/unparseable. From crons.json. */
  deliveredFireAt: number | null;
  /** Last genuine session-authored beat (ms), or null if absent. From heartbeat.json. */
  lastSessionHeartbeat: number | null;
}

export interface HangEvalResult {
  hung: boolean;
  reason: string;
}

export interface BootstrapHangEvalInput {
  now: number;
  /** Grace window N (ms), measured from restart rather than from a cron fire. */
  graceMs: number;
  /** When this session was last (re)started (ms), or null if unknown/never recorded. */
  restartAt: number | null;
  /** Last genuine session-authored beat (ms), or null if absent. From heartbeat.json. */
  lastSessionHeartbeat: number | null;
}

/** Parse an ISO timestamp to epoch ms; null on absent/invalid (fail-safe). */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Most-recent delivered fire across the agent's crons (batching-aware: after a
 * catch-up burst we require one session beat after the MOST-RECENT fire, not one per
 * fire). Returns null when no cron has a parseable last_fire_attempted_at.
 */
export function mostRecentDeliveredFireMs(crons: Cronish[]): number | null {
  let max: number | null = null;
  for (const c of crons) {
    const t = toMs(c.last_fire_attempted_at);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * The trigger condition. HUNG iff (positive assertion on every input):
 *   1. a delivered fire T is recorded, AND
 *   2. now - T > grace N, AND
 *   3. a session heartbeat S is recorded AND S < T (no session beat since the fire).
 * Any missing/ambiguous input returns hung:false (fail-safe toward not-restarting).
 *
 * Note the idle-exit case is handled BY CONSTRUCTION: an idle-exited session that
 * resumes on its next fire writes a Part-A session beat (S >= T), so it never trips —
 * we key on delivered-fire-without-beat, not on last-seen age.
 */
export function evaluateHang(input: HangEvalInput): HangEvalResult {
  const { now, graceMs, deliveredFireAt: T, lastSessionHeartbeat: S } = input;

  if (T === null) return { hung: false, reason: 'no delivered fire recorded — fail-safe' };
  if (now - T <= graceMs) {
    return { hung: false, reason: `within grace (${Math.round((now - T) / 60_000)}m <= ${Math.round(graceMs / 60_000)}m)` };
  }
  if (S === null) {
    // Deploy-transition / never-beat-yet: no session-heartbeat baseline. Part-A fills it
    // within one cron interval; fail-safe through that window rather than mass-restart.
    return { hung: false, reason: 'no session heartbeat recorded yet (deploy-transition/fresh) — fail-safe' };
  }
  if (S >= T) {
    return { hung: false, reason: 'session beat landed at/after the delivered fire — healthy' };
  }
  return {
    hung: true,
    reason: `delivered fire ${new Date(T).toISOString()} + ${Math.round((now - T) / 60_000)}m elapsed with no session beat since (last session beat ${new Date(S).toISOString()})`,
  };
}

/**
 * #19b — a RESTART is an expected-beat anchor too, not just a delivered cron fire.
 *
 * evaluateHang's fire-anchored sensor has a blind spot: a session that hangs
 * immediately after a `--continue` restart and never establishes a
 * last_session_heartbeat baseline reads as S === null forever, which evaluateHang
 * fail-safes to "deploy-transition, not hung" — indefinitely. That blind spot is
 * exactly the 2026-07-13 fleet-freeze class (bootstrap-hang right after restart).
 *
 * evaluateBootstrapHang closes it with a second, independent anchor: restart-time.
 * HUNG iff (positive assertion on every input):
 *   1. a restart-time R is recorded, AND
 *   2. now - R > grace N, AND
 *   3. no session beat landed AT OR AFTER R (either no beat ever, or the only beat
 *      on record predates this restart — a stale carry-over from the prior session).
 * Any missing/ambiguous input returns hung:false (same fail-safe-toward-not-restarting
 * governing principle as evaluateHang).
 */
export function evaluateBootstrapHang(input: BootstrapHangEvalInput): HangEvalResult {
  const { now, graceMs, restartAt: R, lastSessionHeartbeat: S } = input;

  if (R === null) return { hung: false, reason: 'no restart-time recorded — fail-safe' };
  if (now - R <= graceMs) {
    return { hung: false, reason: `within grace-of-restart (${Math.round((now - R) / 60_000)}m <= ${Math.round(graceMs / 60_000)}m)` };
  }
  if (S !== null && S >= R) {
    return { hung: false, reason: 'bootstrap session beat landed at/after restart — healthy' };
  }
  const beatNote = S === null
    ? 'no session beat since restart'
    : `last session beat ${new Date(S).toISOString()} predates this restart`;
  return {
    hung: true,
    reason: `restarted ${new Date(R).toISOString()} + ${Math.round((now - R) / 60_000)}m elapsed, ${beatNote}`,
  };
}
