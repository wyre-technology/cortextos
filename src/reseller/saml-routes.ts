// =============================================================================
// src/reseller/saml-routes.ts
//
// IdP slice 2, Piece 3 — reseller-self-service SAML connection wizard
// (pearl-owned per boss msg-1781452096195). Distinct from dev's #389
// platform-admin wizard at /admin/orgs/:orgId/idp-connections* (Wyre staff
// scope) — this wizard runs at /admin/reseller/:resellerId/customers/
// :customerOrgId/idp-connections* and gates on RESELLER_ADMIN role on the
// reseller-org + verifies the customerOrgId is genuinely a customer of
// the reseller (parent_org_id chain).
//
// CONSUMES (dispatch-time-grep msg-1781452579813):
//   - OrgIdpConnectionService (dev #388) — create/list/getById/hardDelete
//   - Auth0ManagementClient (dev #381) — createConnection/deleteConnection/
//     enableConnection
//   - SAML metadata parser (dev #388 src/auth/saml-metadata-parser.ts)
//   - Existing reseller-role gates from src/reseller/routes.ts
//   - OrgService.getOrg + parent_org_id verification
//
// MIRRORS (dev #389 platform-admin wizard at src/admin/org-routes.ts:949+):
//   GET    /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections
//   GET    /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections/new
//   POST   /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections
//   POST   /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections/:id/delete
//
// Composition with #386 MSP-AS-OPERATOR: reseller-admin acting-on-customer
// IS the canonical MSP-as-OPERATOR pattern from Piece 2 — the authorization
// gate this file implements is the runtime expression of CallerContext.
// actingAs at the reseller-acting-on-customer-org substrate. Future PR can
// wire CallerContext.actingAs population to this gate's success path
// (currently each endpoint validates inline; refactor lands when dev's
// session-handling PR ships).
// =============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runAsSystem } from '../db/context.js';
import { escapeHtml } from '../web/helpers.js';
import type { OrgIdpConnectionService } from '../org/org-idp-connection-service.js';
import type { Auth0ManagementClient } from '../auth/auth0-management.js';
import type { AdminAuditService } from '../audit/admin-audit-service.js';

/**
 * Hook fired when a BOTH-OR-NEITHER rollback ITSELF fails (warden Finding 2,
 * msg-1781453690524). Without this, an orphan-Auth0-connection (Auth0
 * resource created but Conduit DB state never persisted AND the rollback
 * delete also failed) leaves no observable trace. Production wiring
 * increments a Prom counter `reseller_saml_rollback_failure_total` for
 * sustained-error-rate alerting; tests inject a spy. Same shape as the
 * onResolverFailure hook from PR #392 — observability-gap closure at the
 * rollback-substrate. N=3 firing of the "correct-direction + observability-
 * gap pairing" pattern across distinct rollback-substrates (#350 + #392
 * + this).
 */
export type RollbackFailureHook = (info: {
  auth0ConnectionId: string;
  errClass: string;
  errMessage: string;
  customerOrgId: string;
}) => void;

export interface ResellerOnCustomerContext {
  callerUserId: string;
  resellerId: string;
  customerOrgId: string;
  /**
   * Customer-org's auth0_org_id at validation-time. Load-bearing for the
   * enableConnection step (ruby Finding #1 MUST-FIX msg-1781453634179) — the
   * Auth0 Mgmt API's enableConnection call requires the org's auth0_org_id
   * as the first argument. Validated-as-fresh by the authorize gate so the
   * connection enables on the CURRENT customer-org Auth0 peer, not a stale
   * id. NULL when customer-org has not yet been provisioned into Auth0
   * Organizations (mid-rollout case) — POST handler returns flash_err
   * instead of attempting enableConnection.
   */
  customerOrgAuth0OrgId: string | null;
}

