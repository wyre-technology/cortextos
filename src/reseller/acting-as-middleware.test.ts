import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

// The middleware wraps orgService calls in runAsSystem (analyst PR #398
// review fold-in: cross-org reads need BYPASSRLS context). Tests don't
// have a real DB pool, so we stub runAsSystem to a pass-through.
vi.mock('../db/context.js', () => ({
  runAsSystem: async (fn: () => Promise<unknown>) => fn(),
}));

import {
  actingAsMiddleware,
  ACTING_AS_COOKIE,
} from './acting-as-middleware.js';
import type {
  ActingAsSession,
  ActingAsSessionService,
} from './acting-as-session-service.js';
import type { OrgService } from '../org/org-service.js';
import type { ActingAsAuditEvent } from '../audit/acting-as-audit-types.js';

/**
 * actingAs middleware — slice 3 LIFECYCLE-BIND HARD-REQUIREMENT.
 *
 * Warden Angle 2 (PR #386) + continuity-banked at
 * mem://agent/cases/actingas-at-read-revalidation-future-pr-requirement:
 *
 *   Every actingAs read MUST revalidate 3 invariants. Failure -> revoke
 *   session + emit msp_operator_session_revoked + strip actingAs from
 *   the caller context.
 *
 * BY-CONSTRUCTION TESTS: each test below isolates one failure mode and
 * asserts:
 *   (a) the session row is revoked with the right reason
 *   (b) the audit-event fires with the matching discriminator
 *   (c) request.caller emerges WITHOUT actingAs (substrate-actual proof
 *       that downstream handlers can never see stale actingAs)
 *
 * Plus the happy-path: all 3 checks pass -> caller.actingAs IS populated
 * with the fresh-this-tick session state.
 */

function fakeSession(overrides: Partial<ActingAsSession> = {}): ActingAsSession {
  return {
    sessionId: 'aas_test_session',
    userId: 'user_alice',
    viaResellerOrgId: 'org_reseller',
    onBehalfOfOrgId: 'org_customer',
    startedAt: '2026-06-15T10:00:00.000Z',
    endedAt: null,
    revokedReason: null,
    ip: null,
    userAgent: null,
    ...overrides,
  };
}

interface HarnessOptions {
  /** Active-session lookup return value. */
  activeSession?: ActingAsSession | null;
  /** Membership lookup result for (viaResellerOrgId, userId). */
  membership?: { role: 'owner' | 'admin' | 'member' } | null;
  /** Org lookup result for onBehalfOfOrgId. */
  customerOrg?: { id: string; parentOrgId: string | null } | null;
}

interface HarnessHandles {
  app: ReturnType<typeof Fastify>;
  auditEvents: ActingAsAuditEvent[];
  sessionService: Pick<ActingAsSessionService, 'getActive' | 'revoke' | 'end' | 'start'>;
  revokeSpy: ReturnType<typeof vi.fn>;
  warnLogs: Array<{ obj: Record<string, unknown>; msg: string }>;
}

