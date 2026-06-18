/**
 * BYOMCP tool-discovery route (WYREAI-189) — thin Fastify glue over
 * ByoToolDiscoveryService.
 *
 *   GET /connect/byo/:id/tools  → { tools: ClassifiedByoTool[] }  (each tool
 *                                  annotated with its read/write/admin tier)
 *
 * Owner-scoped (requireAuth0 + the service loads under the request-path RLS
 * context) and SSRF-guarded inside the service. Takes the shared ToolCache
 * instance so BYO discovery shares the same cache/dedup as catalog discovery
 * (one cache, namespaced keys — see byo-tool-discovery.ts).
 *
 * Not RLS-exempt: the server load is owner-scoped DB work, so it runs under the
 * request context set by requestContextPlugin.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { requireAuth0 } from '../auth/auth0.js';
import type { ToolCache } from '../proxy/tool-cache.js';
import { ByoMcpServerService } from './byo-mcp-service.js';
import { ByoToolDiscoveryService, ByoToolDiscoveryError } from './byo-tool-discovery.js';
import { ByoToolTierOverrideService } from './byo-tool-tier-override-service.js';

export interface ByoToolRoutesDeps {
  toolCache: ToolCache;
}

export const byoToolRoutes = (deps: ByoToolRoutesDeps) =>
  fp(async function plugin(app: FastifyInstance): Promise<void> {
    const discovery = new ByoToolDiscoveryService(new ByoMcpServerService(), deps.toolCache);
    const overrides = new ByoToolTierOverrideService();

    app.get<{ Params: { id: string } }>('/connect/byo/:id/tools', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return reply; // requireAuth0 already issued the login redirect

      try {
        // Each tool is annotated with its EFFECTIVE permission tier: the 190
        // auto-classification, with any owner pin (191) applied on top. Both
        // reads are owner-scoped under the request-path RLS context.
        const pins = await overrides.getOverrides(user.sub, request.params.id);
        const tools = await discovery.discoverClassified(user.sub, request.params.id, pins);
        return reply.send({ tools });
      } catch (err) {
        if (err instanceof ByoToolDiscoveryError) {
          // Not found / not owned — RLS returned no row.
          return reply.code(404).send({ error: 'byo_server_not_found' });
        }
        // SSRF rejection or an upstream handshake failure — surface as a
        // gateway error without leaking the cause to the caller.
        request.log.warn({ err, byoServerId: request.params.id }, 'BYO tool discovery failed');
        return reply.code(502).send({ error: 'byo_discovery_failed' });
      }
    });
  });
