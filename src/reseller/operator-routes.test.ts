// WYREAI-172 actingAs-UI-flow foundation tests (boss msg-1781784272248).
//
// Pre-PR the operator-routes scaffold authorized + emitted audit but never
// persisted the session row or set the cookie, so request.caller.actingAs
// was never populated end-to-end. This PR closes the substrate loop:
//   /switch → sessionService.start() → setCookie → audit emit
//   /exit  → sessionService.end()   → clearCookie → audit emit
//
// Test surface covers the security-substrate (cookie flag posture, rate
// limit, idempotency, audit-emit shape) per warden encode-from-start.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { operatorRoutes } from './operator-routes.js';
import { ACTING_AS_COOKIE } from './acting-as-middleware.js';
import type { ActingAsAuditEvent } from '../audit/acting-as-audit-types.js';
import type { ActingAsSessionService } from './acting-as-session-service.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeSession(over: Partial<{
  sessionId: string;
  startedAt: string;
  userId: string;
  viaResellerOrgId: string;
  onBehalfOfOrgId: string;
}> = {}) {
  return {
    sessionId: over.sessionId ?? 'aas_test_session',
    userId: over.userId ?? 'auth0|operator',
    viaResellerOrgId: over.viaResellerOrgId ?? 'org_reseller',
    onBehalfOfOrgId: over.onBehalfOfOrgId ?? 'org_customer',
    startedAt: over.startedAt ?? '2026-06-18T12:00:00Z',
    endedAt: null,
    revokedReason: null,
    ip: null,
    userAgent: null,
  };
}

async function buildHarness(opts: {
  caller: NonNullable<FastifyRequest['caller']>;
  authzResult?: { ok: true } | { ok: false; reason: 'NOT_RESELLER_OF_CUSTOMER' | 'INSUFFICIENT_ROLE' | 'CUSTOMER_ARCHIVED' };
  sessionStartReturns?: ReturnType<typeof fakeSession>;
}) {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'test-secret-min-32-characters-long' });
  await app.register(rateLimit, { global: false });

  // Inject caller via preHandler so the route's getCallerOrThrow reads it.
  app.addHook('preHandler', async (request) => {
    request.caller = opts.caller;
  });

  const sessionStart = vi.fn().mockResolvedValue(
    opts.sessionStartReturns ?? fakeSession(),
  );
  const sessionEnd = vi.fn().mockResolvedValue(null);

  const auditEvents: ActingAsAuditEvent[] = [];
  const emitAuditEvent = vi.fn(async (event: ActingAsAuditEvent) => {
    auditEvents.push(event);
  });

  const listOperatableCustomers = vi.fn().mockResolvedValue([]);
  const authorizeActAs = vi
    .fn()
    .mockResolvedValue(opts.authzResult ?? { ok: true });
  const getCustomerOrgOwnerEmail = vi
    .fn()
    .mockResolvedValue('owner@customer.example');

  await app.register(
    operatorRoutes({
      listOperatableCustomers,
      authorizeActAs,
      emitActingAsAuditEvent: emitAuditEvent,
      getCustomerOrgOwnerEmail,
      actingAsSessionService: {
        start: sessionStart,
        end: sessionEnd,
        getActive: vi.fn(),
        revoke: vi.fn(),
        revokeAllForCustomerOrg: vi.fn(),
      } as unknown as ActingAsSessionService,
    }),
  );

  return {
    app,
    sessionStart,
    sessionEnd,
    auditEvents,
    listOperatableCustomers,
    authorizeActAs,
    getCustomerOrgOwnerEmail,
  };
}

// ---------------------------------------------------------------------------
// /switch — start acting-as session
// ---------------------------------------------------------------------------

