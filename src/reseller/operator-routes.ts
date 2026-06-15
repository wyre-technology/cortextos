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

// Schema ratified by linchpin-drop commit (boss msg-1781439100263, V4=B
// resolved). Discriminated union of three event variants:
// msp_operator_session_started/_ended/_revoked.
import type {
  ActingAsAuditEvent,
  ActingAsSessionStartedEvent,
  ActingAsSessionEndedEvent,
} from '../audit/acting-as-audit-types.js';

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

    // POST /api/reseller/me/customers/:customerOrgId/switch — start acting-as session
    app.post<{ Params: { customerOrgId: string } }>(
      '/api/reseller/me/customers/:customerOrgId/switch',
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

        // Linchpin-drop commit (boss msg-1781439100263, V4=B locked):
        // ratified schema payload + at-fire-time customer-org-owner-email
        // lookup. Notification fires by-construction at the emit boundary
        // (see OperatorRoutesDeps.emitActingAsAuditEvent docstring).
        const customerOrgOwnerEmail = await deps.getCustomerOrgOwnerEmail(
          request.params.customerOrgId,
        );
        const event: ActingAsSessionStartedEvent = {
          type: 'msp_operator_session_started',
          resellerOrgId: caller.orgId ?? '',
          customerOrgId: request.params.customerOrgId,
          actorUserId: caller.userId,
          sessionStartedAt: new Date().toISOString(),
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
          customerOrgOwnerEmail,
        };
        await deps.emitActingAsAuditEvent(event);

        // Session-mutation also pending (dev's PR-1 extends session-handling).
        // For now, return acknowledgment shape only.
        return reply.code(200).send({
          actingAs: {
            onBehalfOfOrgId: request.params.customerOrgId,
            viaResellerOrgId: caller.orgId,
          },
        });
      },
    );

    // POST /api/reseller/me/customers/exit — end acting-as session
    app.post('/api/reseller/me/customers/exit', async (request, reply) => {
      const caller = getCallerOrThrow(request);

      // Linchpin-drop commit (boss msg-1781439100263). Session-handling
      // integration lands in dev's PR-1 (slice 3 foundation); for the
      // scaffold skeleton, we read actingAs from the upstream middleware
      // and emit the session_ended event. sessionStartedAt comes from the
      // middleware-populated session-state in dev's PR-1; in this skeleton
      // we use a placeholder (caller.actingAs read carries no start-time,
      // which is the gap dev's session-handling closes — documented at
      // operator-routes.ts L153 LIFECYCLE-BIND block).
      if (!caller.actingAs) {
        return reply.code(400).send({ error: 'NO_ACTIVE_SESSION' });
      }
      const event: ActingAsSessionEndedEvent = {
        type: 'msp_operator_session_ended',
        resellerOrgId: caller.actingAs.viaResellerOrgId,
        customerOrgId: caller.actingAs.onBehalfOfOrgId,
        actorUserId: caller.userId,
        // sessionStartedAt placeholder — dev's session-handling PR replaces
        // with the actual session-state value. Currently NOW (effectively
        // duration-0 audit-event, but compiles + emits well-formed shape).
        sessionStartedAt: new Date().toISOString(),
        sessionEndedAt: new Date().toISOString(),
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      };
      await deps.emitActingAsAuditEvent(event);

      return reply.code(200).send({ actingAs: null });
    });
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