async function buildHarness(opts: HarnessOptions = {}): Promise<HarnessHandles> {
  // Collect warn-log calls via a custom logger so the tampered-cookie
  // warn-paths are verifiable (analyst PR #398 review item 3).
  const warnLogs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const customLogger = {
    level: 'warn',
    fatal: () => {},
    error: () => {},
    warn: (obj: unknown, msg?: string) => {
      if (typeof obj === 'string') {
        warnLogs.push({ obj: {}, msg: obj });
      } else {
        warnLogs.push({ obj: obj as Record<string, unknown>, msg: msg ?? '' });
      }
    },
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => customLogger,
    silent: () => {},
  };
  const app = Fastify({ loggerInstance: customLogger as unknown as Parameters<typeof Fastify>[0]['logger'] });
  await app.register(cookie, { secret: 'test-secret-32-bytes-minimum-blhblh' });

  // Decorate the property + stub-set via onRequest so it runs BEFORE the
  // middleware's onRequest hook (Fastify runs hooks in registration
  // order). The real auth0Plugin uses the same onRequest shape, so this
  // mirrors prod boot order.
  app.decorateRequest('auth0User', null);
  app.addHook('onRequest', async (request) => {
    request.auth0User = {
      sub: 'user_alice',
      email: 'alice@example.com',
      name: 'Alice',
      emailVerified: true,
    };
  });

  const revokeSpy = vi.fn().mockImplementation((sessionId: string, reason: string) =>
    Promise.resolve(
      fakeSession({
        sessionId,
        endedAt: '2026-06-15T10:05:00.000Z',
        revokedReason: reason as ActingAsSession['revokedReason'],
      }),
    ),
  );
  const sessionService: Pick<ActingAsSessionService, 'getActive' | 'revoke' | 'end' | 'start'> = {
    getActive: vi.fn().mockResolvedValue(opts.activeSession ?? null),
    revoke: revokeSpy as ActingAsSessionService['revoke'],
    end: vi.fn().mockResolvedValue(null),
    start: vi.fn(),
  };

  const orgService = {
    getMembership: vi.fn().mockResolvedValue(opts.membership ?? null),
    getOrg: vi.fn().mockImplementation((orgId: string) => {
      if (opts.customerOrg === undefined) {
        return Promise.resolve({ id: orgId, parentOrgId: 'org_reseller' });
      }
      return Promise.resolve(opts.customerOrg);
    }),
  } as unknown as OrgService;

  const auditEvents: ActingAsAuditEvent[] = [];
  const emitAuditEvent = vi.fn(async (event: ActingAsAuditEvent) => {
    auditEvents.push(event);
  });

  await app.register(
    actingAsMiddleware({
      actingAsSessionService: sessionService as ActingAsSessionService,
      orgService,
      emitAuditEvent,
    }),
  );

  // Probe route that surfaces the caller state under test.
  app.get('/probe', async (request) => ({
    caller: request.caller ?? null,
  }));

  return { app, auditEvents, sessionService, revokeSpy, warnLogs };
}

// Build a signed cookie value via @fastify/cookie's signCookie helper
// (registered on the FastifyInstance at register-time). The middleware
// calls request.unsignCookie, which requires the cookie was signed with
// the same secret.
function signedCookieHeader(app: Awaited<ReturnType<typeof buildHarness>>['app'], value: string): string {
  const signer = app as unknown as { signCookie: (v: string) => string };
  return `${ACTING_AS_COOKIE}=${encodeURIComponent(signer.signCookie(value))}`;
}

