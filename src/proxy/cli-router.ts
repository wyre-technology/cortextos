/**
 * CLI endpoint for the MCP Gateway.
 *
 * Provides a thin REST API that accepts plain JSON tool calls
 * instead of MCP JSON-RPC. Reuses the same auth, credential injection,
 * tool allowlist enforcement, and audit logging as the MCP proxy.
 *
 * Uses McpSessionPool to avoid the 3-request MCP handshake per call.
 * Returns timing breakdowns in response headers for latency measurement.
 *
 * Endpoints:
 *   POST /v1/:vendor/cli         — Execute a tool call
 *   GET  /v1/:vendor/cli/schema  — Get CLI-friendly tool definitions
 */

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { injectCredentials, resolveUserId, AuthError } from './credential-injector.js';
import { mcpToolsToCliSchema } from './cli-schema.js';
import { McpSessionPool } from './mcp-session-pool.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { ToolCache } from './tool-cache.js';
import { getVendor } from '../credentials/vendor-config.js';
import { composeToolScope, scopeAllows, filterToolsByScope } from '../org/scope-enforcement.js';
import { ResultCache, VENDOR_TOOL_CONFIG } from './result-cache.js';
import { getSql } from '../db/context.js';

interface CliRouterDeps {
  credentialService: CredentialService;
  orgService: OrgService;
  billingGate: BillingGate;
  toolCache: ToolCache;
}

/**
 * Parse an SSE or JSON response from a vendor MCP server,
 * extracting the JSON-RPC result or error.
 */
async function parseVendorResponse(res: Response): Promise<{ result?: unknown; error?: string }> {
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    const sseText = await res.text();
    for (const line of sseText.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6)) as {
            result?: unknown;
            error?: { code: number; message: string };
          };
          if (event.error) return { error: event.error.message };
          if (event.result !== undefined) return { result: event.result };
        } catch {
          // skip non-JSON lines
        }
      }
    }
    return {};
  }

  const data = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (data.error) return { error: data.error.message };
  return { result: data.result };
}

/**
 * Fastify plugin that registers the CLI REST endpoints.
 */
