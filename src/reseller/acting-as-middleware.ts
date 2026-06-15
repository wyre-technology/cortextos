/**
 * actingAs request-middleware — populates CallerContext.actingAs from
 * the server-side acting_as_sessions table + runs the LIFECYCLE-BIND
 * 3-check live-authz revalidation at every request boundary.
 *
 * Slice 3 LIFECYCLE-BIND HARD-REQUIREMENT (June 29 launch directive
 * 2026-06-15 + warden Angle 2 forward-vulnerability from PR #386).
 *
 * Centralized at the middleware boundary per boss msg-1781534979759:
 * "Single auth point = single revocation point = simpler audit." Every
 * route handler that reads request.caller.actingAs sees either:
 *   (a) a freshly-revalidated actingAs (all 3 invariants held this tick)
 *   (b) a null actingAs (no session OR session was just revoked)
 *
 * There is no third state — the middleware revokes-then-emits before
 * the handler runs. Closes the MSP-tech-leaves-while-impersonating-
 * customer vector by-construction.
 *
 * 3-CHECK INVARIANTS (boss msg-1781370784165 + continuity-banked at
 * mem://agent/cases/actingas-at-read-revalidation-future-pr-requirement):
 *
 *   Check 1 — Role still active: caller.userId IS member of
 *             session.viaResellerOrgId with role >= 'admin' or 'owner'
 *             (the reseller-admin gate).
 *
 *   Check 2 — Customer-of-reseller FK chain intact:
 *             org(session.onBehalfOfOrgId).parentOrgId === session.viaResellerOrgId
 *
 *   Check 3 — Customer-org not deleted: org(session.onBehalfOfOrgId)
 *             returns non-null (conduit uses hard-delete, not soft;
 *             absence of the row = deleted signal).
 *
 *   Failure -> revoke session (set ended_at + revoked_reason) + emit
 *   msp_operator_session_revoked audit-event + strip actingAs from
 *   the caller context.
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type {
  ActingAsSession,
  ActingAsSessionService,
  ActingAsRevokeReason,
} from './acting-as-session-service.js';
import type { OrgService } from '../org/org-service.js';
import type { ActingAsAuditEvent } from '../audit/acting-as-audit-types.js';
import { verifyResellerActingAuthority } from './reseller-acting-authority.js';

export const ACTING_AS_COOKIE = 'acting_as_session';

export interface ActingAsMiddlewareDeps {
  actingAsSessionService: ActingAsSessionService;
  orgService: OrgService;
  /**
   * Emit a ratified ActingAsAuditEvent. Wires to the canonical emit-side
   * registered in src/audit/admin-audit-service.ts (or the dedicated
   * acting-as audit-emit boundary surfaced by PR #386's schema-ratification).
   */
  emitAuditEvent: (event: ActingAsAuditEvent) => Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: {
      userId: string;
      orgId?: string;
      role?: string;
      actingAs?: {
        onBehalfOfOrgId: string;
        viaResellerOrgId: string;
        /** session_id from acting_as_sessions; consumed by /exit handler. */
        sessionId: string;
        /** start time from acting_as_sessions; preserved for audit-emit at /exit. */
        startedAt: string;
      };
    };
  }
}

/**
 * Run the 3-check live-authz revalidation against a candidate session
 * by delegating to the shared verifyResellerActingAuthority primitive
 * (src/reseller/reseller-acting-authority.ts). Ruby triangle-leg MED
 * finding closure (PR #398, msg-1781540808207): single shared primitive
 * eliminates drift-bug-class between this middleware and the /switch
 * entry-point's authorizeResellerAdminOnCustomer (same 3 invariants,
 * historically two implementations).
 *
 * Returns null on pass; a revoke-reason discriminator on fail. The
 * primitive's deny-reason vocabulary is already aligned with
 * ActingAsRevokeReason / audit-event payload — single source of truth.
 */
async function revalidate(
  session: ActingAsSession,
  deps: Pick<ActingAsMiddlewareDeps, 'orgService'>,
): Promise<ActingAsRevokeReason | null> {
  const result = await verifyResellerActingAuthority(
    deps.orgService,
    session.userId,
    session.viaResellerOrgId,
    session.onBehalfOfOrgId,
  );
  return result.ok ? null : result.reason;
}