export interface SamlRoutesDeps {
  /**
   * Verifies the caller has reseller_admin role on the resellerId AND the
   * customerOrgId is genuinely a customer-org of that reseller (parent_org_id
   * chain). Returns the validated context on success; null + writes a 403/404
   * to reply on failure.
   *
   * RUBY MED #3 cut-explicit (msg-1781453634179): the LOAD-BEARING
   * DISTINGUISHER between this RESELLER-SELF-SERVICE gate vs dev's #389
   * PLATFORM-ADMIN gate vs the existing PROVISIONER pattern is the
   * customer-relationship-chain verification:
   *
   *   - PROVISIONER (ruby's RC3 ship 2026-06-05): authorizes the caller to
   *     CREATE a customer-org under their reseller. Customer-org doesn't
   *     exist yet at gate-time → relationship-chain is THE OPERATION ITSELF.
   *   - PLATFORM-ADMIN (#389): authorizes Wyre staff to act on ANY org via
   *     requireAdmin. No relationship-chain verification needed because
   *     platform-admin scope is the entire fleet.
   *   - RESELLER-SELF-SERVICE (this gate): authorizes a reseller_admin to
   *     act on a SPECIFIC customer-org IF the customer-org is genuinely a
   *     customer of the reseller (organizations.parent_org_id chain). The
   *     relationship-chain verification IS the distinguishing axis.
   *
   * Returning customerOrgAuth0OrgId AS PART OF the validated context
   * (rather than a separate lookup later) eliminates the time-of-check vs
   * time-of-use race for the enableConnection step — fresh-per-request
   * authority binds to fresh-per-request Auth0 org id.
   */
  authorizeResellerAdminOnCustomer: (
    request: FastifyRequest,
    reply: FastifyReply,
    resellerId: string,
    customerOrgId: string,
  ) => Promise<ResellerOnCustomerContext | null>;

  /** From dev's #388 — create/list/getById/hardDelete IdP connections. */
  orgIdpConnectionService?: OrgIdpConnectionService;

  /** From dev's #381 — Auth0 Mgmt API for connection lifecycle. */
  auth0ManagementClient?: Auth0ManagementClient;

  /**
   * Audit-trail surface (RUBY HIGH MUST-FIX #2 msg-1781453634179, VC1
   * launch-blocker closure). Required deps — without audit-emit, reseller-
   * self-service-created connections leave no audit trail. POST/DELETE
   * fire 'idp_connection_created'/'idp_connection_deleted' events with
   * orgId distinguishing reseller-self-service scope from platform-admin
   * scope (boss msg-1781453634179 call: shared event types since org_id
   * is already the scope-discriminator).
   */
  adminAuditService: AdminAuditService;

  /**
   * Rollback-failure observability hook (WARDEN Finding 2 closure,
   * msg-1781453690524). Fires when the orchestrator's rollback path itself
   * fails (Auth0 createConnection succeeded → enableConnection or DB write
   * failed → deleteConnection rollback ALSO failed → orphan Auth0 resource).
   * Production wiring increments Prom counter
   * reseller_saml_rollback_failure_total; tests inject a spy. Optional —
   * no-op default is safe but loses the observability surface, so
   * production setups SHOULD wire this.
   */
  onRollbackFailure?: RollbackFailureHook;

  /** CSRF helper compatible with the rest of the admin surface. */
  getOrSetCsrfToken: (request: FastifyRequest, reply: FastifyReply) => string;

  /** Parse SAML metadata XML into the shape OrgIdpConnectionService expects. */
  parseSamlMetadata: (xml: string) => {
    entityId: string;
    signInEndpoint: string;
    x509Cert: string;
  } | { error: string };
}

/**
 * Result of the BOTH-OR-NEITHER discipline orchestrator. Either:
 *   - all 3 Auth0+DB steps succeed → ok (carries auth0ConnectionId for audit
 *     metadata — RUBY HIGH MUST-FIX #2 closure)
 *   - any step fails → ok=false. Auth0 createConnection rolled back if it
 *     succeeded before the failing step.
 */
type BothOrNeitherOutcome =
  | { ok: true; connectionId: string; auth0ConnectionId: string }
  | { ok: false; error: string };

