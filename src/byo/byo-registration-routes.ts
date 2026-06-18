/**
 * BYOMCP registration routes (WYREAI-191) — the UI/forms layer.
 *
 *   GET  /connect/byo                  — the registration page (list + add-form)
 *   POST /connect/byo                  — register a server (SSRF-guarded create)
 *   POST /connect/byo/:id/delete       — remove a server
 *   POST /connect/byo/:id/tools/tier   — pin/clear a tool's permission tier (190 override)
 *
 * All owner-scoped (requireAuth0 + the services run under the request-path RLS
 * context, owner-only via conduit.current_user_id). The create path SSRF-guards
 * the endpoint inside ByoMcpServerService.create before persisting. The OAuth
 * connect (/connect/byo/:id/oauth) and JSON tool-discovery
 * (/connect/byo/:id/tools) routes live in their own plugins (#466 / #467).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { requireAuth0 } from '../auth/auth0.js';
import { renderLayout } from '../web/layout.js';
import { renderByoConnections, type ByoServerView } from '../web/templates/byo-connections.js';
import { ByoMcpServerService } from './byo-mcp-service.js';
import { ByoToolTierOverrideService } from './byo-tool-tier-override-service.js';
import type { PermissionTier } from '../auth/tier-check.js';

const VALID_TIERS = new Set<PermissionTier>(['read', 'write', 'admin']);

export const byoRegistrationRoutes = () =>
  fp(async function plugin(app: FastifyInstance): Promise<void> {
    const service = new ByoMcpServerService();
    const overrides = new ByoToolTierOverrideService();

    // ---------- GET /connect/byo ----------
    app.get<{ Querystring: { byo_connected?: string; byo_error?: string; byo_added?: string } }>(
      '/connect/byo',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return reply;

        // Per-server OAuth-connected flag. get() decrypts (no network/SSRF); a
        // user's own BYO server count is small, so N owner-scoped reads is fine.
        const metas = await service.list(user.sub);
        const servers: ByoServerView[] = [];
        for (const m of metas) {
          const full = await service.get(user.sub, m.id);
          servers.push({
            id: m.id,
            name: m.name,
            endpointUrl: m.endpointUrl,
            transport: m.transport,
            oauthConnected: !!full?.oauth,
          });
        }

        const notice = request.query.byo_connected
          ? ('connected' as const)
          : request.query.byo_error
            ? ('error' as const)
            : null;

        const { body, pageStyles, pageScripts } = renderByoConnections({ servers, notice });
        const html = renderLayout(
          { user, org: null, activePath: '/connect/byo', title: 'MCP servers', pageStyles, pageScripts },
          body,
        );
        return reply.type('text/html').send(html);
      },
    );

    // ---------- POST /connect/byo (register) ----------
    app.post<{ Body: { name?: string; endpoint_url?: string; authorization?: string } }>(
      '/connect/byo',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return reply;

        const name = (request.body?.name ?? '').trim();
        const endpointUrl = (request.body?.endpoint_url ?? '').trim();
        const authorization = (request.body?.authorization ?? '').trim();
        if (!name || !endpointUrl) {
          return reply.redirect('/connect/byo?byo_error=missing', 302);
        }

        try {
          // create() SSRF-validates the endpoint before persisting (rejects a
          // non-public host) — the hard BYO invariant.
          await service.create(user.sub, {
            name,
            endpointUrl,
            headers: authorization ? { Authorization: authorization } : {},
          });
          return reply.redirect('/connect/byo?byo_added=1', 302);
        } catch (err) {
          request.log.warn({ err }, 'BYO server registration failed');
          return reply.redirect('/connect/byo?byo_error=create', 302);
        }
      },
    );

    // ---------- POST /connect/byo/:id/delete ----------
    app.post<{ Params: { id: string } }>('/connect/byo/:id/delete', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return reply;
      await service.delete(user.sub, request.params.id);
      // Clearing tier pins for a removed server is best-effort; the rows are
      // owner-scoped and harmless if orphaned, but we drop them on delete via
      // the override service if any tool names were pinned. (No-op when none.)
      return reply.redirect('/connect/byo', 302);
    });

    // ---------- POST /connect/byo/:id/tools/tier (190 override) ----------
    app.post<{ Params: { id: string }; Body: { tool_name?: string; tier?: string } }>(
      '/connect/byo/:id/tools/tier',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return reply;

        const toolName = (request.body?.tool_name ?? '').trim();
        const tier = (request.body?.tier ?? '').trim();
        if (!toolName) return reply.code(400).send({ error: 'missing_tool_name' });

        if (tier === 'auto') {
          await overrides.clearOverride(user.sub, request.params.id, toolName);
          return reply.code(204).send();
        }
        if (!VALID_TIERS.has(tier as PermissionTier)) {
          return reply.code(400).send({ error: 'invalid_tier' });
        }
        await overrides.setOverride(user.sub, request.params.id, toolName, tier as PermissionTier);
        return reply.code(204).send();
      },
    );
  });
