// =============================================================================
// src/reseller/operator-routes.ts
//
// IdP slice 2, Piece 2 — MSP-AS-OPERATOR routes ("Switch to customer org").
//
// Distinct from PROVISIONER (existing src/reseller/routes.ts POST
// /admin/reseller/:resellerId/customers — ruby RC3 launch-foundational from
// 2026-06-05) which is about CREATING customer-orgs; this OPERATOR surface
// is about ACTING-IN customer-orgs after they exist.
//
// Endpoints (skeleton — handlers stub return; full impl post-Mon-ratification):
//   GET  /api/reseller/me/customers
//          List customer-orgs the authenticated caller can act-as on. Pure
//          data lookup; no audit-event needed (read-only).
//   POST /api/reseller/me/customers/:customerOrgId/switch
//          Start acting-as session. Sets session.actingAs.{onBehalfOfOrgId,
//          viaResellerOrgId}. EMITS audit-event "session_started" — currently
//          a COMPILE-FAIL until Mon-ratified schema lands (see
//          ../audit/acting-as-audit-types.ts).
//   POST /api/reseller/me/customers/exit
//          End acting-as session. Clears session.actingAs. EMITS audit-event
//          "session_ended" — also compile-fail-blocked until Mon ratification.
//
// CONSUMES (dispatch-time-grep confirmed at boss msg-1781369828316):
//   - src/org/effective-scope.ts CallerContext.actingAs (this PR's extension)
//   - src/reseller/routes.ts existing reseller-admin role gates
//   - src/auth/auth0.ts session-handling (dev PR-1 will extend with auth0_org_id)
//
// NOT YET WIRED in this PR:
//   - The actual audit-event emission (compile-fail until Mon)
//   - effectiveScope() honoring actingAs at scope-evaluation time (separate
//     change; surfaces the on-behalf-of scope-rebinding logic)
//   - The "Switch to customer org" UI button (frontend surface; ride this PR
//     or sibling — TBD per Mon sync)
//
// =============================================================================

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ACTING_AS_COOKIE } from './acting-as-middleware.js';
import type { ActingAsSessionService } from './acting-as-session-service.js';

// Schema ratified by linchpin-drop commit (boss msg-1781439100263, V4=B
// resolved). Discriminated union of three event variants:
// msp_operator_session_started/_ended/_revoked.
import type {
  ActingAsAuditEvent,
  ActingAsSessionStartedEvent,
  ActingAsSessionEndedEvent,
} from '../audit/acting-as-audit-types.js';

/**
 * Acting-as session cookie TTL. Warden encode-from-start (boss
 * msg-1781784272248): impersonation is a user-input security surface;
 * the bound session must auto-decay so a left-the-laptop-open
 * operator can't act-as forever. 4h is the upper bound; the
 * acting-as-middleware revalidates on every request so revocation
 * latency is < 1 tick even within the window.
 */
const ACTING_AS_COOKIE_MAX_AGE_SECONDS = 4 * 60 * 60;

export interface OperatorRoutesDeps {
  /**
   * Returns the customer-orgs the authenticated reseller-admin caller is
   * authorized to operate-as on. Implementation in src/org/org-service.ts
   * (mirrors getCustomersOfReseller pattern from reseller/routes.ts L344).
   * Stub in this PR; full wire in sibling PR.
   */
  listOperatableCustomers: (resellerOrgId: string) => Promise<
    Array<{ customerOrgId: string; customerName: string; customerCreatedAt: string }>
  >;

  /**
   * Authorize the caller can act-as the given customer-org. Checks:
   *   1. Caller's primary org is the reseller of the customer (FK chain)
   *   2. Caller's role on the reseller-org is admin or higher
   *   3. The customer-org is not archived/deleted
   * Returns null on authz pass; AuthzError on fail. Stubbed in this PR.
   */
  authorizeActAs: (
    callerUserId: string,
    callerResellerOrgId: string,
    targetCustomerOrgId: string,
  ) => Promise<AuthzActAsResult>;

  /**
   * Emit the acting-as audit event. Wires to admin-audit-service.ts's emit
   * path. The V4=B transactional security-notice fires by-construction at
   * the emit boundary when event.type === 'msp_operator_session_started'
   * (deps factory wraps the emit with the notification-fire so absence-of-
   * either-leaf = data-integrity violation).
   */
  emitActingAsAuditEvent: (event: ActingAsAuditEvent) => Promise<void>;

