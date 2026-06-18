/**
 * Unified MCP endpoint — serves all vendors through a single URL (/v1/mcp).
 *
 * Instead of one MCP server per vendor (each requiring its own OAuth flow),
 * this endpoint aggregates all connected vendors behind a single JWT.
 *
 * Tool names are prefixed with `{vendorSlug}__` to avoid collisions:
 *   - tools/list: merges tools from all vendors the user has credentials for
 *   - tools/call: extracts vendor from prefix, proxies to the correct container
 *   - initialize: handled locally (returns gateway serverInfo)
 */

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { injectCredentials, resolveUserId, AuthError } from './credential-injector.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import { getVendor, getVendorSlugs } from '../credentials/vendor-config.js';
import { composeToolScope, scopeAllows, filterToolsByScope } from '../org/scope-enforcement.js';
import { config } from '../config.js';
import { ToolCache, type McpTool } from './tool-cache.js';
import { ResultCache, VENDOR_TOOL_CONFIG } from './result-cache.js';
import { shouldCapturePrompt, captureArguments, summarizeResponse } from '../audit/prompt-capture.js';
import { getSql } from '../db/context.js';
import { tierGate, tierDeniedRpcMessage } from '../auth/tier-gate.js';
import { getUserPrimaryOrgId } from './request-org-context.js';
import { getOnpremCapsForOrg } from './onprem-capability-lookup.js';
import { decideOnpremRoute } from './onprem-fork-decision.js';
import type { RelayControlPlaneClient } from './relay-control-plane-client.js';

interface UnifiedProxyDeps {
  credentialService: CredentialService;
  orgService: OrgService;
  billingGate: BillingGate;
  toolCache: ToolCache;
  /**
   * Gateway↔relay control-plane client for on-prem-vendor dispatch. Optional;
   * absent (null/undefined) means the on-prem path is not configured for this
   * gateway instance, and the unified-router's on-prem-fork short-circuits to
   * "no on-prem path configured" (falls through to the standard vendor path).
   * The relay-side endpoint is the same process the relay container runs;
   * wired at gateway boot via readControlPlaneConfigFromEnv().
   */
  relayControlPlane?: RelayControlPlaneClient | null;
}

/**
 * Truncate a tool description to keep input-token cost bounded.
 * 200 chars retains enough semantic content for tool selection without
 * passing through marketing copy, verbose enum lists, or repeated context.
 */
function truncateDescription(desc: string, maxLen = 200): string {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen - 1) + '…';
}

