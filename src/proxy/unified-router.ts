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
import { config } from '../config.js';
import type postgres from 'postgres';
import { ToolCache, type McpTool } from './tool-cache.js';
import { ResultCache, VENDOR_TOOL_CONFIG } from './result-cache.js';
import { shouldCapturePrompt, captureArguments, summarizeResponse } from '../audit/prompt-capture.js';

interface UnifiedProxyDeps {
  credentialService: CredentialService;
  orgService: OrgService;
  billingGate: BillingGate;
  toolCache: ToolCache;
  sql: postgres.Sql;
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
  const { credentialService, orgService, billingGate, toolCache, sql } = deps;
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
            sql`
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

            const vendorConfig = getVendor(vendorSlug);
            if (!vendorConfig) {
              return reply.send({
                jsonrpc: '2.0',
                id: body?.id ?? null,
                error: { code: -32601, message: `Unknown vendor: ${vendorSlug}` },
              });
            }

            // Inject credentials for this vendor
            const injection = await injectCredentials(
              authHeader,
              vendorSlug,
              credentialService,
              orgService,
            );

            // Tool allowlist enforcement (org credentials only)
            if (injection.orgId) {
              const membership = await orgService.getMembership(injection.orgId, injection.userId);
              const role = membership?.role ?? 'member';

              if (role !== 'owner') {
                const allowlist = await orgService.getToolAllowlist(
                  injection.orgId,
                  vendorSlug,
                  role,
                );

                if (allowlist !== null && !allowlist.includes(originalToolName)) {
                  return reply.send({
                    jsonrpc: '2.0',
                    id: body?.id ?? null,
                    error: {
                      code: -32601,
                      message: `Tool "${originalToolName}" is not permitted for your role`,
                    },
                  });
                }
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
              sql`
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
            sql`
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

        // Personal credentials — one cheap query, no decryption
        const personalSlugs = await credentialService.listVendors(userId);
        personalSlugs.forEach((s) => connectedSlugs.add(s));

        // Org + team credentials — slug-only queries per org/team
        const orgs = await orgService.getUserOrgs(userId);
        const orgSlugSets = await Promise.all(
          orgs.map(async (org) => {
            const [orgSlugs, teams] = await Promise.all([
              credentialService.listOrgVendors(org.id),
              orgService.getUserTeams(org.id, userId),
            ]);
            const teamSlugArrays = await Promise.all(
              teams.map((t) => credentialService.listTeamVendors(t.id)),
            );
            return [...orgSlugs, ...teamSlugArrays.flat()];
          }),
        );
        orgSlugSets.flat().forEach((s) => connectedSlugs.add(s));

        slugsToQuery = allVendorSlugs.filter((s) => connectedSlugs.has(s));
      }

      // --- Phase 2: full credential injection for connected vendors only ---
      const vendorResults = await Promise.allSettled(
        slugsToQuery.map(async (slug) => {
          const vendorConfig = getVendor(slug);
          if (!vendorConfig) return [];

          let injection;
          try {
            injection = await injectCredentials(
              authHeader,
              slug,
              credentialService,
              orgService,
            );
          } catch {
            // No credentials for this vendor — skip
            return [];
          }

          // Fetch tools via cache
          const tools = await toolCache.getTools(
            slug,
            vendorConfig.containerUrl,
            injection.headers,
          );

          // Apply allowlist filtering for org credentials
          let filteredTools = tools;
          if (injection.orgId) {
            const membership = await orgService.getMembership(injection.orgId, injection.userId);
            const role = membership?.role ?? 'member';

            if (role !== 'owner') {
              const allowlist = await orgService.getToolAllowlist(
                injection.orgId,
                slug,
                role,
              );

              if (allowlist !== null) {
                filteredTools = tools.filter((t) => allowlist.includes(t.name));
              }
            }
          }

          // Prefix tool names; truncate descriptions to cap input-token cost.
          // 200 chars retains full semantic value while trimming marketing copy
          // and verbose enum lists that Claude doesn't need for tool selection.
          return filteredTools.map((tool) => ({
            ...tool,
            name: `${slug}__${tool.name}`,
            description: truncateDescription(`[${vendorConfig.name}] ${tool.description ?? ''}`),
          }));
        }),
      );

      for (const result of vendorResults) {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          results.push(...result.value);
        }
      }

      return results;
    }
  };
}