  /**
   * Look up customer-org owner email at call-time (NOT cached). The V4=B
   * transactional security-notice MUST reach the CURRENT owner even after
   * ownership transfers — caching this field on the session would defeat
   * the at-fire-time invariant. Stub in this PR; live wire in sibling PR
   * (likely src/org/org-service.ts extension).
   */
  getCustomerOrgOwnerEmail: (customerOrgId: string) => Promise<string>;

  /**
   * Acting-as session persistence + revoke surface. Mints session_id at
   * /switch (becomes the signed-cookie value) and ends the row at /exit.
   *
   * Required for the WYREAI-172 actingAs-UI-flow foundation (boss
   * msg-1781784272248). Before this PR the operator-routes scaffold
   * emitted the audit event without persisting a session row + setting
   * the cookie — the middleware then had nothing to revalidate against,
   * so `request.caller.actingAs` was never populated end-to-end.
   *
   * This service + the cookie set/clear close the substrate loop:
   *   /switch → start() → setCookie → middleware reads → caller.actingAs
   *   /exit  → end()   → clearCookie → middleware sees nothing → no caller.actingAs
   */
  actingAsSessionService: ActingAsSessionService;
}

export type AuthzActAsResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_RESELLER_OF_CUSTOMER' | 'INSUFFICIENT_ROLE' | 'CUSTOMER_ARCHIVED' };

/**
 * Skeleton route registrar. Handlers return placeholder responses suitable
 * for compile + shape-tests; live behavior lands post-Mon-ratification.
 */
