/**
 * Two-connection-class DB context — RLS request-path enforcement.
 *
 * conduit's Row-Level Security policies only enforce when the database
 * connection runs as a NOBYPASSRLS role AND `conduit.current_user_id` is set.
 * Production historically connected as a single BYPASSRLS role, so RLS was a
 * silent no-op. This module provides the two connection classes and the
 * resolver that picks between them.
 *
 *   - request-path: a NOBYPASSRLS pooled connection, inside a transaction,
 *     with `SET LOCAL conduit.current_user_id` = the server-verified session
 *     user. RLS policies enforce. Established by runInRequestContext() (the
 *     Fastify preHandler calls this for every HTTP request).
 *
 *   - system-path: the BYPASSRLS pool. Legitimate ONLY for operations with no
 *     user session — migrations, the Stripe webhook, cron jobs, boot
 *     schema-init, background sweeps. Entered explicitly via runAsSystem().
 *
 * getSql() resolves the active context. It deliberately does NOT fall back to
 * the system pool when no context is set: a silent fallback would downgrade an
 * escaped request-path operation (a detached promise, a not-awaited write) to
 * BYPASSRLS, re-creating the exact silent-RLS-no-op this module exists to
 * remove — narrowed from always to intermittently, which is the worse failure
 * mode. With no context, getSql() THROWS. An escaped operation fails loudly,
 * at test time as well as in production, rather than silently skipping RLS.
 *
 * The GUC is set with `set_config(..., is_local => true)` — transaction-scoped.
 * Postgres clears it at COMMIT/ROLLBACK, so it physically cannot leak to the
 * next user of a pooled connection. The leak-prevention is a language
 * guarantee, not release-path discipline.
 */
import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Sql = postgres.Sql;

/** The active DB handle plus which connection class it belongs to. */
interface DbContext {
  /**
   * A request-path transaction handle, or the system pool. Null only during
   * the brief window inside openRequestContext() between entering the ALS
   * store (which must happen synchronously — see that function) and the
   * reserved connection being acquired. getSql() throws if read in that
   * window; in practice no request code runs there.
   */
  sql: Sql | null;
  kind: 'request' | 'system';
}

// The ALS instance MUST be a process-wide singleton. vitest's resetModules()
// re-evaluates this module; a fresh AsyncLocalStorage per copy would not see a
// store set through another copy, so getSql() in a re-imported service would
// miss a context established by the test's runWithSql/enterTestContext. Stash
// it on globalThis so every copy of this module shares one instance.
const als: AsyncLocalStorage<DbContext> =
  ((globalThis as { __conduitDbAls?: AsyncLocalStorage<DbContext> }).__conduitDbAls ??=
    new AsyncLocalStorage<DbContext>());

let systemPoolRef: Sql | null = null;
let requestPoolRef: Sql | null = null;

// Test-only DB handle override. When set (via enterTestContext), getSql(),
// systemPool(), and requestPool() resolve to it whenever no real ALS context
// / pool is available. This is what lets a unit or integration test install
// one mock / testcontainer connection in a beforeEach and have every code
// path — a service getter, a system-path call, route-registration DDL —
// resolve to it, without threading runWithSql through every call site. A
// plain module variable (unlike an AsyncLocalStorage store) survives the
// vitest beforeEach -> test boundary. Always null in production.
// globalThis-stashed for the same resetModules reason as `als`.
const testHandle = globalThis as { __conduitDbTestSql?: Sql };
function testOverride(): Sql | null {
  return testHandle.__conduitDbTestSql ?? null;
}

const DEFAULT_POOL_OPTS: postgres.Options<Record<string, never>> = {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
};

/**
 * Initialise both pools at boot. `systemUrl` connects as the BYPASSRLS role
 * (migrations, DDL, system-path); `requestUrl` connects as the NOBYPASSRLS
 * role that makes RLS policies enforce. Call once, before serving traffic.
 */
export function initPools(opts: { systemUrl: string; requestUrl: string }): void {
  systemPoolRef = postgres(opts.systemUrl, DEFAULT_POOL_OPTS);
  requestPoolRef = postgres(opts.requestUrl, DEFAULT_POOL_OPTS);
}

/**
 * The raw BYPASSRLS system pool. The explicit handle for system-path work that
 * runs outside an ALS context or has no authenticated user: boot DDL, the
 * migration runner, and request handlers that are themselves system-path by
 * nature (the auth flow, the Stripe webhook) — auth establishes identity, so
 * it has no user to scope RLS by. For system-path work nested inside code that
 * calls getSql(), prefer runAsSystem() so getSql() resolves correctly.
 */
