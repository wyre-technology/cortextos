import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Cross-path restart-in-flight lock (2026-07-13 restart-storm fix).
//
// CONFIRMED root mechanism: the automated hang/context actuators (fast-checker.ts's
// forceHangRestart/forceContextRestart, calling AgentProcess.sessionRefresh() directly)
// and the manual/CLI restart path (agent-manager.ts's restartAgent, calling
// stopAgent+startAgent) are two structurally DIFFERENT call shapes on the same agent,
// sharing NO coordination. If both fire within seconds of each other, each is unaware
// the other already restarted the agent — both spawn a fresh session, producing two
// live duplicates. This lock is the single shared gate BOTH paths check first.
//
// GOVERNING PRINCIPLE — fail OPEN on lock-mechanism trouble: this lock exists to
// prevent a double-restart, not to gate whether a restart is allowed to happen at all.
// If the lock file itself can't be read/written, the safer default is to let the
// restart proceed (a hung/crashed agent staying hung is worse than an occasional
// double-restart from a rare fs error) — but that fallback is loud (returns a reason
// string a caller should log), never silent.

const STALE_MS = 2 * 60_000; // well beyond any real restart's duration; reclaim if the holder crashed mid-restart without releasing

export interface RestartLockResult {
  acquired: boolean;
  reason: string;
}

interface LockFileData {
  source: string;
  at: number;
}

function lockPath(stateDir: string): string {
  return join(stateDir, '.restart-in-flight');
}

/**
 * Attempt to acquire the restart-in-flight lock for an agent's state directory.
 * `source` identifies the caller (e.g. 'hang-detector', 'context-handoff',
 * 'manual-cli-restart') purely for logging/diagnostics — it has no effect on
 * acquisition logic (a second attempt from the SAME source is blocked too, not just
 * cross-source, since the point is "is a restart already in flight", not "is a
 * DIFFERENT kind of restart in flight").
 */
export function tryAcquireRestartLock(stateDir: string, source: string): RestartLockResult {
  try {
    if (existsSync(lockPath(stateDir))) {
      const raw = readFileSync(lockPath(stateDir), 'utf-8');
      const data = JSON.parse(raw) as LockFileData;
      if (typeof data.at === 'number' && typeof data.source === 'string') {
        const age = Date.now() - data.at;
        if (age < STALE_MS) {
          return {
            acquired: false,
            reason: `restart already in flight (source=${data.source}, ${Math.round(age / 1000)}s ago)`,
          };
        }
        // Stale — fall through and reclaim it.
      }
      // Malformed content (missing/wrong-typed fields) — fall through and reclaim,
      // same as the corrupt-JSON catch branch below.
    }
    writeFileSync(lockPath(stateDir), JSON.stringify({ source, at: Date.now() } satisfies LockFileData), 'utf-8');
    return { acquired: true, reason: 'acquired' };
  } catch (err) {
    // Fail-open: see the governing-principle note at the top of this file.
    return { acquired: true, reason: `lock check failed (${err instanceof Error ? err.message : String(err)}) — proceeding fail-open` };
  }
}

/** Release the restart-in-flight lock. Harmless no-op if already clear. */
export function releaseRestartLock(stateDir: string): void {
  try {
    unlinkSync(lockPath(stateDir));
  } catch {
    // Non-critical — a missing file (already released, or never acquired) is fine;
    // and if unlink genuinely fails for another reason, the staleness timeout above
    // reclaims it eventually rather than wedging the lock forever.
  }
}
