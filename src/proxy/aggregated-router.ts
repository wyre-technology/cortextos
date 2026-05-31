import type { FastifyInstance } from 'fastify';
import { resolveUserId, injectCredentials, AuthError } from './credential-injector.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService } from '../org/org-service.js';
import { getVendor } from '../credentials/vendor-config.js';
import { composeToolScope, scopeAllows, filterToolsByScope } from '../org/scope-enforcement.js';
import { AggregatedSessionStore } from './aggregated-session-store.js';
import { config } from '../config.js';

interface AggregatedProxyDeps {
  credentialService: CredentialService;
  orgService: OrgService;
}

/**
 * Fastify plugin that registers the aggregated MCP endpoint.
 *
 * A single `/mcp` route that fans out to all vendor containers the user
 * has credentials for, namespacing tools as `{vendor}__{toolName}`.
 */
export function aggregatedProxyRoutes(deps: AggregatedProxyDeps) {
  const { credentialService, orgService } = deps;
  const sessionStore = new AggregatedSessionStore();

  return async function plugin(app: FastifyInstance): Promise<void> {
    // ─── GET /mcp ── SSE keep-alive stub ───────────────────────────
    app.get('/mcp', async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        return reply
          .code(401)
          .header(
            'WWW-Authenticate',
            `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          )
          .send({ error: 'Authentication required' });
      }

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

    // ─── POST /mcp ── MCP Streamable HTTP ──────────────────────────
    app.post('/mcp', async (request, reply) => {
      const authHeader = request.headers.authorization;

      if (!authHeader) {
        return reply
          .code(401)
          .header(
            'WWW-Authenticate',
            `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          )
          .send({ error: 'Authentication required' });
      }

      const body = request.body as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      } | undefined;

      const mcpMethod = body?.method;
      const sessionId = request.headers['mcp-session-id'] as string | undefined;

      try {
        // ─── initialize ────────────────────────────────────────────
        if (mcpMethod === 'initialize') {
          return await handleInitialize(app, authHeader, body, reply, credentialService, orgService, sessionStore);
        }

        // All other methods require a valid session
        if (!sessionId) {
          return reply.send({
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32600, message: 'Missing Mcp-Session-Id header' },
          });
        }

        const session = sessionStore.get(sessionId);
        if (!session) {
          return reply.code(404).send({
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32600, message: 'Unknown session' },
          });
        }

        // ─── notifications/initialized ─────────────────────────────
        if (mcpMethod === 'notifications/initialized') {
          const forwards = [...session.vendors.values()].map((vs) =>
            fetch(`${vs.containerUrl}${vs.mcpPath}`, {
              method: 'POST',
              headers: {
                'accept': 'application/json, text/event-stream',
                'content-type': 'application/json',
                'mcp-session-id': vs.sessionId,
                ...vs.headers,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10_000),
            }).catch((err) => {
              app.log.warn({ err, vendor: vs.slug }, 'Failed to forward notifications/initialized');
            }),
          );
          await Promise.allSettled(forwards);
          return reply.code(200).send({});
        }

        // ─── tools/list ────────────────────────────────────────────
        if (mcpMethod === 'tools/list') {
          return await handleToolsList(app, session, body, reply, orgService);
        }

        // ─── tools/call ────────────────────────────────────────────
        if (mcpMethod === 'tools/call') {
          return await handleToolsCall(app, session, body, reply, orgService);
        }

        // Unknown method — pass through error
        return reply.send({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          error: { code: -32601, message: `Method not found: ${mcpMethod}` },
        });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        request.log.error(err, 'Aggregated proxy error');
        return reply.code(500).send({ error: 'Internal proxy error' });
      }
    });
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleInitialize(
  app: FastifyInstance,
  authHeader: string,
  body: { id?: unknown; method?: string; params?: Record<string, unknown> } | undefined,
  reply: ReturnType<FastifyInstance['route']> extends void ? never : any,
  credentialService: CredentialService,
  orgService: OrgService,
  sessionStore: AggregatedSessionStore,
) {
  const userId = await resolveUserId(authHeader);
  if (!userId) {
    throw new AuthError(401, 'Invalid or expired token');
  }

  // Discover all vendors the user has credentials for
  const vendorSlugs = await discoverVendors(userId, credentialService, orgService);

  const session = sessionStore.create(userId);

  // Fan out initialize to every vendor container
  const initBody = JSON.stringify(body);

  await Promise.allSettled(
    vendorSlugs.map(async (slug) => {
      try {
        const injection = await injectCredentials(authHeader, slug, credentialService, orgService);
        const vendorConfig = getVendor(slug);
        if (!vendorConfig) return;

        const mcpPath = vendorConfig.mcpPath ?? '/mcp';
        const containerHeaders: Record<string, string> = {
          'accept': 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...injection.headers,
        };

        const res = await fetch(`${vendorConfig.containerUrl}${mcpPath}`, {
          method: 'POST',
          headers: containerHeaders,
          body: initBody,
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          app.log.warn({ slug, status: res.status }, 'Vendor initialize failed');
          return;
        }

        const vendorSessionId = res.headers.get('mcp-session-id');
        if (!vendorSessionId) {
          app.log.warn({ slug }, 'Vendor did not return Mcp-Session-Id');
          return;
        }

        sessionStore.addVendor(session.id, {
          sessionId: vendorSessionId,
          slug,
          containerUrl: vendorConfig.containerUrl,
          mcpPath,
          headers: injection.headers,
          // Capture (orgId, teamId) so the tools/list + tools/call handlers
          // can enforce per-vendor allowlist with the right owner context
          // (WYREAI-61 / closes WYREAI-65 unconditional allowlist gap).
          orgId: injection.orgId,
          teamId: injection.teamId,
        });
      } catch (err) {
        app.log.warn({ err, slug }, 'Vendor initialize error — skipping');
      }
    }),
  );

  return reply
    .header('mcp-session-id', session.id)
    .send({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-gateway-aggregated', version: '1.0.0' },
      },
    });
}