/**
 * Build the Fastify plugin that decorates each request with the
 * revalidated actingAs (or strips it on failure).
 *
 * Runs ONCE per request via onRequest hook. Upstream auth0 middleware
 * has already populated request.auth0User by then. This plugin reads
 * the acting_as_session signed cookie, loads the row, revalidates, and
 * EITHER attaches the actingAs to request.caller OR revokes + strips.
 */
export function actingAsMiddleware(deps: ActingAsMiddlewareDeps) {
  return fp(async function plugin(app: FastifyInstance) {
    app.addHook('onRequest', async (request, reply) => {
      const auth0User = request.auth0User;
      if (!auth0User?.sub) {
        // No authenticated user — there can be no actingAs. Make sure
        // we don't carry stale state from a request-pool reuse.
        if (request.caller?.actingAs) {
          request.caller = { ...request.caller, actingAs: undefined };
        }
        return;
      }

      const rawCookie = request.unsignCookie(
        request.cookies[ACTING_AS_COOKIE] ?? '',
      );
      if (!rawCookie.valid || !rawCookie.value) {
        return;
      }

      const session = await deps.actingAsSessionService.getActive(rawCookie.value);
      if (!session) {
        // Cookie points at a missing/already-ended session. Clear the
        // cookie to keep client + server in sync; nothing to revoke
        // (session is already terminal or never existed). Warn for
        // ops-grep visibility per analyst PR #398 review (anonymized
        // actor-hint — sub-prefix only, no full id surfaced to logs).
        request.log.warn(
          { actorHint: auth0User.sub.slice(0, 8), kind: 'stale_or_missing_session' },
          'acting-as cookie present but no active session row; clearing cookie',
        );
        reply.clearCookie(ACTING_AS_COOKIE, { path: '/' });
        return;
      }

      // The session's userId MUST match the authenticated caller. Anything
      // else is a session-cookie-mismatch attack vector — treat as a
      // missing session, not as a 3-check failure (no audit needed; this
      // path indicates a stale or tampered cookie, not a revocation
      // signal worth surfacing as msp_operator_session_revoked). Warn-log
      // so SRE can grep tampered-cookie attempts; anonymized actor-hint
      // per analyst PR #398 review (no full sub leaked into log streams).
      if (session.userId !== auth0User.sub) {
        request.log.warn(
          {
            actorHint: auth0User.sub.slice(0, 8),
            sessionUserHint: session.userId.slice(0, 8),
            kind: 'session_user_mismatch',
          },
          'acting-as cookie session belongs to a different user; clearing cookie (possible tampered cookie)',
        );
        reply.clearCookie(ACTING_AS_COOKIE, { path: '/' });
        return;
      }

      const revokeReason = await revalidate(session, deps);
      if (revokeReason) {
        const revoked = await deps.actingAsSessionService.revoke(
          session.sessionId,
          revokeReason,
        );
        // Emit the msp_operator_session_revoked audit event (V4-ratified
        // schema). Fire-and-forget — middleware should not block on audit.
        const ended = revoked ?? session;
        const event: ActingAsAuditEvent = {
          type: 'msp_operator_session_revoked',
          resellerOrgId: session.viaResellerOrgId,
          customerOrgId: session.onBehalfOfOrgId,
          actorUserId: session.userId,
          sessionStartedAt: session.startedAt,
          revokedAt: ended.endedAt ?? new Date().toISOString(),
          revokeReason,
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        };
        deps.emitAuditEvent(event).catch((err) =>
          request.log.error(
            { err, sessionId: session.sessionId, revokeReason },
            'acting-as session-revoked audit emit failed',
          ),
        );
        reply.clearCookie(ACTING_AS_COOKIE, { path: '/' });
        return;
      }

      // All 3 checks passed — decorate the caller with the revalidated
      // actingAs. Downstream handlers (effective-scope.ts consumers,
      // operator-routes.ts /exit) read this off request.caller.
      request.caller = {
        ...(request.caller ?? { userId: auth0User.sub }),
        userId: auth0User.sub,
        actingAs: {
          onBehalfOfOrgId: session.onBehalfOfOrgId,
          viaResellerOrgId: session.viaResellerOrgId,
          sessionId: session.sessionId,
          startedAt: session.startedAt,
        },
      };
    });
  });
}
