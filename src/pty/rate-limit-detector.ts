// Shared Anthropic rate-limit / weekly-limit signature detection.
//
// Single source of truth for a signature list that used to be duplicated: the
// SessionEnd crash-alert hook scanned stdout.log for it after a session exited,
// but nothing in the LIVE restart path ever saw it, so a hang-restart during a
// fleet-wide weekly-limit exhaustion kept blindly re-restarting into the same
// exhausted account (freeze#4: 14 cycles over 4 hours). Both the post-exit hook
// and the live daemon restart-decision path now call the same function.

import { readFileSync, statSync } from 'fs';

const DEFAULT_TAIL_BYTES = 200 * 1024; // last 200 KB is enough to catch the banner

/**
 * Does this (ANSI-stripped, lowercased internally) text contain an Anthropic
 * rate-limit / weekly-limit / overloaded signature? Pure — takes raw text,
 * does its own normalization, so callers never need to pre-process.
 */
export function hasRateLimitSignature(text: string): boolean {
  const normalized = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
  return (
    normalized.includes('overloaded_error') ||
    normalized.includes('rate_limit_error') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate-limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('usage limit') ||
    normalized.includes('weekly limit') ||
    normalized.includes('5-hour limit') ||
    normalized.includes('5h limit') ||
    /used \d+% of your/.test(normalized)
  );
}

/** Read the last N bytes of a log file. Fail-safe: '' on any read error (missing file, etc). */
export function readLogTail(logPath: string, maxBytes: number = DEFAULT_TAIL_BYTES): string {
  try {
    const size = statSync(logPath).size;
    const readBytes = Math.min(size, maxBytes);
    const buf = readFileSync(logPath);
    return buf.subarray(Math.max(0, buf.length - readBytes)).toString('utf-8');
  } catch {
    return '';
  }
}

/** Convenience: does the tail of this log FILE show a rate-limit signature? */
export function detectRateLimitInLog(logPath: string, maxBytes: number = DEFAULT_TAIL_BYTES): boolean {
  const tail = readLogTail(logPath, maxBytes);
  return tail !== '' && hasRateLimitSignature(tail);
}