export function systemPool(): Sql {
  if (systemPoolRef) return systemPoolRef;
  const override = testOverride();
  if (override) return override;
  throw new Error('DB pools not initialised — call initPools() before any DB access');
}

function requestPool(): Sql {
  if (requestPoolRef) return requestPoolRef;
  const override = testOverride();
  if (override) return override;
  throw new Error('DB pools not initialised — call initPools() before any DB access');
}

/**
 * Resolve the DB handle for the active context. Throws when neither a request
 * nor a system context is established — see the module docblock for why a
 * silent fallback is unsafe. The error names both ways out so the fix is
 * obvious to whoever hits it.
 */
export function getSql(): Sql {
  const ctx = als.getStore();
  if (ctx) {
    if (ctx.sql) return ctx.sql;
    // Entered but the connection is not acquired yet — only reachable if
    // request code queried during openRequestContext()'s own setup awaits.
    throw new Error(
      'getSql() called before the request context finished acquiring its ' +
        'connection. A query ran during request-context setup — it must wait ' +
        'until the onRequest hook resolves.',
    );
  }
  // Test-only fallback: a test that installed a handle via enterTestContext.
  const override = testOverride();
  if (override) return override;
  throw new Error(
    'getSql() called with no DB context. Two ways to fix this:\n' +
      '  - System-path operation (migration, webhook, cron, boot init, ' +
      'background sweep): wrap it in runAsSystem(() => ...).\n' +
      '  - Request-path operation: ensure it runs awaited inside the request ' +
      'handler — a detached promise / not-awaited write escapes the ' +
      'request context the preHandler established.',
  );
}

/**
 * Run `fn` on the BYPASSRLS system pool. The explicit entry point for every
 * operation with no authenticated user behind it: the migration runner, the
 * Stripe webhook handler, cron jobs, boot-time schema-init, background sweeps.
 *
 * System-path is always explicit — never inferred from the absence of a
 * request context — so an escaped request-path operation cannot masquerade as
 * legitimate system-path work.
 */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ sql: systemPool(), kind: 'system' }, fn);
}

/**
 * Run `fn` inside a request-path transaction on the NOBYPASSRLS pool, with
 * `conduit.current_user_id` set to `userId` for the life of the transaction.
 * Every getSql() call inside `fn` resolves to this transaction, so RLS
 * policies enforce against `userId`.
 *
 * `userId` must be the server-verified session identity — never a
 * client-supplied value. An unauthenticated request passes the empty string:
 * RLS predicates then resolve `current_setting('conduit.current_user_id', true)`
 * to '' and match no user-scoped rows, which is the correct posture for a
 * request with no user (non-RLS tables such as auth_state are unaffected).
 *
 * A nested getSql().begin() inside `fn` becomes a SAVEPOINT within this
 * transaction (postgres.js semantics) — it stays inside the request tx and
 * keeps the GUC, rather than grabbing a separate pooled connection.
 *
 * This callback form scopes the context to a single async function. The
 * Fastify request lifecycle spans multiple hooks (onRequest -> handler ->
 * onResponse) and cannot be wrapped in one callback — the plugin uses the
 * openRequestContext()/closeRequestContext() lifecycle pair below instead.
 * runInRequestContext() remains for tests and any single-callback caller.
 */
export function runInRequestContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  // The cast unwraps postgres.js's UnwrapPromiseArray on the begin() result —
  // `fn` returns a plain Promise<T>, never a query-result array.
  return requestPool().begin(async (tx) => {
    // is_local => true: transaction-scoped, cleared by Postgres at txn end.
    await tx`SELECT set_config('conduit.current_user_id', ${userId}, true)`;
    return als.run({ sql: tx as unknown as Sql, kind: 'request' }, fn);
  }) as Promise<T>;
}

/** A reserved single connection from the request pool — held until released. */
type Reserved = Awaited<ReturnType<Sql['reserve']>>;

/**
 * Handle for an open request-path context. Opaque to callers — pass it back to
 * closeRequestContext(). The `settled` flag is the settle-once guard: the
 * Fastify plugin calls closeRequestContext() from BOTH onResponse and a
 * raw-socket-close backstop, and only the first call does transaction work.
 */
