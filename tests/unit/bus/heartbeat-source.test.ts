import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateHeartbeat } from '../../../src/bus/heartbeat.js';
import type { BusPaths, Heartbeat } from '../../../src/types/index.js';

// last_session_heartbeat is the hang detector's key input. It MUST advance only on a
// genuine session beat and be carried forward (never zeroed) by the watchdog beat — else
// every 50-min watchdog tick would drop it and the sensor would flag every agent as hung.
describe('updateHeartbeat — last_session_heartbeat source semantics', () => {
  let ctxRoot: string;
  let paths: BusPaths;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'hb-source-'));
    const stateDir = join(ctxRoot, 'state', 'agent-a');
    mkdirSync(stateDir, { recursive: true });
    paths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox'),
      inflight: join(ctxRoot, 'inflight'),
      processed: join(ctxRoot, 'processed'),
      logDir: join(ctxRoot, 'logs'),
      stateDir,
      taskDir: join(ctxRoot, 'tasks'),
      approvalDir: join(ctxRoot, 'approvals'),
      analyticsDir: join(ctxRoot, 'analytics'),
      deliverablesDir: join(ctxRoot, 'deliverables'),
    };
  });

  afterEach(() => rmSync(ctxRoot, { recursive: true, force: true }));

  const read = (): Heartbeat => JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));

  it('a session beat sets BOTH last_heartbeat and last_session_heartbeat', () => {
    updateHeartbeat(paths, 'agent-a', 'online', { source: 'session' });
    const hb = read();
    expect(hb.last_session_heartbeat).toBeTruthy();
    expect(hb.last_session_heartbeat).toBe(hb.last_heartbeat);
  });

  it('default (no source specified) is treated as a session beat', () => {
    updateHeartbeat(paths, 'agent-a', 'online');
    expect(read().last_session_heartbeat).toBeTruthy();
  });

  it('a watchdog beat PRESERVES a prior session last_session_heartbeat (carry-forward), never zeroes it', () => {
    updateHeartbeat(paths, 'agent-a', 'online', { source: 'session' });
    const sessionBeat = read().last_session_heartbeat;
    expect(sessionBeat).toBeTruthy();

    updateHeartbeat(paths, 'agent-a', '[watchdog] alive', { source: 'watchdog' });
    const hb = read();
    expect(hb.last_session_heartbeat).toBe(sessionBeat); // UNCHANGED by the watchdog
    expect(hb.status).toBe('[watchdog] alive');          // but the whole object was rewritten
  });

  it('a watchdog beat with NO prior session beat leaves last_session_heartbeat absent (fail-safe)', () => {
    updateHeartbeat(paths, 'agent-a', '[watchdog] alive', { source: 'watchdog' });
    expect(read().last_session_heartbeat).toBeUndefined();
  });

  it('a later session beat advances last_session_heartbeat past the prior value', () => {
    updateHeartbeat(paths, 'agent-a', 'online', { source: 'session' });
    const first = read().last_session_heartbeat!;
    // A watchdog beat in between must not move it...
    updateHeartbeat(paths, 'agent-a', '[watchdog] alive', { source: 'watchdog' });
    expect(read().last_session_heartbeat).toBe(first);
    // ...but the next genuine session beat does (>= is enough; clock may share a ms).
    updateHeartbeat(paths, 'agent-a', 'working', { source: 'session' });
    const second = read().last_session_heartbeat!;
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
    expect(read().last_session_heartbeat).toBe(read().last_heartbeat);
  });
});