export function unifiedProxyRoutes(deps: UnifiedProxyDeps) {
  const { credentialService, orgService, billingGate, toolCache, relayControlPlane = null } = deps;
  const resultCache = new ResultCache();

  return async function plugin(app: FastifyInstance): Promise<void> {
    // GET /v1/mcp — SSE heartbeat stream (keeps mcp-remote happy)
    app.get('/v1/mcp', async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        return reply
          .code(401)
          .header(
            'WWW-Authenticate',
            `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/v1/mcp"`,
          )
          .send({ error: 'Authentication required' });
      }

      // Verify the JWT is valid (don't need vendor-specific injection)
      const userId = await resolveUserId(authHeader);
      if (!userId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.writeHead(200);
      reply.raw.write(':ok\n\n');

      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) {
          reply.raw.write(':heartbeat\n\n');
        } else {
          clearInterval(heartbeat);
        }
      }, 30_000);

      request.raw.on('close', () => clearInterval(heartbeat));
    });

    // POST /v1/mcp — main JSON-RPC handler
    app.post(
      '/v1/mcp',
      {
        config: {
          rateLimit: {
            timeWindow: '1 hour',
            keyGenerator: async (request) => {
              const userId = await resolveUserId(request.headers.authorization);
              return userId ? `unified:${userId}` : request.ip;
            },
            max: async (request) => {
              const userId = await resolveUserId(request.headers.authorization);
              if (!userId) return 100;
              return billingGate.getRateLimit(userId);
            },
          },
        },
      },
      async (request, reply) => {
        const authHeader = request.headers.authorization;
        const startTime = Date.now();

        if (!authHeader) {
          return reply
            .code(401)
            .header(
              'WWW-Authenticate',
              `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/v1/mcp"`,
            )
            .send({ error: 'Authentication required' });
        }

        const body = request.body as {
          id?: unknown;
          method?: string;
          params?: { name?: string; arguments?: unknown };
        } | undefined;

        const mcpMethod = body?.method;

        try {
          // --- initialize: respond locally ---
          if (mcpMethod === 'initialize') {
            return reply.send({
              jsonrpc: '2.0',
              id: body?.id ?? null,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'mcp-gateway', version: '1.0.0' },
              },
            });
          }

          // --- notifications/initialized: acknowledge ---
          if (mcpMethod === 'notifications/initialized') {
            // No response needed for notifications
            return reply.code(202).send();
          }

          // Verify JWT for all other methods
          const userId = await resolveUserId(authHeader);
          if (!userId) {
            return reply.code(401).send({ error: 'Invalid or expired token' });
          }

          // --- tools/list: aggregate from all vendors ---
          if (mcpMethod === 'tools/list') {
            const tools = await aggregateTools(userId, authHeader);

            // Log (fire-and-forget)
            const responseTimeMs = Date.now() - startTime;
            getSql()`
              INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
              VALUES (${nanoid()}, ${userId}, ${null}, ${'_unified'}, ${'tools/list'}, ${200}, ${responseTimeMs})
            `.catch((err) => {
              app.log.warn({ err }, 'Failed to log unified request');
            });

            return reply.send({
              jsonrpc: '2.0',
              id: body?.id ?? null,
              result: { tools },
            });
          }

          // --- tools/call: route to vendor ---
          if (mcpMethod === 'tools/call') {
            const prefixedName = body?.params?.name;
            if (!prefixedName) {
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: { code: -32602, message: 'Missing params.name' },
              });
            }

            const separatorIdx = prefixedName.indexOf('__');
            if (separatorIdx < 1) {
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: {
                  code: -32602,
                  message: `Invalid tool name format: expected "{vendor}__{tool}", got "${prefixedName}"`,
                },
              });
            }

            const vendorSlug = prefixedName.slice(0, separatorIdx);
            const originalToolName = prefixedName.slice(separatorIdx + 2);

            // ---------------------------------------------------------------
            // ON-PREM FORK (PR #2 §4 step 5)
            //
            // Before resolving a cloud vendor, check whether this user's org
            // has an on-prem tunnel registering THIS vendor slug as a granted
            // capability. If so, route via the relay control-plane; the
            // request never touches a cloud vendor URL.
            //
            // Boss pin 1: user→org resolution is memoized via getUserPrimaryOrgId
            // (request-scope), shared with injectCredentials' internal lookup —
            // ONE read per request, not two.
            //
            // Boss pin 2: getOnpremCapsForOrg memoizes the onprem_tunnels.caps
            // read per request — multiple tools/call dispatches within one
            // request hit the cache, not the DB.
            //
            // Boss pin 3: capability match is EXACT slug equality (caps array
            // .includes(vendorSlug)) — no normalization, no case folding, no
            // prefix matching. Same discipline as HMAC body-binding (verifier
            // sees exactly what signer set).
            //
            // Boss pin 4: three distinct failure-mode mappings at the fork:
            //   (a) slug NOT in caps          → "no on-prem path for this vendor";
            //                                   FALL THROUGH to standard getVendor
            //                                   path below (cloud routing).
            //   (b) slug IN caps but no live tunnel held OR control-plane not
            //       configured                 → "on-prem configured but unreachable";
            //                                   typed error; do NOT fall through
            //                                   (the operator chose on-prem; a
            //                                   silent fall-back to cloud would
            //                                   violate that choice).
            //   (c) slug in caps + control-plane call → map RouteResult per
            //                                   scope §3 decision (iv) (handled
            //                                   in the relayControlPlane.route()
            //                                   call below).
            // ---------------------------------------------------------------
            // Resolve user → org (memoized request-scope, α-helper) and the
            // on-prem caps for that org (memoized request-scope). The actual
            // branch logic lives in decideOnpremRoute() (unit-tested), so the
            // three (a)/(b)/(c) cases stay pin-4 explicit and regression-safe.
            const userIdForOnpremCheck = await resolveUserId(authHeader);
            const onpremOrgId = userIdForOnpremCheck
              ? await getUserPrimaryOrgId(request, userIdForOnpremCheck, orgService)
              : null;
            const onpremCaps = onpremOrgId ? await getOnpremCapsForOrg(request, onpremOrgId) : null;

            const onpremDecision = decideOnpremRoute({
              userId: userIdForOnpremCheck,
              orgId: onpremOrgId,
              onpremCaps,
              vendorSlug,
              hasControlPlaneClient: relayControlPlane !== null,
            });

            if (onpremDecision.kind === 'configured_but_unreachable') {
              // (b) — typed error; do NOT fall through to cloud.
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: { code: -32000, message: 'on-prem path configured but control plane unreachable' },
              });
            }

            if (onpremDecision.kind === 'dispatch_via_control_plane') {
              // (c) — dispatch via control-plane; map RouteResult per (iv).
              // relayControlPlane is non-null per the decision invariant.
              const onpremStart = Date.now();
              const routeResult = await relayControlPlane!.route({
                subtenantId: onpremDecision.subtenantId,
                target: vendorSlug,
                payload: {
                  jsonrpc: '2.0',
                  id: body?.id ?? null,
                  method: 'tools/call',
                  params: { name: originalToolName, arguments: body?.params?.arguments ?? {} },
                },
              });
              const onpremDurationMs = Date.now() - onpremStart;
              // Customer-facing request_log row — COLLAPSED status (matches
              // what the client sees). Per warden's operator-only-audit pin
              // (scope §3 decision (iv)): the customer-facing Audit Log tab
              // MUST NOT distinguish capability_not_granted from
              // tunnel_offline — both surface as 401-ish "unknown vendor"
              // for the client; here both get status 404 in request_log to
              // preserve that ambiguity for the customer audit feed.
              const customerStatus = routeResult.ok
                ? 200
                : routeResult.reason === 'capability_not_granted' || routeResult.reason === 'tunnel_offline'
                  ? 404
                  : routeResult.reason === 'tunnel_timeout'
                    ? 504
                    : routeResult.reason === 'tunnel_disconnected'
                      ? 502
                      : routeResult.reason === 'overloaded'
                        ? 503
                        : 500;
              getSql()`
                INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, source)
                VALUES (${nanoid()}, ${userIdForOnpremCheck!}, ${onpremDecision.subtenantId}, ${vendorSlug}, ${originalToolName}, ${customerStatus}, ${onpremDurationMs}, ${'onprem'})
              `.catch((err) => { app.log.warn({ err }, 'Failed to log on-prem request to request_log'); });

              // Operator-facing admin_audit_log row — PRECISE relay-return-
              // reason. ONLY on failure (success paths get only request_log).
              // metadata captures the discriminant so operator-side telemetry
              // distinguishes capability_not_granted from tunnel_offline even
              // though the customer sees the same response. Warden's
              // operator-only-audit pin: precise reasons ONLY in
              // admin_audit_log, never in request_log.
              if (!routeResult.ok) {
                const reason = routeResult.reason;
                const eventMeta = {
                  vendor_slug: vendorSlug,
                  tool_name: originalToolName,
                  precise_reason: reason,
                  customer_visible_status: customerStatus,
                  duration_ms: onpremDurationMs,
                  ...(reason === 'control_plane_unreachable' ? { detail: (routeResult as { detail?: string }).detail ?? null } : {}),
                  ...(reason === 'unknown_error' ? { status: (routeResult as { status?: number }).status ?? null } : {}),
                };
                getSql()`
                  INSERT INTO admin_audit_log (id, org_id, actor_id, event_type, metadata)
                  VALUES (${nanoid()}, ${onpremDecision.subtenantId}, ${userIdForOnpremCheck!}, ${'onprem_request_failed'}, ${getSql().json(eventMeta)})
                `.catch((err) => { app.log.warn({ err }, 'Failed to log on-prem failure to admin_audit_log'); });
              }

              if (routeResult.ok) {
                // The relay returned a JSON-RPC frame; forward as-is.
                const responseBody =
                  (routeResult.response.payload as object | undefined) ??
                  (routeResult.response.error
                    ? { jsonrpc: '2.0', id: body?.id ?? null, error: routeResult.response.error }
                    : { jsonrpc: '2.0', id: body?.id ?? null, result: null });
                return reply.send(responseBody);
              }
              // Failure mode mapping per scope §3 decision (iv) — coarse,
              // operator-precise reason captured in admin_audit_log (above);
              // client-visible JSON-RPC error is generic.
              const errMap: Record<string, { code: number; message: string }> = {
                tunnel_offline: { code: -32000, message: 'on-prem tunnel offline' },
                tunnel_timeout: { code: -32000, message: 'on-prem tunnel timeout' },
                tunnel_disconnected: { code: -32000, message: 'on-prem tunnel disconnected' },
                capability_not_granted: { code: -32601, message: `Unknown vendor: ${vendorSlug}` },
                unauthorized: { code: -32000, message: 'control plane error' },
                malformed_body: { code: -32000, message: 'control plane error' },
                overloaded: { code: -32000, message: 'on-prem path overloaded' },
                control_plane_unreachable: { code: -32000, message: 'control plane unreachable' },
                unknown_error: { code: -32000, message: 'control plane error' },
              };
              const mapped = errMap[routeResult.reason] ?? { code: -32000, message: 'control plane error' };
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: mapped,
              });
            }
            // (a) — onpremDecision.kind === 'fall_through_to_cloud': continue
            // to the standard getVendor() path below.

            const vendorConfig = getVendor(vendorSlug);
            if (!vendorConfig) {
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: { code: -32601, message: `Unknown vendor: ${vendorSlug}` },
              });
            }

            // Inject credentials for this vendor.
            // Tokens minted at /v1/mcp carry `vendor: ''`; the per-vendor
            // binding check would 403 every call. Safe to skip — the unified
            // endpoint only injects credentials the authenticated user owns.
            const injection = await injectCredentials(
              authHeader,
              vendorSlug,
              credentialService,
              orgService,
              { allowUnscopedToken: true },
            );

            // Tool scope enforcement (WYREAI-61): composeToolScope handles
            // org+role (existing behavior, flag-off) and optionally intersects
            // a team allowlist when CONDUIT_TEAM_SCOPING=true AND injection
            // carries a teamId. The previous "org credentials only" comment
            // (now removed via this refactor) referred to which ALLOWLIST is
            // consulted (org-row), not which CRED-PATH is enforced — the
            // team-cred path already set injection.orgId, so the old gate
            // ALREADY fired on team-cred. Flag-on layers team-allowlist in
            // as an additional narrowing source; no pre-existing bypass.
            const scope = await composeToolScope(orgService, vendorSlug, {
              userId: injection.userId,
              orgId: injection.orgId,
              teamId: injection.teamId,
            });
            if (!scopeAllows(scope, originalToolName)) {
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: {
                  code: -32601,
                  message: `Tool "${originalToolName}" is not permitted for your scope`,
                },
              });
            }

            // --------------- Permission-tier runtime gate (Phase-2) ---------------
            // Flag-off = provable-no-effect (tierGate short-circuits when
            // config.permissionTiers is false). Sits AFTER scope-allows and
            // BEFORE the rewrite+vendor-fetch path. Both checks are independent
            // intersections; tier-deny short-circuits before the prompt-capture
            // gate + cache + session + vendor-fetch.
            //
            // CARVE-OUT: this branch only fires when `injection.orgId` is set
            // (org-scoped credentials). Personal credentials (BYOC user-scope)
            // pass through unchanged — tier is an ORG concept; personal-cred is
            // a STRUCTURAL non-org-context, not a silent-fail-open. The
            // injection.orgId-vs-userId split is set by the credential-injector
            // based on the cred-record itself, NOT by caller request input —
            // an org-scoped tool-call cannot be coerced into the no-orgId path
            // by the caller. (Warden DEEP review: verify this property at the
            // credential-injector seam.)
            //
            // FAIL-CLOSED on membership-null: pass raw `membership?.role ?? null`
            // (NOT `?? 'member'` — that would write-tier an unresolvable caller,
            // a silent fail-open). null → tierGate DENY via `unresolvable-caller`.
            if (injection.orgId) {
              const membership = await orgService.getMembership(injection.orgId, injection.userId);
              const role = membership?.role ?? null;
              const tierResult = tierGate({
                effectiveRole: role,
                vendorSlug,
                toolName: originalToolName,
                orgId: injection.orgId,
                actorId: injection.userId,
              });
              if (!tierResult.allowed) {
                return reply.send({
                  jsonrpc: '2.0',
                  id: body?.id ?? null,
                  error: {
                    code: -32601,
                    message: tierDeniedRpcMessage(tierResult.reason, originalToolName),
                  },
                });
              }
            }

            // Rewrite body with un-prefixed tool name
            const proxyBody = {
              ...body,
              params: { ...body!.params, name: originalToolName },
            };

            const containerHeaders: Record<string, string> = {
              'accept': 'application/json, text/event-stream',
              'content-type': 'application/json',
              ...injection.headers,
            };

            // Resolve prompt capture once per request. Both INSERT sites
            // below consult `capture` to decide whether tool_arguments and
            // response_summary get persisted.
            const capture = await shouldCapturePrompt(
              orgService,
              billingGate,
              injection.orgId,
            );

            // Determine cache scope:
            //   team credentials  → scoped to the team (teams may have different vendor instances)
            //   org credentials   → shared among all org members (same vendor instance)
            //   personal creds    → isolated to the individual user
            const cacheScope = injection.teamId
              ? `team:${injection.teamId}`
              : injection.orgId
                ? `org:${injection.orgId}`
                : `user:${injection.userId}`;

            // Check result cache
            const vendorToolConfig = VENDOR_TOOL_CONFIG[vendorSlug]?.[originalToolName];

            if (vendorToolConfig && !vendorToolConfig.isWrite && vendorToolConfig.ttlMs > 0) {
              const params = body?.params?.arguments;
              const { value: cachedOrFetched, fromCache } = await resultCache.getOrFetch(
                cacheScope,
                vendorSlug,
                originalToolName,
                params,
                async () => {
                  const vendorRes = await fetch(
                    `${vendorConfig.containerUrl}${vendorConfig.mcpPath ?? '/mcp'}`,
                    {
                      method: 'POST',
                      headers: containerHeaders,
                      body: JSON.stringify(proxyBody),
                      signal: AbortSignal.timeout(30_000),
                    },
                  );
                  if (!vendorRes.ok) {
                    throw new Error(`Vendor returned HTTP ${vendorRes.status}`);
                  }
                  return vendorRes.json();
                },
              );

              const responseTimeMs = Date.now() - startTime;
              const toolArgs = capture ? captureArguments(body?.params?.arguments) : null;
              const respSummary = capture ? summarizeResponse(cachedOrFetched) : null;
              getSql()`
                INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, tool_arguments, response_summary, source)
                VALUES (${nanoid()}, ${injection.userId}, ${injection.orgId ?? null}, ${vendorSlug}, ${originalToolName}, ${200}, ${responseTimeMs}, ${toolArgs}, ${respSummary}, ${'mcp'})
              `.catch((err) => { app.log.warn({ err }, 'Failed to log request'); });

              if (fromCache) {
                app.log.debug({ vendorSlug, originalToolName, cacheScope }, 'Unified result cache hit');
              }

              return reply.send(cachedOrFetched);
            }

            // Direct proxy for uncacheable / write tools
            const vendorRes = await fetch(
              `${vendorConfig.containerUrl}${vendorConfig.mcpPath ?? '/mcp'}`,
              {
                method: 'POST',
                headers: containerHeaders,
                body: JSON.stringify(proxyBody),
                signal: AbortSignal.timeout(30_000),
              },
            );

            const responseTimeMs = Date.now() - startTime;
            const vendorData = await vendorRes.json();
            const toolArgsForLog = capture ? captureArguments(body?.params?.arguments) : null;
            const respSummaryForLog = capture && vendorRes.status < 400 ? summarizeResponse(vendorData) : null;
            getSql()`
              INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, tool_arguments, response_summary, source)
              VALUES (${nanoid()}, ${injection.userId}, ${injection.orgId ?? null}, ${vendorSlug}, ${originalToolName}, ${vendorRes.status}, ${responseTimeMs}, ${toolArgsForLog}, ${respSummaryForLog}, ${'mcp'})
            `.catch((err) => { app.log.warn({ err }, 'Failed to log request'); });

            // Invalidate cache on successful writes
            if (vendorToolConfig?.isWrite && vendorRes.status < 400) {
              resultCache.invalidate(cacheScope, vendorSlug, originalToolName).catch((err) => {
                app.log.warn({ err }, 'Failed to invalidate result cache');
              });
            }

            return reply.send(vendorData);
          }

          // Unknown MCP method — pass-through error
          return reply.send({
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32601, message: `Unsupported method: ${mcpMethod}` },
          });
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.code(err.statusCode).send({ error: err.message });
          }
          request.log.error(err, 'Unified proxy error');
          return reply.code(500).send({ error: 'Internal proxy error' });
        }
      },
    );

    /**
     * Fetch tools from all vendors the user has credentials for,
     * prefix each tool name with `{vendorSlug}__`.
     *
     * Performance: Phase 1 uses cheap slug-only DB queries (no decryption,
     * no OAuth refresh) to discover which vendors are connected before running
     * the full injectCredentials path. This reduces DB queries from ~104 (26
     * vendors × 4-5 queries each) down to ~3-18 for a typical user.
     *
     * Token impact: filtering to connected vendors reduces the tool list from
     * 150-250 tools (all vendors) to 40-100 (connected only), cutting input
     * token cost per LLM turn by 60-90%.
     */
    async function aggregateTools(
      userId: string,
      authHeader: string,
    ): Promise<McpTool[]> {
      const allVendorSlugs = getVendorSlugs();
      const results: McpTool[] = [];

      // --- Phase 1: cheaply determine which vendors have credentials ---
      // Service-client tokens (svc:<orgId>:<clientId>) always route through org
      // creds — skip the pre-filter and let injectCredentials handle resolution.
      const isServiceClient = userId.startsWith('svc:');
      let slugsToQuery = allVendorSlugs;

      if (!isServiceClient) {
        const connectedSlugs = new Set<string>();

        // Vendor discovery runs as a FIXED, small number of queries, each
        // awaited SEQUENTIALLY. The previous per-org/per-team Promise.all
        // fan-out hung tools/list (root cause confirmed via instrumentation):
        // a nested / dynamic-fan-out of concurrent queries on the request's
        // single reserved-transaction connection deadlocks. Flat-fixed
        // concurrent Promise.alls on that same connection are proven fine
        // (the dashboard and audit endpoints) — the precise postgres.js reason
        // for the nested-vs-flat difference is not yet characterized. Awaiting
        // the queries sequentially removes the concurrency entirely, which is
        // the universally-safe pattern used everywhere else in the codebase.
        // The set-based queries also make this O(1) in query count rather than
        // the previous O(orgs × teams) N+1.

        // 1. Personal credentials.
        const personalSlugs = await credentialService.listVendors(userId);
        personalSlugs.forEach((s) => connectedSlugs.add(s));

        // 2. Org credentials — one query across every org the user is in.
        const orgs = await orgService.getUserOrgs(userId);
        const orgSlugs = await credentialService.listOrgVendorsForOrgs(
          orgs.map((o) => o.id),
        );
        orgSlugs.forEach((s) => connectedSlugs.add(s));

        // 3. Team credentials — one query for the user's team IDs, one for the
        //    credential slugs across all of them.
        const teamIds = await orgService.getUserTeamIds(userId);
        const teamSlugs = await credentialService.listTeamVendorsForTeams(teamIds);
        teamSlugs.forEach((s) => connectedSlugs.add(s));

        slugsToQuery = allVendorSlugs.filter((s) => connectedSlugs.has(s));
      }

      // --- Phase 2: full credential injection for connected vendors only ---
      // DB work is sequentialized for the same reason as Phase 1 — concurrent
      // queries fanned out on the request's reserved-transaction connection
      // deadlock. The per-vendor tool fetch (toolCache.getTools) is a
      // vendor-container HTTP call with no DB access, so it STAYS concurrent:
      // serializing it would make tools/list latency grow linearly with
      // connected-vendor count and let one slow vendor block the rest. Hence
      // three passes — sequential DB (credential resolution), concurrent HTTP
      // (tool fetch), sequential DB (allowlist filtering).

      // Pass 1 — sequential DB: resolve credentials for each connected vendor.
      const injected: {
        slug: string;
        vendorConfig: NonNullable<ReturnType<typeof getVendor>>;
        injection: Awaited<ReturnType<typeof injectCredentials>>;
      }[] = [];
      for (const slug of slugsToQuery) {
        const vendorConfig = getVendor(slug);
        if (!vendorConfig) continue;

        try {
          const injection = await injectCredentials(
            authHeader,
            slug,
            credentialService,
            orgService,
            { allowUnscopedToken: true },
          );
          injected.push({ slug, vendorConfig, injection });
        } catch (err) {
          // error-level (not warn): a 100%-failure mode like "all tokens
          // missing vendor claim" otherwise looks like "no connected tools"
          // with no signal.
          app.log.error(
            { slug, err: err instanceof Error ? err.message : String(err) },
            'aggregateTools: credential injection failed',
          );
          // No credentials for this vendor — skip.
        }
      }

      // Pass 2 — concurrent HTTP: fetch each vendor's tools. Safe to fan out
      // ONLY because toolCache.getTools issues zero reserved-tx DB queries —
      // this premise is load-bearing (a DB query here would reintroduce the
      // Phase-1 deadlock). Verified: proxy/tool-cache.ts has NO imports at all;
      // getTools/fetchTools touch only an in-memory Map (cache + inflight
      // dedup) and the global fetch() — no getSql, no service, nothing to
      // recurse into transitively. allSettled: one vendor's fetch failure must
      // not drop the rest.
      const fetched = await Promise.allSettled(
        injected.map(async ({ slug, vendorConfig, injection }) => {
          try {
            const tools = await toolCache.getTools(
              slug,
              vendorConfig.containerUrl,
              injection.headers,
              vendorConfig.mcpPath ?? '/mcp',
            );
            return { slug, vendorConfig, injection, tools };
          } catch (err) {
            // A rejected tool fetch (vendor container down/unreachable) must
            // not vanish silently — without this it is indistinguishable from
            // "vendor has no tools". Logged here, where the slug is in scope;
            // the Pass-3 loop then skips the rejected entry.
            app.log.error(
              { slug, err: err instanceof Error ? err.message : String(err) },
              'aggregateTools: vendor tool fetch failed',
            );
            throw err;
          }
        }),
      );

      // Pass 3 — sequential DB: allowlist filtering for org credentials, then
      // prefix tool names and truncate descriptions.
      for (const result of fetched) {
        // Rejected fetches were already logged with their slug inside Pass 2.
        if (result.status !== 'fulfilled') continue;
        const { slug, vendorConfig, injection, tools } = result.value;

        // Tool scope filtering (WYREAI-61): composeToolScope absorbs the
        // org+role flag-off path AND the flag-on team-scope intersect. No
        // pre-existing team-cred bypass: the team-cred path of
        // injectCredentials sets injection.orgId (credential-injector.ts:189-190),
        // so org+role already fired on team-cred. Flag-on adds the
        // team-allowlist as an additional narrowing source. Sequential DB
        // inside the helper (membership → org allowlist → optional team
        // allowlist) preserves the reserved-tx-connection serial-only
        // contract from Pass 3's comment above.
        const scope = await composeToolScope(orgService, slug, {
          userId: injection.userId,
          orgId: injection.orgId,
          teamId: injection.teamId,
        });
        const filteredTools = filterToolsByScope(tools, scope);

        // Prefix tool names; truncate descriptions to cap input-token cost.
        // 200 chars retains full semantic value while trimming marketing copy
        // and verbose enum lists that Claude doesn't need for tool selection.
        results.push(
          ...filteredTools.map((tool) => ({
            ...tool,
            name: `${slug}__${tool.name}`,
            description: truncateDescription(
              `[${vendorConfig.name}] ${tool.description ?? ''}`,
            ),
          })),
        );
      }

      return results;
    }
  };
}
