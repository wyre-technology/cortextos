import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker.js';
import type { BusPaths } from '../../../src/types/index.js';

// Freeze-cure truth table for the context-handoff DEFAULT-ON behavior (ported from
// upstream #685, adapted to this fork's BusPaths). Exercises the REAL getCtxThresholds
// + checkContextStatus (not a re-implementation), so flipping the 60 default, breaking
// the <=0 opt-out, or losing the cooperative-loop backstop fails here.
describe('context-handoff default-ON (freeze-cure)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-defaulton-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox'),
      inflight: join(testDir, 'inflight'),
      processed: join(testDir, 'processed'),
      logDir: join(testDir, 'logs'),
      stateDir: join(testDir, 'state'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // getConfig() returns a stable reference so getCtxThresholds mutates it from
  // config.json the same way the real AgentProcess does.
  function makeCtxAgent(name = 'ctx-agent') {
    const config: Record<string, unknown> = {};
    return {
      name,
      isBootstrapped: vi.fn().mockReturnValue(true),
      injectMessage: vi.fn().mockReturnValue(true),
      write: vi.fn(),
      getAgentDir: () => testDir,
      getConfig: () => config,
      getOutputBuffer: () => ({ getRecent: () => '' }),
      sessionRefresh: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  function writeConfig(cfg: Record<string, unknown>) {
    writeFileSync(join(testDir, 'config.json'), JSON.stringify(cfg), 'utf-8');
  }

  function writeCtxStatus(pct: number) {
    writeFileSync(
      join(paths.stateDir, 'context_status.json'),
      JSON.stringify({ used_percentage: pct, exceeds_200k_tokens: false, written_at: new Date().toISOString() }),
      'utf-8',
    );
  }

  function injected(agent: any): string[] {
    return agent.injectMessage.mock.calls.map((c: any[]) => c[0] as string);
  }

  describe('default truth table', () => {
    it('T1: unset threshold defaults to handoff 60 / warn 30', () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({});
      expect((checker as any).getCtxThresholds()).toEqual({ warn: 30, handoff: 60 });
    });

    it('T1: default-ON fires a handoff at 60%', async () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({});
      writeCtxStatus(60);
      await (checker as any).checkContextStatus();
      expect(injected(agent).some(m => m.includes('CONTEXT HANDOFF REQUIRED'))).toBe(true);
      expect((checker as any).ctxHandoffFiredAt).toBeGreaterThan(0);
    });

    it('T1: at 59% it warns (not handoff) and names the 60% trigger', async () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({});
      writeCtxStatus(59);
      await (checker as any).checkContextStatus();
      const msgs = injected(agent);
      expect(msgs.some(m => m.includes('CONTEXT HANDOFF REQUIRED'))).toBe(false);
      expect(msgs.some(m => m.includes('Handoff triggers at 60%'))).toBe(true);
      expect((checker as any).ctxHandoffFiredAt).toBe(0);
    });

    it('T7: ctx_handoff_threshold <= 0 opts out — no warning, no handoff', async () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({ ctx_handoff_threshold: 0 });
      writeCtxStatus(90);
      await (checker as any).checkContextStatus();
      expect(agent.injectMessage).not.toHaveBeenCalled();
      expect((checker as any).ctxHandoffFiredAt).toBe(0);
    });

    it('explicit threshold is still honored (config overrides the default)', async () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({ ctx_handoff_threshold: 50 });
      writeCtxStatus(55);
      await (checker as any).checkContextStatus();
      expect(injected(agent).some(m => m.includes('CONTEXT HANDOFF REQUIRED'))).toBe(true);
    });

    it('cooperative-restart loop backstop trips the breaker after repeated handoff fires', async () => {
      // Treadmill: a runtime that fails to reset context on the handoff restart re-crosses
      // the threshold every cycle. Each cycle is a fresh session (ctxHandoffFiredAt back to
      // 0) but the persisted handoff-fire window accumulates. First two fires hand off
      // normally; the third trips the circuit breaker instead, so the loop self-limits.
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({});
      for (let i = 0; i < 3; i++) {
        writeCtxStatus(70);
        (checker as any).ctxHandoffFiredAt = 0; // simulate the fresh session re-crossing
        await (checker as any).checkContextStatus();
      }
      const handoffPrompts = injected(agent).filter(m => m.includes('CONTEXT HANDOFF REQUIRED'));
      expect(handoffPrompts.length).toBe(2); // 3rd fire tripped the breaker instead of handing off
      expect((checker as any).ctxCircuitBrokenAt).not.toBeNull();
    });
  });

  describe('Tier-3 force-restart consecutive counter (freeze#4 fix, hardened for consistency with the hang breaker)', () => {
    it('halts on the 3rd consecutive Tier-3 force-restart', () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({});

      (checker as any).forceContextRestart('reason 1');
      expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);

      (checker as any).forceContextRestart('reason 2');
      expect(agent.sessionRefresh).toHaveBeenCalledTimes(2);

      (checker as any).forceContextRestart('reason 3');
      // 3rd consecutive restart -> HALT, not another restart.
      expect(agent.sessionRefresh).toHaveBeenCalledTimes(2);
      expect((checker as any).ctxCircuitBrokenAt).not.toBeNull();
    });

    it('recovering below the warn threshold resets the counter so a later isolated restart does not halt', async () => {
      const agent = makeCtxAgent();
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      writeConfig({});

      (checker as any).forceContextRestart('reason 1');
      (checker as any).forceContextRestart('reason 2');
      expect(agent.sessionRefresh).toHaveBeenCalledTimes(2);
      expect((checker as any).consecutiveCtxRestartsWithoutRecovery).toBe(2);

      // Session genuinely recovers: usage reported comfortably below warn (30%).
      writeCtxStatus(10);
      await (checker as any).checkContextStatus();
      expect((checker as any).consecutiveCtxRestartsWithoutRecovery).toBe(0);

      // A later, isolated Tier-3 restart is restart #1 of a new streak — must not halt.
      (checker as any).forceContextRestart('reason 3 (isolated, post-recovery)');
      expect(agent.sessionRefresh).toHaveBeenCalledTimes(3);
      expect((checker as any).ctxCircuitBrokenAt).toBeNull();
    });
  });

  describe('overflow-banner corroboration guard (D)', () => {
    const BANNER = 'conversation too long, please start compaction';

    it('the banner phrase at LOW context does NOT force-restart (documents-the-mechanism false positive)', async () => {
      const agent = makeCtxAgent();
      agent.getOutputBuffer = () => ({ getRecent: () => BANNER });
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      const spy = vi.spyOn(checker as any, 'forceContextRestart').mockImplementation(() => {});
      writeConfig({});
      writeCtxStatus(20);
      await (checker as any).checkContextStatus();
      expect(spy).not.toHaveBeenCalled();
    });

    it('the banner phrase at HIGH context (pct >= 85) DOES force-restart (backstop preserved)', async () => {
      const agent = makeCtxAgent();
      agent.getOutputBuffer = () => ({ getRecent: () => BANNER });
      const checker = new FastChecker(agent, paths, '/tmp/framework');
      const spy = vi.spyOn(checker as any, 'forceContextRestart').mockImplementation(() => {});
      writeConfig({});
      writeCtxStatus(90);
      await (checker as any).checkContextStatus();
      expect(spy).toHaveBeenCalled();
    });
  });
});
