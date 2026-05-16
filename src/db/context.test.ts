/**
 * Unit coverage for the DB-context resolver — the fail-loud property.
 *
 * The load-bearing guarantee of context.ts is that getSql() THROWS when no
 * request-or-system context is established, rather than silently falling back
 * to the BYPASSRLS pool. These tests pin that: an escaped-context call is a
 * loud error, catchable at test time.
 *
 * The pool-backed behaviour of runAsSystem() / runInRequestContext() needs a
 * real database and is exercised in the integration suite, not here.
 */
import { describe, expect, it } from 'vitest';
import { getSql, inRequestContext } from './context.js';

describe('getSql — fail-loud on no context', () => {
  it('throws when called outside any request or system context', () => {
    expect(() => getSql()).toThrow(/no DB context/);
  });

  it('throw message names both ways out (runAsSystem / awaited-in-handler)', () => {
    expect(() => getSql()).toThrow(/runAsSystem/);
    expect(() => getSql()).toThrow(/request handler/);
  });
});

describe('inRequestContext', () => {
  it('is false outside any context', () => {
    expect(inRequestContext()).toBe(false);
  });
});