export function cliRoutes(deps: CliRouterDeps) {
  const { credentialService, orgService, billingGate, toolCache } = deps;
  const sessionPool = new McpSessionPool();
  const resultCache = new ResultCache();

  return async function plugin(app: FastifyInstance): Promise<void> {
    // ---------------------------------------------------------------
    // POST /v1/:vendor/cli — Execute a tool call
    // ---------------------------------------------------------------
    app.post<{
      Params: { vendor: string };
      Body: { tool: string; args?: Record<string, unknown>; context?: string };
    }>(
      '/v1/:vendor/cli',
      {
        config: {
          rateLimit: {
            timeWindow: '1 hour',
            keyGenerator: async (request) => {
              const userId = await resolveUserId(request.headers.authorization);
              const vendor = (request.params as { vendor: string }).vendor;
              return userId ? `${userId}:${vendor}:cli` : `${request.ip}:cli`;
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
        const { vendor: vendorSlug } = request.params;
        const authHeader = request.headers.authorization;
        const t0 = Date.now();

        if (!authHeader) {
          return reply.code(401).send({ error: 'Authentication required' });
        }

        const body = request.body;
        if (!body?.tool || typeof body.tool !== 'string') {
          return reply.code(400).send({ error: 'Missing required field: tool' });
        }

        const toolName = body.tool;

        try {
          // --------------- Auth + credential resolution ---------------
          const injection = await injectCredentials(
            authHeader,
            vendorSlug,
            credentialService,
            orgService,
          );
          const t1 = Date.now(); // after auth

          const vendorConfig = getVendor(vendorSlug)!;

          // --------------- Tool allowlist enforcement ---------------
          // Delegates to composeToolScope (WYREAI-61): centralizes the org+role
          // composition with optional team-scope intersect (flag-gated
          // CONDUIT_TEAM_SCOPING). Flag-off = identical pre-refactor behavior
          // (org+role allowlist, owner-bypass, allowlist null = UNIVERSE).
          const scope = await composeToolScope(orgService, vendorSlug, {
            userId: injection.userId,
            orgId: injection.orgId,
            teamId: injection.teamId,
          });
          if (!scopeAllows(scope, toolName)) {
            return reply.code(403).send({
              error: `Tool "${toolName}" is not permitted for your scope`,
            });
          }

          // --------------- Cache scope (matches MCP routes) ---------------
          const cacheScope = injection.teamId
            ? `team:${injection.teamId}`
            : injection.orgId
              ? `org:${injection.orgId}`
              : `user:${injection.userId}`;

          // --------------- Get or create MCP session ---------------
          const containerUrl = `${vendorConfig.containerUrl}${vendorConfig.mcpPath ?? '/mcp'}`;
          let session = await sessionPool.getSession(
            vendorSlug,
            containerUrl,
            injection.headers,
          );
          const t2 = Date.now(); // after session acquire

          // --------------- Execute tool call (with result cache) ---------------
          const jsonRpcBody = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: body.args ?? {},
            },
          };

          const vendorToolConfig = VENDOR_TOOL_CONFIG[vendorSlug]?.[toolName];

          /**
           * Fetch from vendor, with stale-session retry.
           * Shared by both cached and uncached paths.
           */
          const fetchFromVendor = async (): Promise<{ result?: unknown; error?: string }> => {
            let toolRes = await fetch(containerUrl, {
              method: 'POST',
              headers: session.baseHeaders,
              body: JSON.stringify(jsonRpcBody),
              signal: AbortSignal.timeout(30_000),
            });

            // If the session is stale (server forgot it), retry with a fresh one
            if (!toolRes.ok && (toolRes.status === 400 || toolRes.status === 404)) {
              sessionPool.evict(vendorSlug, injection.headers);
              session = await sessionPool.getSession(
                vendorSlug,
                containerUrl,
                injection.headers,
              );
              toolRes = await fetch(containerUrl, {
                method: 'POST',
                headers: session.baseHeaders,
                body: JSON.stringify(jsonRpcBody),
                signal: AbortSignal.timeout(30_000),
              });
            }

            if (!toolRes.ok) {
              throw new Error(`Vendor MCP server returned ${toolRes.status}`);
            }

            return parseVendorResponse(toolRes);
          };

          let parsed: { result?: unknown; error?: string };

          if (vendorToolConfig && !vendorToolConfig.isWrite && vendorToolConfig.ttlMs > 0) {
            // --- Cacheable read: use ResultCache with in-flight dedup ---
            const { value: cachedOrFetched, fromCache } = await resultCache.getOrFetch(
              cacheScope,
              vendorSlug,
              toolName,
              body.args ?? {},
              fetchFromVendor,
            );
            parsed = cachedOrFetched as { result?: unknown; error?: string };

            if (fromCache) {
              app.log.debug({ vendorSlug, toolName, cacheScope }, 'CLI result cache hit');
            }
          } else {
            // --- Uncacheable or write tool: direct fetch ---
            try {
              parsed = await fetchFromVendor();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('Vendor MCP server returned')) {
                const status = parseInt(msg.split('returned ')[1], 10) || 502;
                return reply.code(502).send({ error: `Vendor MCP server returned ${status}` });
              }
              throw err;
            }

            // Invalidate cache on successful writes (fire-and-forget)
            if (vendorToolConfig?.isWrite) {
              resultCache.invalidate(cacheScope, vendorSlug, toolName).catch((err) => {
                app.log.warn({ err }, 'Failed to invalidate result cache');
              });
            }
          }

          const t3 = Date.now(); // after vendor response (or cache hit)

          if (parsed.error) {
            return reply.code(422).send({ error: parsed.error });
          }

          // --------------- Timing headers ---------------
          reply.header('X-Auth-Ms', String(t1 - t0));
          reply.header('X-Session-Ms', String(t2 - t1));
          reply.header('X-Vendor-Ms', String(t3 - t2));
          reply.header('X-Total-Ms', String(t3 - t0));

          // --------------- Audit log (fire-and-forget) ---------------
          const cliToolArgs = body.args ? JSON.stringify(body.args) : null;
          // Only capture prompt context if the org has it enabled
          let promptCtx: string | null = null;
          if (body.context && injection.orgId) {
            const captureEnabled = await orgService.getPromptCaptureEnabled(injection.orgId);
            if (captureEnabled) {
              promptCtx = body.context;
            }
          }
          getSql()`
            INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, tool_arguments, prompt_context, source)
            VALUES (${nanoid()}, ${injection.userId}, ${injection.orgId ?? null}, ${vendorSlug}, ${toolName}, ${200}, ${t3 - t0}, ${cliToolArgs}, ${promptCtx}, ${'cli'})
          `.catch((err) => {
            app.log.warn({ err }, 'Failed to log CLI request');
          });

          return reply.send({ result: parsed.result });
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.code(err.statusCode).send({ error: err.message });
          }
          request.log.error(err, 'CLI proxy error');
          return reply.code(500).send({ error: 'Internal proxy error' });
        }
      },
    );

    // ---------------------------------------------------------------
    // GET /v1/:vendor/cli/schema — Get CLI-friendly tool definitions
    // ---------------------------------------------------------------
    app.get<{ Params: { vendor: string } }>(
      '/v1/:vendor/cli/schema',
      async (request, reply) => {
        const { vendor: vendorSlug } = request.params;
        const authHeader = request.headers.authorization;

        if (!authHeader) {
          return reply.code(401).send({ error: 'Authentication required' });
        }

        try {
          const injection = await injectCredentials(
            authHeader,
            vendorSlug,
            credentialService,
            orgService,
          );
          const vendorConfig = getVendor(vendorSlug)!;

          // Fetch tools from cache (or vendor container)
          const tools = await toolCache.getTools(
            vendorSlug,
            vendorConfig.containerUrl,
            injection.headers,
          );

          // Apply allowlist filtering via composeToolScope (WYREAI-61).
          // Same helper as the tools/call site above — flag-off keeps the
          // existing org+role filter shape; flag-on adds team-scope intersect.
          const scope = await composeToolScope(orgService, vendorSlug, {
            userId: injection.userId,
            orgId: injection.orgId,
            teamId: injection.teamId,
          });
          const filteredTools = filterToolsByScope(tools, scope);

          // Convert to CLI-friendly schema
          const cliSchema = mcpToolsToCliSchema(filteredTools);

          return reply.send({
            vendor: vendorSlug,
            vendorName: vendorConfig.name,
            commands: cliSchema,
          });
        } catch (err) {
          if (err instanceof AuthError) {
            return reply.code(err.statusCode).send({ error: err.message });
          }
          request.log.error(err, 'CLI schema error');
          return reply.code(500).send({ error: 'Internal error' });
        }
      },
    );
  };
}