export function operatorRoutes(deps: OperatorRoutesDeps) {
  return async function operatorPlugin(app: FastifyInstance) {
    // GET /api/reseller/me/customers — list operatable customer-orgs
    app.get('/api/reseller/me/customers', async (request) => {
      const caller = getCallerOrThrow(request);
      const customers = await deps.listOperatableCustomers(caller.orgId ?? '');
      return { customers };
    });

    // POST /api/reseller/me/customers/:customerOrgId/switch — start
    // acting-as session.
    //
    // WYREAI-172 PR-1 (boss msg-1781784272248) — end-to-end actingAs
    // wiring. Pre-PR the scaffold authorized + emitted audit but never
    // persisted the session row or set the cookie, so the middleware
    // had nothing to revalidate and `request.caller.actingAs` was
    // never populated downstream. This handler now closes the loop:
    //   1. Authorize (verifyResellerActingAuthority via authorizeActAs)
    //   2. Mint session via actingAsSessionService.start() — returns
    //      the session_id used as the signed-cookie value
    //   3. Set the signed cookie (HttpOnly + Secure + SameSite=Lax +
    //      maxAge ≤ 4h per warden encode-from-start)
    //   4. Emit msp_operator_session_started audit-event with the
    //      session's startedAt (NOT new Date() — the row's value is
    //      the source of truth for downstream session_ended duration
    //      reconstruction)
    //
    // Rate-limit: 30/hr per IP. A legitimate MSP onboarding flow has
    // an operator hopping between a handful of customers; 30/hr is
    // ample headroom while a brute-forced /switch storm caps fast.
    app.post<{ Params: { customerOrgId: string } }>(
      '/api/reseller/me/customers/:customerOrgId/switch',
      { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
      async (request, reply) => {
        const caller = getCallerOrThrow(request);
        const authz = await deps.authorizeActAs(
          caller.userId,
          caller.orgId ?? '',
          request.params.customerOrgId,
        );
        if (!authz.ok) {
          return reply.code(403).send({ error: authz.reason });
        }

        // Persist the acting-as session row + mint session_id. The row
        // is the cookie's referent — the middleware's
        // sessionService.getActive() lookup is what closes the cookie
        // → caller.actingAs decoration loop.
        const session = await deps.actingAsSessionService.start({
          userId: caller.userId,
          viaResellerOrgId: caller.orgId ?? '',
          onBehalfOfOrgId: request.params.customerOrgId,
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        });

        // Set the signed cookie. The middleware reads + unsigns this
        // via request.unsignCookie(); the cookie plugin's secret is
        // the same one that signed it (src/index.ts cookie plugin
        // register-time). Path '/' so the cookie travels to every
        // subsequent request; HttpOnly so client JS can't read it
        // (XSS-defense); Secure so it never leaks over plain HTTP;
        // SameSite=Lax so cross-origin POST attempts don't carry it.
        reply.setCookie(ACTING_AS_COOKIE, session.sessionId, {
          signed: true,
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAge: ACTING_AS_COOKIE_MAX_AGE_SECONDS,
        });

        // Linchpin-drop commit (boss msg-1781439100263, V4=B locked):
        // ratified schema payload + at-fire-time customer-org-owner-
        // email lookup. Notification fires by-construction at the emit
        // boundary (see OperatorRoutesDeps.emitActingAsAuditEvent docstring).
        const customerOrgOwnerEmail = await deps.getCustomerOrgOwnerEmail(
          request.params.customerOrgId,
        );
        const event: ActingAsSessionStartedEvent = {
          type: 'msp_operator_session_started',
          resellerOrgId: caller.orgId ?? '',
          customerOrgId: request.params.customerOrgId,
          actorUserId: caller.userId,
          // sessionStartedAt comes from the persisted row — single
          // source of truth for the downstream session_ended duration
          // calculation. Using `new Date()` here would risk a sub-ms
          // drift that breaks the duration invariant on the next event.
          sessionStartedAt: session.startedAt,
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
          customerOrgOwnerEmail,
        };
        await deps.emitActingAsAuditEvent(event);

        return reply.code(200).send({
          actingAs: {
            onBehalfOfOrgId: request.params.customerOrgId,
            viaResellerOrgId: caller.orgId,
          },
        });
      },
    );

    // POST /api/reseller/me/customers/exit — end acting-as session
    //
    // WYREAI-172 PR-1 (boss msg-1781784272248): closes the loop opened
    // by /switch. The middleware decorated `caller.actingAs` from the
    // session row via the signed cookie; here we end the row +
    // clearCookie so future requests have nothing to revalidate.
    //
    // Defense-in-depth: even if the cookie clear fails on the wire
    // (network, client bug), the session row's ended_at is set, so
    // the middleware's getActive() returns null on the next tick and
    // strips caller.actingAs. The cookie clear is the fast path; the
    // row's ended_at is the source of truth.
    //
    // sessionStartedAt now flows from the middleware-decorated
    // `caller.actingAs.startedAt` (slice 3 LIFECYCLE-BIND added this
    // field, mig 049). Duration = sessionEndedAt - sessionStartedAt
    // is now meaningful on the audit-stream (was duration-0 in the
    // scaffold placeholder).
    app.post(
      '/api/reseller/me/customers/exit',
      { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
      async (request, reply) => {
        const caller = getCallerOrThrow(request);
        if (!caller.actingAs) {
          return reply.code(400).send({ error: 'NO_ACTIVE_SESSION' });
        }

        // Terminal-state-end: the session row's ended_at is the
        // canonical "this session is over" signal. Idempotent — a
        // second /exit call on an already-ended row returns the row
        // unchanged (see ActingAsSessionService.end() docstring).
        await deps.actingAsSessionService.end(caller.actingAs.sessionId);

        // Clear the signed cookie. Warden review NIT (boss
        // msg-1781785916384): re-pass the FULL flag set that the
        // set-site used, not just {path}. Different browsers' cookie-
        // jar clear semantics depend on flag-attribute parity — Chrome
        // and Firefox key the cookie identity on (name, domain, path)
        // and the clear succeeds with just path, but Safari + the
        // WebKit cookie-jar match on path + sameSite + secure + signed
        // for the clear directive. Without flag parity Safari can
        // leave an orphan cookie in place; the middleware then re-
        // evaluates it on the next request to NO-OP (the row's
        // ended_at is set, defense-in-depth catches it) but logs a
        // noisy "stale_or_missing_session" warn line per tick until
        // the cookie expires. Passing the full set eliminates the
        // edge case by-construction.
        reply.clearCookie(ACTING_AS_COOKIE, {
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          signed: true,
        });

        const event: ActingAsSessionEndedEvent = {
          type: 'msp_operator_session_ended',
          resellerOrgId: caller.actingAs.viaResellerOrgId,
          customerOrgId: caller.actingAs.onBehalfOfOrgId,
          actorUserId: caller.userId,
          // sessionStartedAt now flows from the middleware-decorated
          // session state — duration is meaningful on the audit stream
          // (was duration-0 in the scaffold).
          sessionStartedAt: caller.actingAs.startedAt,
          sessionEndedAt: new Date().toISOString(),
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        };
        await deps.emitActingAsAuditEvent(event);

        return reply.code(200).send({ actingAs: null });
      },
    );
  };
}

// -----------------------------------------------------------------------------
// Internal — caller-extraction helper. Reads the populated CallerContext from
// the request (requires the upstream auth middleware to have run).
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ LIFECYCLE-BIND REQUIRED — warden Angle 2 forward-vulnerability (PR #386
//    triangle review msg-1781370774433)
// ═══════════════════════════════════════════════════════════════════════════
//
// CURRENT SCAFFOLD STATE: actingAs is read FROM the request, populated by
// the upstream auth middleware. The middleware's job in THIS PR is shape-only
// (read session, populate the field). NO live-authz revalidation happens on
// read — that's deferred to dev's future session-handling PR (slice 3).
//
// FORWARD-VULNERABILITY: actor-leaves-reseller-after-acting edge case.
// A reseller-admin starts an acting-as session (session.actingAs is set).
// MID-SESSION, the reseller-admin is REMOVED from the reseller-org (e.g.,
// disabled in IdP, role demoted, terminated). Their session still has
// actingAs populated. Without LIVE-AUTHZ-REVALIDATION at each read, the
// removed actor continues acting-on the customer-org until session expiry.
//
// REQUIRED at dev's future session-handling PR — 3-check LIVE-AUTHZ
// revalidation at every actingAs read:
//
//   1. actor STILL belongs to viaResellerOrgId
//      (org_members WHERE user_id = actor AND org_id = viaResellerOrgId
//       AND status = 'active') — catches "actor was removed"
//
//   2. actor STILL has role admin (or higher) on viaResellerOrgId
//      (role tier hasn't been demoted mid-session) — catches "actor was
//       demoted from admin → member"
//
//   3. customer-org STILL belongs to viaResellerOrgId
//      (organizations WHERE id = onBehalfOfOrgId AND parent_org_id =
//       viaResellerOrgId AND deleted_at IS NULL) — catches "customer was
//       offboarded from reseller mid-session OR customer was archived"
//
// CHECK FAILURE BEHAVIOR (load-bearing — Mon ratification scope but pinning
// the expected shape at-the-artifact):
//   - Any check fails → CLEAR session.actingAs + return 403 + emit
//     "msp_operator_session_revoked" audit-event (revoke-reason in payload).
//   - The revoke-event is a THIRD audit-event variant beyond
//     session_started/session_ended — Mon ratification should include it.
//
// WHY THIS COMMENT LIVES AT THE CALL-SITE (architecture-of-record discipline):
//   When dev picks up the session-handling PR, the LIFECYCLE-BIND requirement
//   is at the read-site they're extending — impossible to miss during their
//   reading-pass. Diff-visibility-only would be by-claim; comment-at-the-
//   artifact is by-construction-discoverable. Sibling-firing of the
//   architecture-of-record-at-the-artifact discipline applied to FORWARD-
//   requirements, not just current-state.
// ═══════════════════════════════════════════════════════════════════════════
// -----------------------------------------------------------------------------

// Caller shape is module-augmented onto FastifyRequest by
// src/reseller/acting-as-middleware.ts (slice 3 LIFECYCLE-BIND). The
// middleware populates request.caller with the revalidated actingAs (or
// strips it on failure). Reading request.caller here returns the
// already-revalidated state.
type Caller = NonNullable<FastifyRequest['caller']>;

function getCallerOrThrow(request: FastifyRequest): Caller {
  const caller = request.caller;
  if (!caller) {
    throw new Error('operator-routes: caller missing from request — auth middleware did not run');
  }
  // LIFECYCLE-BIND READ-SITE (warden Angle 2): the 3-check live-authz
  // revalidation runs UPSTREAM in src/reseller/acting-as-middleware.ts
  // (slice 3 LIFECYCLE-BIND substrate). By the time we read here, the
  // caller's actingAs is EITHER (a) freshly-revalidated this tick or (b)
  // null because revocation already fired. No third state.
  return caller;
}