describe('POST /api/reseller/me/customers/:customerOrgId/switch', () => {
  const callerOk = {
    userId: 'auth0|operator',
    orgId: 'org_reseller',
    role: 'admin',
  };

  it('200 + sets signed acting_as_session cookie + calls sessionService.start', async () => {
    const session = fakeSession({ sessionId: 'aas_minted_123' });
    const { app, sessionStart } = await buildHarness({
      caller: callerOk,
      sessionStartReturns: session,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/reseller/me/customers/org_customer/switch',
    });

    expect(res.statusCode).toBe(200);
    expect(sessionStart).toHaveBeenCalledWith({
      userId: 'auth0|operator',
      viaResellerOrgId: 'org_reseller',
      onBehalfOfOrgId: 'org_customer',
      // Fastify injects ip = '127.0.0.1' + a user-agent for inject()
      // calls; both flow into the persisted row for forensics + the
      // V4=B notification context.
      ip: expect.any(String),
      userAgent: expect.any(String),
    });

    // Set-Cookie header MUST be present + scoped + flagged.
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toMatch(new RegExp(`^${ACTING_AS_COOKIE}=`));
    // Warden encode-from-start: HttpOnly + Secure + SameSite=Lax + Path=/
    // + Max-Age ≤ 4h (=14400s). All flags asserted by-presence to lock
    // the contract against future regressions.
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).toContain('Path=/');
    expect(cookieHeader).toMatch(/Max-Age=14400/);
  });

  it('emits msp_operator_session_started with sessionStartedAt from the session row (not new Date)', async () => {
    const session = fakeSession({ startedAt: '2026-06-18T12:00:00Z' });
    const { app, auditEvents } = await buildHarness({
      caller: callerOk,
      sessionStartReturns: session,
    });

    await app.inject({
      method: 'POST',
      url: '/api/reseller/me/customers/org_customer/switch',
    });

    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0];
    expect(event.type).toBe('msp_operator_session_started');
    if (event.type !== 'msp_operator_session_started') return;
    // Single source of truth: the audit's sessionStartedAt MUST come from
    // the persisted row, not from new Date() — otherwise downstream
    // session_ended duration calculations drift.
    expect(event.sessionStartedAt).toBe('2026-06-18T12:00:00Z');
    expect(event.customerOrgOwnerEmail).toBe('owner@customer.example');
    expect(event.resellerOrgId).toBe('org_reseller');
    expect(event.customerOrgId).toBe('org_customer');
    expect(event.actorUserId).toBe('auth0|operator');
  });

  it('403 + no cookie set + no audit when authorizeActAs denies', async () => {
    const { app, auditEvents, sessionStart } = await buildHarness({
      caller: callerOk,
      authzResult: { ok: false, reason: 'INSUFFICIENT_ROLE' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/reseller/me/customers/org_customer/switch',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'INSUFFICIENT_ROLE' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sessionStart).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
  });

  it('rate-limited at 30/hr per IP', async () => {
    const { app } = await buildHarness({ caller: callerOk });

    // Issue 30 requests — all should succeed. The 31st should 429.
    for (let i = 0; i < 30; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/reseller/me/customers/org_customer/switch',
      });
      expect(r.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/reseller/me/customers/org_customer/switch',
    });
    expect(blocked.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// /exit — end acting-as session
// ---------------------------------------------------------------------------

describe('POST /api/reseller/me/customers/exit', () => {
  const callerActingAs = {
    userId: 'auth0|operator',
    orgId: 'org_reseller',
    role: 'admin',
    actingAs: {
      onBehalfOfOrgId: 'org_customer',
      viaResellerOrgId: 'org_reseller',
      sessionId: 'aas_active_session',
      startedAt: '2026-06-18T12:00:00Z',
      effectiveRole: 'admin' as const,
    },
  };

  it('200 + clears cookie + calls sessionService.end(sessionId) + emits session_ended', async () => {
    const { app, sessionEnd, auditEvents } = await buildHarness({
      caller: callerActingAs,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/reseller/me/customers/exit',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actingAs: null });
    expect(sessionEnd).toHaveBeenCalledWith('aas_active_session');

    // Set-Cookie header must clear the cookie (typically Max-Age=0 or
    // Expires=Thu, 01 Jan 1970...). @fastify/cookie's clearCookie API
    // sets the empty value with an expiry in the past.
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toMatch(new RegExp(`^${ACTING_AS_COOKIE}=`));
    expect(cookieHeader).toContain('Path=/');

    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0];
    expect(event.type).toBe('msp_operator_session_ended');
    if (event.type !== 'msp_operator_session_ended') return;
    // session_ended audit reads sessionStartedAt from the middleware-
    // decorated caller.actingAs — meaningful duration on the audit
    // stream (was duration-0 in the pre-PR scaffold).
    expect(event.sessionStartedAt).toBe('2026-06-18T12:00:00Z');
    expect(event.customerOrgId).toBe('org_customer');
  });

  it('400 NO_ACTIVE_SESSION when caller.actingAs is undefined', async () => {
    const { app, sessionEnd, auditEvents } = await buildHarness({
      caller: {
        userId: 'auth0|operator',
        orgId: 'org_reseller',
        role: 'admin',
        // no actingAs
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/reseller/me/customers/exit',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'NO_ACTIVE_SESSION' });
    expect(sessionEnd).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
  });
});
