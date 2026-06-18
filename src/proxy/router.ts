import type { FastifyInstance } from 'fastify';
import replyFrom from '@fastify/reply-from';
import { nanoid } from 'nanoid';
import { injectCredentials, resolveUserId, AuthError } from './credential-injector.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { CreditService } from '../billing/credit-service.js';
import { getVendor } from '../credentials/vendor-config.js';
import { config } from '../config.js';
import { ResultCache, VENDOR_TOOL_CONFIG } from './result-cache.js';
import { shouldCapturePrompt, captureArguments, summarizeResponse } from '../audit/prompt-capture.js';
import { getSql } from '../db/context.js';
import { tierGate, tierDeniedRpcMessage } from '../auth/tier-gate.js';

/**
 * Build the upstream header set for a request proxied to a vendor MCP
 * container. The incoming client headers are NOT forwarded wholesale —
 * only `mcp-session-id` is carried through (the MCP Streamable HTTP
 * protocol needs it for session continuity). Everything else — Cookie,
 * the gateway Authorization JWT, X-Forwarded-*, arbitrary client headers —
 * is dropped. The result is a fixed allowlist plus the injected vendor
 * credentials, matching the manual-fetch path's containerHeaders in this
 * same file and gateway PR #88 M1.
 *
 * The previous `reply.from` rewriteRequestHeaders spread every client
 * header verbatim (stripping only Authorization), leaking client headers
 * into the per-vendor container. Exported so the allowlist contract is
 * unit-tested directly: a regression that re-forwards client headers
 * wholesale surfaces as a non-allowlisted key in the output.
 */
export function buildUpstreamHeaders(
  clientHeaders: Record<string, string | string[] | undefined>,
  injectionHeaders: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...injectionHeaders,
  };
  const sessionId = clientHeaders['mcp-session-id'];
  if (typeof sessionId === 'string' && sessionId) {
    out['mcp-session-id'] = sessionId;
  }
  return out;
}

interface ProxyDeps {
  credentialService: CredentialService;
  orgService: OrgService;
  billingGate: BillingGate;
  /** Optional. When provided, successful tools/call responses (cached or live)
   *  record one credit per call against the org. Personal-scope calls (no orgId)
   *  are not metered. Fire-and-forget. */
  creditService?: CreditService;
}

/**
 * Fastify plugin that registers the MCP reverse-proxy route.
 *
 * Requests to `/v1/:vendor/mcp` are authenticated via JWT,
 * enriched with vendor-specific credential headers, then
 * proxied to the corresponding MCP server container.
 */