export function samlRoutes(deps: SamlRoutesDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    const basePath = '/admin/reseller/:resellerId/customers/:customerOrgId/idp-connections';

    // -------------------------------------------------------------------------
    // GET /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections
    //
    // List existing SAML connections for the customer-org. Reseller-admin
    // visibility surface — auditable view of which IdPs are enabled on their
    // customers without requiring platform-admin escalation.
    // -------------------------------------------------------------------------
    app.get<{
      Params: { resellerId: string; customerOrgId: string };
      Querystring: { flash_ok?: string; flash_err?: string };
    }>(basePath, async (request, reply) => {
      const ctx = await deps.authorizeResellerAdminOnCustomer(
        request,
        reply,
        request.params.resellerId,
        request.params.customerOrgId,
      );
      if (!ctx) return;

      const connections = deps.orgIdpConnectionService
        ? await runAsSystem(() =>
            deps.orgIdpConnectionService!.listForOrg(ctx.customerOrgId),
          )
        : [];

      const csrf = deps.getOrSetCsrfToken(request, reply);
      const flash = renderFlash(request.query);
      const disabledNotice =
        !deps.orgIdpConnectionService || !deps.auth0ManagementClient
          ? '<div class="alert">IdP wizard requires AUTH0_M2M_CLIENT_ID/SECRET; existing connections are read-only.</div>'
          : '';

      const rows = connections.length === 0
        ? '<tr><td colspan="5" class="muted">No IdP connections configured.</td></tr>'
        : connections
            .map((c) => `
              <tr>
                <td><code>${escapeHtml(c.strategy)}</code></td>
                <td>${escapeHtml(c.displayName ?? c.entityId)}</td>
                <td><code class="muted">${escapeHtml(c.entityId)}</code></td>
                <td><span class="badge">${escapeHtml(c.status)}</span></td>
                <td>
                  <form method="POST" action="${escapeHtml(basePathFor(ctx))}/${escapeHtml(c.id)}/delete" style="display:inline">
                    <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
                    <button type="submit" class="btn btn-danger" onclick="return confirm('Delete this IdP connection?')">Delete</button>
                  </form>
                </td>
              </tr>`)
            .join('');

      const newConnectionHref = `${basePathFor(ctx)}/new`;
      const body = `
        <h1>Customer IdP Connections</h1>
        <p class="subtitle">
          <a href="/admin/reseller/${escapeHtml(ctx.resellerId)}/customers">← Back to customers</a>
        </p>
        ${flash}
        ${disabledNotice}
        <p><a href="${escapeHtml(newConnectionHref)}" class="btn btn-primary">Add SAML Connection</a></p>
        <table class="data-table">
          <thead>
            <tr><th>Strategy</th><th>Display Name</th><th>Entity ID</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;

      return reply.type('text/html').send(body);
    });

    // -------------------------------------------------------------------------
    // GET /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections/new
    //
    // SAML wizard form. Reseller-admin pastes IdP metadata XML; the POST
    // handler parses + creates via BOTH-OR-NEITHER.
    // -------------------------------------------------------------------------
    app.get<{
      Params: { resellerId: string; customerOrgId: string };
      Querystring: { flash_err?: string };
    }>(`${basePath}/new`, async (request, reply) => {
      const ctx = await deps.authorizeResellerAdminOnCustomer(
        request,
        reply,
        request.params.resellerId,
        request.params.customerOrgId,
      );
      if (!ctx) return;

      const csrf = deps.getOrSetCsrfToken(request, reply);
      const flash = renderFlash(request.query);
      const submitAction = basePathFor(ctx);

      const body = `
        <h1>Add SAML Connection</h1>
        <p class="subtitle"><a href="${escapeHtml(submitAction)}">← Back to connections</a></p>
        ${flash}
        <form method="POST" action="${escapeHtml(submitAction)}">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}" />
          <label>
            Display name
            <input type="text" name="display_name" required maxlength="120" />
          </label>
          <label>
            SAML metadata XML
            <textarea name="metadata_xml" required rows="12" placeholder="Paste your IdP's SAML metadata XML here"></textarea>
          </label>
          <button type="submit" class="btn btn-primary">Create connection</button>
        </form>`;

      return reply.type('text/html').send(body);
    });

    // -------------------------------------------------------------------------
    // POST /admin/reseller/:resellerId/customers/:customerOrgId/idp-connections
    //
    // BOTH-OR-NEITHER submit: parse metadata → Auth0 createConnection →
    // Auth0 enableConnection → DB INSERT. Any post-Auth0 failure rolls back
    // the Auth0 connection (boss design call 3 discipline, msg-1781371246033
    // documented at dev's #389).
    // -------------------------------------------------------------------------
    app.post<{
      Params: { resellerId: string; customerOrgId: string };
      Body: { display_name?: string; metadata_xml?: string; _csrf?: string };
    }>(basePath, async (request, reply) => {
      const ctx = await deps.authorizeResellerAdminOnCustomer(
        request,
        reply,
        request.params.resellerId,
        request.params.customerOrgId,
      );
      if (!ctx) return;

      if (!deps.orgIdpConnectionService || !deps.auth0ManagementClient) {
        return redirectFlash(reply, basePathFor(ctx), {
          flash_err: 'IdP wizard is not configured in this environment.',
        });
      }

      const displayName = (request.body?.display_name ?? '').trim();
      const metadataXml = request.body?.metadata_xml ?? '';
      if (!displayName || !metadataXml) {
        return redirectFlash(reply, `${basePathFor(ctx)}/new`, {
          flash_err: 'Display name and metadata XML are required.',
        });
      }

      const parsed = deps.parseSamlMetadata(metadataXml);
      if ('error' in parsed) {
        return redirectFlash(reply, `${basePathFor(ctx)}/new`, {
          flash_err: `Could not parse metadata: ${parsed.error}`,
        });
      }

      const outcome = await runBothOrNeither({
        deps,
        ctx,
        displayName,
        parsed,
        logger: request.log,
      });

      if (outcome.ok) {
        // RUBY HIGH MUST-FIX #2 closure (msg-1781453634179): audit-emit at
        // POST.ok branch so reseller-self-service-created connections leave
        // the same audit trail as platform-admin #389. Shared event-type
        // (boss call: org_id distinguishes scope already). Fire-and-forget
        // .catch is the dev-#389 pattern — audit-emit failure must not
        // block the user-facing flow.
        void runAsSystem(() =>
          deps.adminAuditService.log({
            orgId: ctx.customerOrgId,
            actorId: ctx.callerUserId,
            eventType: 'idp_connection_created',
            metadata: {
              strategy: 'samlp',
              entity_id: parsed.entityId,
              auth0_connection_id: outcome.auth0ConnectionId,
              display_name: displayName,
              created_via: 'reseller_self_service',
              reseller_org_id: ctx.resellerId,
            },
          }),
        ).catch((err) => request.log.error(err, 'reseller saml audit log failed'));
        return redirectFlash(reply, basePathFor(ctx), { flash_ok: 'Connection created.' });
      }
      return redirectFlash(reply, `${basePathFor(ctx)}/new`, { flash_err: outcome.error });
    });

    // -------------------------------------------------------------------------
    // POST /admin/reseller/:resellerId/customers/:customerOrgId/
    //      idp-connections/:id/delete
    //
    // Removal — calls OrgIdpConnectionService.hardDelete + Auth0
    // deleteConnection. Audit-trail surfaces at admin-audit-service via
    // the existing event-emit pathways (dev's #389 wired the audit-event
    // family; this handler reuses).
    // -------------------------------------------------------------------------
    app.post<{
      Params: { resellerId: string; customerOrgId: string; id: string };
    }>(`${basePath}/:id/delete`, async (request, reply) => {
      const ctx = await deps.authorizeResellerAdminOnCustomer(
        request,
        reply,
        request.params.resellerId,
        request.params.customerOrgId,
      );
      if (!ctx) return;

      if (!deps.orgIdpConnectionService || !deps.auth0ManagementClient) {
        return redirectFlash(reply, basePathFor(ctx), {
          flash_err: 'IdP wizard is not configured.',
        });
      }

      const conn = await runAsSystem(() =>
        deps.orgIdpConnectionService!.getById(request.params.id),
      );
      if (!conn || conn.orgId !== ctx.customerOrgId) {
        return redirectFlash(reply, basePathFor(ctx), { flash_err: 'Connection not found.' });
      }

      try {
        await deps.auth0ManagementClient.deleteConnection(conn.auth0ConnectionId);
        await runAsSystem(() => deps.orgIdpConnectionService!.hardDelete(conn.id));
        // RUBY HIGH MUST-FIX #2 closure: audit-emit at DELETE success branch.
        void runAsSystem(() =>
          deps.adminAuditService.log({
            orgId: ctx.customerOrgId,
            actorId: ctx.callerUserId,
            eventType: 'idp_connection_deleted',
            metadata: {
              strategy: conn.strategy,
              entity_id: conn.entityId,
              auth0_connection_id: conn.auth0ConnectionId,
              connection_id: conn.id,
              deleted_via: 'reseller_self_service',
              reseller_org_id: ctx.resellerId,
            },
          }),
        ).catch((err) => request.log.error(err, 'reseller saml audit log failed'));
        return redirectFlash(reply, basePathFor(ctx), { flash_ok: 'Connection deleted.' });
      } catch (err) {
        request.log.error({ err, connectionId: conn.id }, 'reseller-saml delete failed');
        return redirectFlash(reply, basePathFor(ctx), {
          flash_err: 'Failed to delete connection — check logs.',
        });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function basePathFor(ctx: { resellerId: string; customerOrgId: string }): string {
  return `/admin/reseller/${ctx.resellerId}/customers/${ctx.customerOrgId}/idp-connections`;
}

function renderFlash(query: Record<string, string | undefined>): string {
  if (query.flash_ok) return `<div class="alert alert-ok">${escapeHtml(query.flash_ok)}</div>`;
  if (query.flash_err) return `<div class="alert alert-err">${escapeHtml(query.flash_err)}</div>`;
  return '';
}

function redirectFlash(
  reply: FastifyReply,
  path: string,
  flash: { flash_ok?: string; flash_err?: string },
) {
  const url = new URL(path, 'http://placeholder.local');
  if (flash.flash_ok) url.searchParams.set('flash_ok', flash.flash_ok);
  if (flash.flash_err) url.searchParams.set('flash_err', flash.flash_err);
  const target = url.pathname + (url.search ? url.search : '');
  return reply.redirect(target, 302);
}

/**
 * BOTH-OR-NEITHER orchestrator — mirrors dev's #389 4-step sequence
 * (RUBY HIGH MUST-FIX #1 closure msg-1781453634179):
 *
 *   1. Auth0 createConnection — create the SAML connection resource
 *   2. Auth0 enableConnection — enable on the customer-org's Auth0 Org peer
 *                                (THIS STEP WAS MISSING in the original
 *                                commit; silent-failure rot: connections
 *                                would be CREATED-BUT-DISABLED, SAML login
 *                                would never work)
 *   3. DB INSERT into org_idp_connections — persist the mapping
 *   4. (POST handler) audit-emit
 *
 * Rollback path: if step 2 or 3 fails, deleteConnection rolls back step 1.
 * If the rollback ITSELF fails (warden Finding 2), the orphan-Auth0-
 * connection is observable via the onRollbackFailure hook + structured
 * log so ops can manual-cleanup.
 *
 * Skip step 2 if customerOrgAuth0OrgId is null — the customer-org isn't
 * in Auth0 Organizations yet (mid-rollout case). Returning ok=false with
 * an explicit error makes the missing-precondition visible at flash_err
 * instead of silently failing inside Auth0.
 */
async function runBothOrNeither(args: {
  deps: SamlRoutesDeps;
  ctx: ResellerOnCustomerContext;
  displayName: string;
  parsed: { entityId: string; signInEndpoint: string; x509Cert: string };
  logger: { error: (obj: unknown, msg?: string) => void };
}): Promise<BothOrNeitherOutcome> {
  const { deps, ctx, displayName, parsed, logger } = args;
  if (!deps.orgIdpConnectionService || !deps.auth0ManagementClient) {
    return { ok: false, error: 'Services unavailable.' };
  }
  if (!ctx.customerOrgAuth0OrgId) {
    return { ok: false, error: 'Customer org is not yet provisioned in Auth0 Organizations — contact support.' };
  }

  let auth0ConnectionId: string | undefined;
  try {
    // Step 1: Auth0 createConnection. If fails, no rollback needed.
    const conn = await deps.auth0ManagementClient.createConnection({
      name: `reseller-${ctx.resellerId}-${ctx.customerOrgId}-saml`.slice(0, 64),
      strategy: 'samlp',
      displayName,
      options: {
        signInEndpoint: parsed.signInEndpoint,
        signingCert: parsed.x509Cert,
      } as Record<string, unknown>,
    });
    auth0ConnectionId = conn.id;

    // Step 2: Auth0 enableConnection (LOAD-BEARING — without this step the
    // connection exists but isn't routed; SAML login fails silently).
    await deps.auth0ManagementClient.enableConnection(
      ctx.customerOrgAuth0OrgId,
      conn.id,
    );

    // Step 3: DB INSERT.
    const saved = await runAsSystem(() =>
      deps.orgIdpConnectionService!.create({
        orgId: ctx.customerOrgId,
        auth0ConnectionId: conn.id,
        strategy: 'samlp',
        displayName,
        entityId: parsed.entityId,
        createdByUserId: ctx.callerUserId,
      }),
    );
    return { ok: true, connectionId: saved.id, auth0ConnectionId: conn.id };
  } catch (err) {
    logger.error({ err, ctx, auth0ConnectionId }, 'reseller-saml BOTH-OR-NEITHER failed');
    if (auth0ConnectionId) {
      try {
        await deps.auth0ManagementClient.deleteConnection(auth0ConnectionId);
      } catch (rollbackErr) {
        // WARDEN Finding 2 closure: rollback-of-rollback observability.
        // Structured fields + onRollbackFailure hook so ops can detect
        // orphan-Auth0-connection without manual log-mining.
        const errClass = rollbackErr instanceof Error ? rollbackErr.constructor.name : typeof rollbackErr;
        const errMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        logger.error(
          {
            event: 'reseller_saml_rollback_failure',
            auth0_connection_id: auth0ConnectionId,
            customer_org_id: ctx.customerOrgId,
            reseller_org_id: ctx.resellerId,
            err_class: errClass,
            err_message: errMessage,
          },
          'reseller-saml rollback of createConnection failed — orphan Auth0 connection requires manual cleanup',
        );
        deps.onRollbackFailure?.({
          auth0ConnectionId,
          errClass,
          errMessage,
          customerOrgId: ctx.customerOrgId,
        });
      }
    }
    return { ok: false, error: 'Failed to create connection — check logs.' };
  }
}
