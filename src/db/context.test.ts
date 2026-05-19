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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  __setRequestPoolForTest,
  RESERVE_TIMEOUT_MS,
  RequestPoolBusyError,
  getSql,
  inRequestContext,
  openRequestContext,
} from './context.js';

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

/**
 * openRequestContext() bounds requestPool().reserve() with a
 * {@link RESERVE_TIMEOUT_MS} timer. Two load-bearing properties pinned here:
 *  1. on timeout it throws a typed RequestPoolBusyError (mapped to 503 by the
 *     plugin) — fail loud, not hang;
 *  2. when the reserve loses the race but still resolves later, the
 *     late-arriving connection is RELEASED — losing-promise leaks are the
 *     same acquire-without-guaranteed-release class the close-listener fix
 *     also addresses.
 *
 * A fake `Sql` is injected via __setRequestPoolForTest so the test controls
 * exactly when reserve() resolves.
 */
describe('openRequestContext — bounded reserve()', () => {
  let reserveResolver: ((r: unknown) => void) | null;
  let releaseSpy: ReturnType<typeof vi.fn>;

  function installFakePool(): void {
    releaseSpy = vi.fn();
    reserveResolver = null;
    const reservePromise = new Promise((resolve) => {
      reserveResolver = (r) => resolve(r);
    });
    const fakeSql = {
      reserve: () => reservePromise,
    } as unknown as Sql;
    __setRequestPoolForTest(fakeSql);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    installFakePool();
  });

  afterEach(() => {
    __setRequestPoolForTest(null);
    vi.useRealTimers();
  });

  it('throws RequestPoolBusyError when reserve() does not acquire within RESERVE_TIMEOUT_MS', async () => {
    const p = openRequestContext('user-1');
    // Surface the rejection before its microtask wins the next-tick race.
    const settled = expect(p).rejects.toBeInstanceOf(RequestPoolBusyError);
    await vi.advanceTimersByTimeAsync(RESERVE_TIMEOUT_MS + 1);
    await settled;
  });

  it('releases a late-resolving reserved connection so the slot is reusable', async () => {
    const p = openRequestContext('user-1');
    const settled = expect(p).rejects.toBeInstanceOf(RequestPoolBusyError);
    await vi.advanceTimersByTimeAsync(RESERVE_TIMEOUT_MS + 1);
    await settled;

    // reserve() now resolves LATE — the detached .then() in openRequestContext
    // must release this connection so it does not silently strand the slot.
    expect(releaseSpy).not.toHaveBeenCalled();
    reserveResolver!({ release: releaseSpy });
    // Flush the detached then() microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});