async function handleToolsList(
  app: FastifyInstance,
  session: import('./aggregated-session-store.js').AggregatedSession,
  body: { id?: unknown; method?: string; params?: Record<string, unknown> } | undefined,
  reply: any,
  orgService: OrgService,
) {
  const allTools: { name: string; description?: string; inputSchema?: unknown }[] = [];

  await Promise.allSettled(
    [...session.vendors.values()].map(async (vs) => {
      try {
        const res = await fetch(`${vs.containerUrl}${vs.mcpPath}`, {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-session-id': vs.sessionId,
            ...vs.headers,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          app.log.warn({ slug: vs.slug, status: res.status }, 'tools/list failed for vendor');
          return;
        }

        const data = (await res.json()) as {
          result?: { tools?: { name: string; description?: string; inputSchema?: unknown }[] };
        };

        if (data.result?.tools) {
          // Per-vendor allowlist filter (WYREAI-65 close + WYREAI-61 team-scope).
          // Pre-existing gap: aggregated `/mcp` previously did NO allowlist
          // enforcement (any tool let through). Now: per-vendor scope composed
          // from THIS vendor's cred-owner context (vs.orgId / vs.teamId),
          // sequential queries via the shared helper (matches the
          // reserved-conn discipline; this loop is OUTSIDE the Promise.all
          // since each iteration is its own per-vendor branch — the
          // composeToolScope inside is sequential).
          const scope = await composeToolScope(orgService, vs.slug, {
            userId: session.userId,
            orgId: vs.orgId,
            teamId: vs.teamId,
          });
          const filteredTools = filterToolsByScope(data.result.tools, scope);
          for (const tool of filteredTools) {
            allTools.push({
              ...tool,
              name: `${vs.slug}__${tool.name}`,
            });
          }
        }
      } catch (err) {
        app.log.warn({ err, slug: vs.slug }, 'tools/list error for vendor');
      }
    }),
  );

  return reply.send({
    jsonrpc: '2.0',
    id: body?.id ?? null,
    result: { tools: allTools },
  });
}

async function handleToolsCall(
  _app: FastifyInstance,
  session: import('./aggregated-session-store.js').AggregatedSession,
  body: { id?: unknown; method?: string; params?: Record<string, unknown> } | undefined,
  reply: any,
  orgService: OrgService,
) {
  const rawName = (body?.params?.name as string) ?? '';
  const sepIdx = rawName.indexOf('__');

  if (sepIdx < 0) {
    return reply.send({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: { code: -32601, message: `Invalid tool name (missing vendor prefix): ${rawName}` },
    });
  }

  const slug = rawName.slice(0, sepIdx);
  const realToolName = rawName.slice(sepIdx + 2);

  const vs = session.vendors.get(slug);
  if (!vs) {
    return reply.send({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: { code: -32601, message: `No active session for vendor "${slug}"` },
    });
  }

  // Tool scope enforcement (WYREAI-65 close + WYREAI-61 team-scope).
  // Pre-existing gap: this endpoint previously let ANY tool through. Now:
  // per-vendor scope composed from THIS vendor's stored cred-owner context
  // (vs.orgId / vs.teamId, captured at handleInitialize-time).
  const scope = await composeToolScope(orgService, slug, {
    userId: session.userId,
    orgId: vs.orgId,
    teamId: vs.teamId,
  });
  if (!scopeAllows(scope, realToolName)) {
    return reply.send({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: {
        code: -32601,
        message: `Tool "${realToolName}" is not permitted for your scope`,
      },
    });
  }

  // Rewrite the tool name back to the un-namespaced version for the vendor
  const vendorBody = {
    ...body,
    params: { ...body?.params, name: realToolName },
  };

  const res = await fetch(`${vs.containerUrl}${vs.mcpPath}`, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': vs.sessionId,
      ...vs.headers,
    },
    body: JSON.stringify(vendorBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    return reply.code(res.status).send({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: { code: -32603, message: `Vendor ${slug} returned HTTP ${res.status}` },
    });
  }

  const data = await res.json();
  return reply.send(data);
}

// ─── Vendor discovery ──────────────────────────────────────────────────────────

async function discoverVendors(
  userId: string,
  credentialService: CredentialService,
  orgService: OrgService,
): Promise<string[]> {
  const slugSet = new Set<string>();

  // Personal credentials
  const personalVendors = await credentialService.listVendors(userId);
  for (const slug of personalVendors) {
    slugSet.add(slug);
  }

  // Org/team credentials — same resolution as credential-injector
  const orgs = await orgService.getUserOrgs(userId);
  for (const org of orgs) {
    const orgVendors = await credentialService.listOrgVendors(org.id);
    for (const slug of orgVendors) {
      const hasAccess = await orgService.hasServerAccess(org.id, userId, slug);
      if (hasAccess) slugSet.add(slug);
    }

    // Team-level vendors
    const teams = await orgService.getUserTeams(org.id, userId);
    for (const team of teams) {
      const teamVendors = await credentialService.listTeamVendors(team.id);
      for (const slug of teamVendors) {
        const hasAccess = await orgService.hasServerAccess(org.id, userId, slug);
        if (hasAccess) slugSet.add(slug);
      }
    }
  }

  // Only include vendors that have valid config
  return [...slugSet].filter((slug) => getVendor(slug) !== undefined);
}