export interface RequestContextHandle {
  reserved: Reserved;
  settled: boolean;
}

/**
 * Open a request-path context for a lifecycle that spans multiple async entry
 * points (the Fastify hook chain). Enters the ALS store, then reserves one
 * NOBYPASSRLS connection, opens a transaction, and sets
 * `conduit.current_user_id` — so every getSql() on the request's async chain,
 * across all hooks and the handler, resolves to this transaction.
 *
 * Ordering is load-bearing. `als.enterWith()` MUST run synchronously — before
 * the first `await` — so it mutates the caller's (the Fastify onRequest hook's,
 * hence Fastify's request) async context BEFORE Fastify captures the
 * continuation at `await onRequestHook()`. enterWith() called after an await
 * runs in a detached continuation and never reaches the handler — the request
 * would see no context. So the store object is entered first with `sql: null`
 * and the reserved connection is filled into it once acquired, still before
 * this function's promise resolves (the onRequest hook awaits it, and the
 * handler runs only after that — so the handler always sees a populated sql).
 *
 * `userId` carries the same contract as runInRequestContext(): server-verified
 * session identity, or '' for an unauthenticated request.
 *
 * The caller MUST pair every successful openRequestContext() with exactly one
 * closeRequestContext(): the reserved connection is held out of the pool until
 * then. If BEGIN / set_config fails, the connection is released here and the
 * error rethrown — no handle is returned, so no close is owed.
 */
export async function openRequestContext(userId: string): Promise<RequestContextHandle> {
  // SYNCHRONOUS — before any await. See the docblock: this is what makes the
  // context reach the Fastify handler.
  const ctx: DbContext = { sql: null, kind: 'request' };
  als.enterWith(ctx);

  const reserved = await requestPool().reserve();
  try {
    await reserved.unsafe('BEGIN');
    // is_local => true: transaction-scoped, cleared by Postgres at txn end.
    await reserved`SELECT set_config('conduit.current_user_id', ${userId}, true)`;
  } catch (err) {
    reserved.release();
    throw err;
  }
  ctx.sql = reserved as unknown as Sql;
  return { reserved, settled: false };
}

/**
 * Close a request-path context opened by openRequestContext(). COMMITs the
 * transaction on `outcome: 'commit'`, ROLLBACKs on `'rollback'`, then always
 * releases the reserved connection back to the pool.
 *
 * Idempotent via the settle-once guard: the second and later calls return
 * immediately. The connection is released even if COMMIT/ROLLBACK throws, so a
 * failed settle cannot leak a connection out of the pool.
 */
export async function closeRequestContext(
  handle: RequestContextHandle,
  outcome: 'commit' | 'rollback',
): Promise<void> {
  if (handle.settled) return;
  handle.settled = true;
  try {
    await handle.reserved.unsafe(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK');
  } finally {
    handle.reserved.release();
  }
}

/** True when the caller is inside a request-path context (test/diagnostic use). */
export function inRequestContext(): boolean {
  return als.getStore()?.kind === 'request';
}

/**
 * Run `fn` with `sql` as the active request-path context. For tests and
 * tooling that manage their own connection — an RLS integration test using a
 * role-switched reserved connection, or a unit test passing a fake. Production
 * request flow uses the request-context plugin, never this. Marked 'request'
 * so getSql() resolves and inRequestContext() reports true.
 */
export function runWithSql<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  return als.run({ sql, kind: 'request' }, fn);
}

/**
 * Test-only: install `sql` as the global test DB handle. Every getSql(),
 * systemPool(), and requestPool() with no real ALS context / pool then
 * resolves to it. Call once per test (e.g. in beforeEach) before the code
 * under test runs — including before app.register() for a route test, so
 * registration-time DDL resolves too. Unlike an AsyncLocalStorage store, this
 * override is a plain variable and survives the vitest beforeEach -> test
 * boundary. An explicit runWithSql() still takes precedence over it.
 */
export function enterTestContext(sql: Sql): void {
  testHandle.__conduitDbTestSql = sql;
}

/** Test-only: clear the handle installed by enterTestContext. */
export function clearTestContext(): void {
  delete testHandle.__conduitDbTestSql;
}

/** Close both pools — for graceful shutdown and test teardown. */
export async function closePools(): Promise<void> {
  await systemPoolRef?.end({ timeout: 5 });
  await requestPoolRef?.end({ timeout: 5 });
  systemPoolRef = null;
  requestPoolRef = null;
}
