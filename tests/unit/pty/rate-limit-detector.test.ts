import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasRateLimitSignature, detectRateLimitInLog, readLogTail } from '../../../src/pty/rate-limit-detector.js';

describe('rate-limit-detector — hasRateLimitSignature (shared signature list)', () => {
  it('matches each documented signature phrase', () => {
    const phrases = [
      'overloaded_error',
      'rate_limit_error',
      'rate limit',
      'rate-limit',
      'too many requests',
      'quota exceeded',
      'usage limit',
      'weekly limit',
      '5-hour limit',
      '5h limit',
      'used 87% of your',
    ];
    for (const phrase of phrases) {
      expect(hasRateLimitSignature(`some banner text: ${phrase} reached`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(hasRateLimitSignature("You've hit your WEEKLY LIMIT")).toBe(true);
  });

  it('strips ANSI codes before matching', () => {
    expect(hasRateLimitSignature('\x1b[31mweekly limit\x1b[0m exceeded')).toBe(true);
  });

  it('does NOT match unrelated text', () => {
    expect(hasRateLimitSignature('build succeeded, all tests passed')).toBe(false);
  });
});

describe('rate-limit-detector — readLogTail / detectRateLimitInLog', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rate-limit-detector-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('detects a signature in the tail of a real log file', () => {
    const logPath = join(testDir, 'stdout.log');
    writeFileSync(logPath, "some earlier output\nYou've hit your weekly limit\n", 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('returns false for a clean log', () => {
    const logPath = join(testDir, 'stdout.log');
    writeFileSync(logPath, 'nothing interesting here\n', 'utf-8');
    expect(detectRateLimitInLog(logPath)).toBe(false);
  });

  it('fails safe (false) when the log file does not exist', () => {
    expect(detectRateLimitInLog(join(testDir, 'missing.log'))).toBe(false);
  });

  it('readLogTail returns "" fail-safe on a missing file', () => {
    expect(readLogTail(join(testDir, 'missing.log'))).toBe('');
  });
});
