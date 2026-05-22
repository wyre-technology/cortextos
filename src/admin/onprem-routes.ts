/**
 * Admin-only routes for the on-prem-tunnel stream.
 *
 * PR #3 §4 step 3 (boss-locked fold via option (a) — single source of truth
 * for enrollment-token issuance; the eventual customer-portal UI consumes
 * this same endpoint).
 *
 * `POST /admin/onprem/enrollment-token`:
 *   - **Auth:** `requireAdmin` (admin-only, NOT reseller-or-customer-admin).
 *     Token minting is a customer-onboarding operation managed by WYRE ops.
 *   - **Request body:** `{ subtenantId, capabilities, ttlSeconds? }`.
 *   - **Response:** `{ token, expiry, capabilities }`. The customer's WYRE ops
 *     contact delivers `token` to the MSP via the existing secure-channel
 *     handoff; the MSP sets it as the on-prem-gateway's `ENROLLMENT_TOKEN` env.
 *   - **Audit:** every successful mint writes an `admin_audit_log` row with
 *     `event_type='onprem_enrollment_token_minted'` (operator-only-audit
 *     pattern per PR #211 warden pin — precise issuance details ONLY in
 *     admin_audit_log, NEVER in customer-facing logs).
 *
 * `admin_audit_log` write is fire-and-forget with `.catch(log.warn)` matching
 * the unified-router on-prem-fork pattern from PR #211 (an audit-write
 * failure must NOT fail the operator's request; the row missing surfaces in
 * audit completeness checks separately).
 *
 * Same single-source-of-truth shape boss locked from the BYOC-shared-fleet
 * decision: the endpoint IS the contract. The future portal UI calls this
 * same route; the WYRE-ops `curl` usage is the same route via the same auth.
 * No CLI-script duplicate state machine.
 */
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { requireAdmin } from '../lib/admin-auth.js';
import { mintEnrollmentToken } from '../relay/enrollment-token.js';
import { getSql } from '../db/context.js';
import { runAsSystem } from '../db/context.js';

/** Default mint TTL — matches PR #1's enrollment-token DEFAULT_TTL_SECONDS. */
const DEFAULT_TTL_SECONDS = 300;
/** Max TTL — bounded; mTLS at M2 Gate A supersedes the JWT shape entirely,
 * so do NOT extend this to compensate for env-var-refresh friction (warden
 * scope-stage guardrail). */
const MAX_TTL_SECONDS = 3600;

interface MintRequestBody {
  subtenantId?: unknown;
  capabilities?: unknown;
  ttlSeconds?: unknown;
}

interface MintResponseBody {
  token: string;
  expiresAt: string; // ISO-8601 UTC
  capabilities: string[];
}

/**
 * Register the on-prem admin routes on the given Fastify instance. Mirrors
 * `adminReportsRoutes()` from src/admin/reports.ts.
 */
export function onpremAdminRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.post<{ Body: MintRequestBody }>('/admin/onprem/enrollment-token', async (request, reply) => {
      // ----------------------------------------------------------------
      // Auth — admin-only. requireAdmin sends 401/403 on failure + returns
      // false; we early-return without touching the mint path.
      // ----------------------------------------------------------------
      if (!requireAdmin(request, reply)) return;

      // ----------------------------------------------------------------
      // Body validation — same fail-loud-with-named-actionable-choice shape
      // as the on-prem-gateway entry point (Walter pin): name what's wrong
      // and what the caller should send instead.
      // ----------------------------------------------------------------
      const body = request.body ?? {};
      if (typeof body.subtenantId !== 'string' || body.subtenantId.length === 0) {
        return reply.code(400).send({
          error: 'subtenantId (string, non-empty) is required in the request body',
        });
      }
      if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
        return reply.code(400).send({
          error: 'capabilities (non-empty string[]) is required in the request body',
        });
      }
      const capabilities: string[] = [];
      for (const cap of body.capabilities) {
        if (typeof cap !== 'string' || cap.length === 0) {
          return reply.code(400).send({
            error: 'capabilities must be a non-empty array of non-empty strings',
          });
        }
        capabilities.push(cap);
      }
      let ttlSeconds = DEFAULT_TTL_SECONDS;
      if (body.ttlSeconds !== undefined) {
        if (
          typeof body.ttlSeconds !== 'number' ||
          !Number.isFinite(body.ttlSeconds) ||
          body.ttlSeconds <= 0 ||
          body.ttlSeconds > MAX_TTL_SECONDS
        ) {
          return reply.code(400).send({
            error: `ttlSeconds must be a positive number <= ${MAX_TTL_SECONDS}; mTLS at M2 Gate A supersedes JWT — do not extend TTL to compensate for env-var refresh friction`,
          });
        }
        ttlSeconds = body.ttlSeconds;
      }

      const subtenantId = body.subtenantId;
      const issuedAt = Date.now();
      const expiresAt = new Date(issuedAt + ttlSeconds * 1000).toISOString();

      // ----------------------------------------------------------------
      // Mint — mintEnrollmentToken is the existing PR #1 function; signed
      // HS256 with config.jwtSecret. Subtenant + capabilities bound IN the
      // signed claims (PR #1 security spine: per-tunnel identity carried IN
      // the JWT, not on the wire).
      // ----------------------------------------------------------------
      const token = await mintEnrollmentToken({ subtenantId, capabilities }, ttlSeconds);

      // ----------------------------------------------------------------
      // Audit — admin_audit_log entry per mint (operator-only-audit pattern
      // per PR #211 warden pin). Fire-and-forget with .catch(log.warn) so
      // an audit-write failure does NOT fail the operator's request.
      // System-path INSERT (BYPASSRLS); admin_audit_log RLS is reseller-
      // scoped for SELECT, but the relay's mint is system-actor-attributed
      // via requireAdmin's actor identity.
      // ----------------------------------------------------------------
      const actorId = request.auth0User?.sub ?? 'admin-api-key';
      // Wrap in try/catch in addition to .catch — runAsSystem may throw
      // synchronously when DB pools are not initialized (e.g. unit tests
      // running the route without the request-context plugin). Audit-write
      // failure must NOT fail the operator's request; the row missing
      // surfaces in audit completeness checks separately.
      try {
        void runAsSystem(async () => {
          await getSql()`
            INSERT INTO admin_audit_log (id, org_id, actor_id, event_type, metadata)
            VALUES (
              ${nanoid()},
              ${subtenantId},
              ${actorId},
              ${'onprem_enrollment_token_minted'},
              ${getSql().json({ capabilities, ttl_seconds: ttlSeconds, expires_at: expiresAt })}
            )
          `;
        }).catch((err) => {
          app.log.warn({ err, subtenantId, actorId }, 'Failed to log onprem enrollment-token mint to admin_audit_log');
        });
      } catch (err) {
        app.log.warn({ err, subtenantId, actorId }, 'Failed to enqueue onprem enrollment-token audit-log write');
      }

      const responseBody: MintResponseBody = { token, expiresAt, capabilities };
      return reply.code(201).send(responseBody);
    });
  };
}