describe('actingAs middleware — LIFECYCLE-BIND 3-check', () => {
  it('HAPPY PATH: all 3 checks pass -> caller.actingAs is populated with the revalidated session', async () => {
    const session = fakeSession();
    const { app } = await buildHarness({
      activeSession: session,
      membership: { role: 'admin' },
      customerOrg: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const cookieHeader = signedCookieHeader(app, session.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller.actingAs).toEqual({
      onBehalfOfOrgId: 'org_customer',
      viaResellerOrgId: 'org_reseller',
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      // Warden HARD-REQ 1 (boss msg-1781725403477): effectiveRole is
      // applied at the binding-decoration site via
      // mapResellerRoleToCustomerRole. The reseller-admin role used in
      // this happy-path fixture maps to 'admin' on the customer-side.
      effectiveRole: 'admin',
    });
    await app.close();
  });

  it('CHECK 1 (no membership): actor_removed_from_reseller -> revoke + emit + caller has NO actingAs', async () => {
    const session = fakeSession();
    const { app, auditEvents, revokeSpy } = await buildHarness({
      activeSession: session,
      membership: null, // membership missing entirely
      customerOrg: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const cookieHeader = signedCookieHeader(app, session.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller?.actingAs).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith(session.sessionId, 'actor_removed_from_reseller');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      type: 'msp_operator_session_revoked',
      revokeReason: 'actor_removed_from_reseller',
      resellerOrgId: 'org_reseller',
      customerOrgId: 'org_customer',
      actorUserId: 'user_alice',
    });
    await app.close();
  });

  it('CHECK 2 (role demoted below admin): role_demoted_below_admin -> revoke + emit + no actingAs', async () => {
    const session = fakeSession();
    const { app, auditEvents, revokeSpy } = await buildHarness({
      activeSession: session,
      membership: { role: 'member' }, // demoted
      customerOrg: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const cookieHeader = signedCookieHeader(app, session.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller?.actingAs).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith(session.sessionId, 'role_demoted_below_admin');
    expect(auditEvents[0]).toMatchObject({
      revokeReason: 'role_demoted_below_admin',
    });
    await app.close();
  });

  it('CHECK 3a (customer-org deleted): customer_archived -> revoke + emit + no actingAs', async () => {
    const session = fakeSession();
    const { app, auditEvents, revokeSpy } = await buildHarness({
      activeSession: session,
      membership: { role: 'admin' },
      customerOrg: null, // hard-deleted
    });
    const cookieHeader = signedCookieHeader(app, session.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller?.actingAs).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith(session.sessionId, 'customer_archived');
    expect(auditEvents[0]).toMatchObject({ revokeReason: 'customer_archived' });
    await app.close();
  });

  it('CHECK 3b (customer-org reparented away from reseller): customer_unparented_from_reseller -> revoke + emit + no actingAs', async () => {
    const session = fakeSession();
    const { app, auditEvents, revokeSpy } = await buildHarness({
      activeSession: session,
      membership: { role: 'admin' },
      customerOrg: { id: 'org_customer', parentOrgId: 'org_different_reseller' },
    });
    const cookieHeader = signedCookieHeader(app, session.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller?.actingAs).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith(session.sessionId, 'customer_unparented_from_reseller');
    expect(auditEvents[0]).toMatchObject({
      revokeReason: 'customer_unparented_from_reseller',
    });
    await app.close();
  });

  it('STALE/MISSING SESSION: cookie present but no active row -> clear cookie, no revoke, no audit, no actingAs, structured warn-log fires (ops grep)', async () => {
    const { app, auditEvents, revokeSpy, warnLogs } = await buildHarness({
      activeSession: null,
      membership: { role: 'admin' },
      customerOrg: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const cookieHeader = signedCookieHeader(app, 'aas_does_not_exist');

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller?.actingAs).toBeUndefined();
    // No revoke (nothing to revoke) + no audit (this isn't a 3-check
    // failure; it's a stale/tampered cookie).
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
    // Analyst PR #398 review item 3: warn-log surfaces tampered/stale
    // cookies with anonymized actor-hint.
    const staleWarn = warnLogs.find((w) => w.obj.kind === 'stale_or_missing_session');
    expect(staleWarn).toBeDefined();
    expect(staleWarn?.obj.actorHint).toBe('user_ali'); // first 8 chars of user_alice
    await app.close();
  });

  it('SESSION USER MISMATCH: cookie session belongs to different user -> clear cookie, no revoke, no audit, structured warn-log fires', async () => {
    const session = fakeSession({ userId: 'user_bob' }); // different user
    const { app, auditEvents, revokeSpy, warnLogs } = await buildHarness({
      activeSession: session,
      membership: { role: 'admin' },
      customerOrg: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const cookieHeader = signedCookieHeader(app, session.sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller?.actingAs).toBeUndefined();
    // Tampered/swapped cookie = treated as stale, not a 3-check failure.
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
    // Tampered-cookie warn-log with both actor + session-user hints.
    const mismatchWarn = warnLogs.find((w) => w.obj.kind === 'session_user_mismatch');
    expect(mismatchWarn).toBeDefined();
    expect(mismatchWarn?.obj.actorHint).toBe('user_ali');
    expect(mismatchWarn?.obj.sessionUserHint).toBe('user_bob');
    await app.close();
  });
});