export function proxyRoutes(deps: ProxyDeps) {
  const { credentialService, orgService, billingGate, creditService } = deps;

  const resultCache = new ResultCache();

  return async function plugin(app: FastifyInstance): Promise<void> {
    await app.register(replyFrom);

    app.all<{ Params: { vendor: string } }>(
      '/v1/:vendor/mcp',
      {
        config: {
          rateLimit: {
            timeWindow: '1 hour',
            keyGenerator: async (request) => {
              const userId = await resolveUserId(request.headers.authorization);
              const vendor = (request.params as { vendor: string }).vendor;
              return userId ? `${userId}:${vendor}` : request.ip;
            },
            max: async (request) => {
              const userId = await resolveUserId(request.headers.authorization);
              if (!userId) return 100; // unauthenticated fallback
              return billingGate.getRateLimit(userId);
            },
          },
        },
      },
      async (request, reply) => {
        const { vendor: vendorSlug } = request.params;
        const authHeader = request.headers.authorization;
        const startTime = Date.now();

        // No auth header -- respond per MCP / OAuth 2.1 spec
        if (!authHeader) {
          const vendorConfig = getVendor(vendorSlug);
          if (!vendorConfig) {
            return reply.code(404).send({ error: `Unknown vendor: ${vendorSlug}` });
          }

          return reply
            .code(401)
            .header(
              'WWW-Authenticate',
              `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/v1/${vendorSlug}/mcp"`,
            )
            .send({ error: 'Authentication required' });
        }

        try {
          // Signal deprecation — clients should migrate to the unified /v1/mcp endpoint
          reply.header('Deprecation', 'true');
          reply.header('Link', `<${config.baseUrl}/v1/mcp>; rel="successor-version"`);

          const injection = await injectCredentials(
            authHeader,
            vendorSlug,
            credentialService,
            orgService,
          );
          const vendorConfig = getVendor(vendorSlug)!;

          // --------------- Streamable HTTP SSE stream ---------------
          // GET /v1/:vendor/mcp opens a server-sent events stream for receiving
          // server-pushed notifications. Most vendor containers don't send
          // server-initiated events, but mcp-remote's EventSource treats ANY
          // non-200 response (including the 405 our containers return) as a
          // fatal connection failure, triggering an infinite reconnect loop and
          // cascading re-auth popups. Return an authenticated empty SSE stream
          // instead; all actual MCP communication travels via POST anyway.
          if (request.method === 'GET') {
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
            return;
          }

          // Build headers for direct fetch() calls to the vendor container.
          // Must include Mcp-Session-Id so Streamable HTTP containers can
          // associate the request with their initialised session — reply.from()
          // passes it automatically, but our manual fetch() calls do not.
          // Accept must include text/event-stream per the MCP Streamable HTTP
          // spec; without it some containers return 406 Not Acceptable.
          const sessionId = request.headers['mcp-session-id'];
          const containerHeaders: Record<string, string> = {
            'accept': 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...injection.headers,
            ...(sessionId ? { 'mcp-session-id': sessionId as string } : {}),
          };

          // Extract MCP method and tool name from JSON-RPC body
          const body = request.body as {
            id?: unknown;
            method?: string;
            params?: { name?: string };
          } | undefined;
          const mcpMethod = body?.method;
          // For tools/call, the actual tool name is in params.name
          const toolName = mcpMethod === 'tools/call'
            ? body?.params?.name
            : mcpMethod;

          // --------------- Tool allowlist enforcement ---------------
          // Only applies to org credentials; personal creds bypass
          if (injection.orgId && mcpMethod) {
            const membership = await orgService.getMembership(injection.orgId, injection.userId);
            const role = membership?.role ?? 'member';

            // --------------- Permission-tier runtime gate (Phase-2) ---------------
            // Gate every tools/call by callerCanInvoke(callerTier, tool). Flag-off =
            // provable-no-effect (tierGate short-circuits when config.permissionTiers
            // is false). Sits BEFORE the existing tool-allowlist enforcement so a
            // tier-deny short-circuits the allowlist lookup (cheaper) — both checks
            // are independent intersections in the request path.
            //
            // CARVE-OUT: this branch only fires when `injection.orgId` is set
            // (org-scoped credentials). Personal credentials (BYOC user-scope) have
            // no OrgRole to resolve — tier is an ORG concept. Personal-cred calls
            // are an EXPLICIT non-org-context allowlist carve-out, not a silent
            // fail-open: they pass through this site unchanged. The outer
            // `if (injection.orgId && mcpMethod)` is the carve-out boundary.
            //
            // FAIL-CLOSED on membership-null: if membership is missing for an
            // org-scoped injection (shouldn't happen — credential-injector gates
            // this — but paranoid-safety), tierGate gets `effectiveRole: null`
            // and DENIES via `unresolvable-caller`. We pass the raw value
            // (no `?? 'member'` default) so a null role explicitly fail-closes.
            if (mcpMethod === 'tools/call' && toolName) {
              const tierResult = tierGate({
                effectiveRole: membership?.role ?? null,
                vendorSlug,
                toolName,
                orgId: injection.orgId,
                actorId: injection.userId,
              });
              if (!tierResult.allowed) {
                return reply.send({
                  jsonrpc: '2.0',
                  id: body?.id ?? null,
                  error: {
                    code: -32601,
                    message: tierDeniedRpcMessage(tierResult.reason, toolName),
                  },
                });
              }
            }

            // Owners are never filtered
            if (role !== 'owner') {
              const allowlist = await orgService.getToolAllowlist(
                injection.orgId,
                vendorSlug,
                role,
              );

              if (allowlist !== null) {
                // Block tools/call if tool not in allowlist
                if (mcpMethod === 'tools/call' && toolName && !allowlist.includes(toolName)) {
                  return reply.send({
                    jsonrpc: '2.0',
                    id: body?.id ?? null,
                    error: {
                      code: -32601,
                      message: `Tool "${toolName}" is not permitted for your role`,
                    },
                  });
                }

                // Filter tools/list response (Streamable HTTP vendors only — SSE transport
                // doesn't support standalone POST requests so we skip filtering for those)
                if (mcpMethod === 'tools/list' && (vendorConfig.mcpPath ?? '/mcp') === '/mcp') {
                  const vendorRes = await fetch(`${vendorConfig.containerUrl}/mcp`, {
                    method: 'POST',
                    headers: containerHeaders,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const vendorData = (await vendorRes.json()) as {
                    jsonrpc: string;
                    id: unknown;
                    result?: { tools?: { name: string }[] };
                  };

                  if (vendorData.result?.tools) {
                    vendorData.result.tools = vendorData.result.tools.filter(
                      (t) => allowlist.includes(t.name),
                    );
                  }

                  // Log the request
                  const responseTimeMs = Date.now() - startTime;
                  getSql()`
                    INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
                    VALUES (${nanoid()}, ${injection.userId}, ${injection.orgId ?? null}, ${vendorSlug}, ${toolName ?? null}, ${vendorRes.status}, ${responseTimeMs})
                  `.catch((err) => {
                    app.log.warn({ err }, 'Failed to log request');
                  });

                  return reply.send(vendorData);
                }
              }
            }
          }

          // Determine cache scope:
          //   team credentials  → scoped to the team (teams may have different vendor instances)
          //   org credentials   → shared among all org members (same vendor instance)
          //   personal creds    → isolated to the individual user
          const cacheScope = injection.teamId
            ? `team:${injection.teamId}`
            : injection.orgId
              ? `org:${injection.orgId}`
              : `user:${injection.userId}`;

          // Resolve prompt capture once per request. Both INSERT sites
          // below consult `capture` to decide whether tool_arguments and
          // response_summary get persisted.
          const capture = await shouldCapturePrompt(
            orgService,
            billingGate,
            injection.orgId,
          );

          // Check if this tool call is cacheable or a write that should invalidate.
          // Only applies to tools/call — other MCP methods (initialize, tools/list…) pass through.
          const vendorToolConfig = mcpMethod === 'tools/call' && toolName
            ? VENDOR_TOOL_CONFIG[vendorSlug]?.[toolName]
            : undefined;

          if (vendorToolConfig && !vendorToolConfig.isWrite && vendorToolConfig.ttlMs > 0) {
            // --- Cacheable read ---
            const params = (body as { params?: { arguments?: unknown } } | undefined)?.params?.arguments;
            const { value: cachedOrFetched, fromCache } = await resultCache.getOrFetch(
              cacheScope,
              vendorSlug,
              toolName!,
              params,
              async () => {
                const vendorRes = await fetch(
                  `${vendorConfig.containerUrl}${vendorConfig.mcpPath ?? '/mcp'}`,
                  {
                    method: 'POST',
                    headers: containerHeaders,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(30_000),
                  },
                );
                if (!vendorRes.ok) {
                  throw new Error(`Vendor returned HTTP ${vendorRes.status}`);
                }
                return vendorRes.json();
              },
            );

            // Log (fire-and-forget)
            const responseTimeMs = Date.now() - startTime;
            const toolArgs = capture ? captureArguments((body as { params?: { arguments?: unknown } } | undefined)?.params?.arguments) : null;
            const respSummary = capture ? summarizeResponse(cachedOrFetched) : null;
            getSql()`
              INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, tool_arguments, response_summary)
              VALUES (${nanoid()}, ${injection.userId}, ${injection.orgId ?? null}, ${vendorSlug}, ${toolName ?? null}, ${200}, ${responseTimeMs}, ${toolArgs}, ${respSummary})
            `.catch((err) => { app.log.warn({ err }, 'Failed to log request'); });

            // Credit metering — only for tools/call against an org (personal
            // calls are not metered). Cached responses still consume a credit.
            if (creditService && mcpMethod === 'tools/call' && injection.orgId) {
              creditService
                .recordUsage(injection.orgId, injection.userId, vendorSlug)
                .catch((err) => { app.log.warn({ err }, 'Failed to record credit usage'); });
            }

            if (fromCache) {
              app.log.debug({ vendorSlug, toolName, cacheScope }, 'Result cache hit');
            }

            return reply.send(cachedOrFetched);
          }

          // Fire-and-forget usage log (don't block the response)
          const logEntry = {
            id: nanoid(),
            userId: injection.userId,
            orgId: injection.orgId,
            vendorSlug,
            toolName,
            startTime,
            // Snapshot of arguments at request time. The reply.from() body
            // is streamed back to the client so response_summary isn't
            // available on this path — only the unified router can capture
            // responses for live (uncached) tool calls.
            toolArgs: capture ? captureArguments((body as { params?: { arguments?: unknown } } | undefined)?.params?.arguments) : null,
          };

          reply.raw.on('finish', () => {
            const responseTimeMs = Date.now() - logEntry.startTime;
            getSql()`
              INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, tool_arguments)
              VALUES (${logEntry.id}, ${logEntry.userId}, ${logEntry.orgId ?? null}, ${logEntry.vendorSlug}, ${logEntry.toolName ?? null}, ${reply.statusCode}, ${responseTimeMs}, ${logEntry.toolArgs})
            `.catch((err) => {
              app.log.warn({ err }, 'Failed to log request');
            });

            // Credit metering — only on successful tools/call against an org.
            if (
              creditService &&
              mcpMethod === 'tools/call' &&
              logEntry.orgId &&
              reply.statusCode < 400
            ) {
              creditService
                .recordUsage(logEntry.orgId, logEntry.userId, logEntry.vendorSlug)
                .catch((err) => { app.log.warn({ err }, 'Failed to record credit usage'); });
            }

            // Eager cache invalidation: if this was a write tool, bump the entity
            // generation so all cached reads for this org+vendor+entityType become stale.
            if (vendorToolConfig?.isWrite && reply.statusCode < 400) {
              resultCache.invalidate(cacheScope, vendorSlug, toolName!).catch((err) => {
                app.log.warn({ err }, 'Failed to invalidate result cache');
              });
            }
          });

          return reply.from(`${vendorConfig.containerUrl}${vendorConfig.mcpPath ?? '/mcp'}`, {
            rewriteRequestHeaders: (_req, headers) => buildUpstreamHeaders(headers, injection.headers),
          });
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.code(err.statusCode).send({ error: err.message });
          }
          request.log.error(err, 'Proxy error');
          return reply.code(500).send({ error: 'Internal proxy error' });
        }
      },
    );
  };
}
