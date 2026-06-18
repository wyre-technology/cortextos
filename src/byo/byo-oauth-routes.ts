/**
 * BYOMCP OAuth routes (WYREAI-187) — the thin Fastify glue over the
 * byo-oauth-connect orchestration.
 *
 *   GET /connect/byo/:id/oauth          — start the flow, 302 to the AS authorize URL
 *   GET /connect/byo/oauth/callback     — finish the flow, persist tokens, 302 back to settings
 *
 * Neither route is RLS-exempt: both do owner-scoped DB work (state store +
 * server load/update), so they run on the request-path connection under
 * `conduit.current_user_id` set by requestContextPlugin from the session.
 *
 * Errors never leak detail to the browser — they are logged and redirected to
 * /settings with a coarse flag, matching the catalog connect flow.
 */
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { requireAuth0 } from '../auth/auth0.js';
import { generateCodeVerifier } from '../oauth/vendor-oauth.js';
import { ByoMcpServerService } from './byo-mcp-service.js';
import { ByoOAuthStateStore } from './byo-oauth-state-store.js';
import {
  startByoOAuthConnect,
  finishByoOAuthConnect,
  type ByoOAuthConnectDeps,
} from './byo-oauth-connect.js';

export const byoOAuthRoutes = () =>
  fp(async function plugin(app: FastifyInstance): Promise<void> {
    const service = new ByoMcpServerService();
    const stateStore = new ByoOAuthStateStore(Buffer.from(config.masterKey, 'hex'));
    const deps: ByoOAuthConnectDeps = {
      service,
      stateStore,
      redirectUri: `${config.baseUrl}/connect/byo/oauth/callback`,
      newStateToken: () => nanoid(),
      newCodeVerifier: () => generateCodeVerifier(),
    };

    // ---------- GET /connect/byo/:id/oauth ----------
    app.get<{ Params: { id: string } }>('/connect/byo/:id/oauth', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return reply; // requireAuth0 already issued the login redirect

      try {
        const authorizeUrl = await startByoOAuthConnect(deps, user.sub, request.params.id);
        return reply.redirect(authorizeUrl, 302);
      } catch (err) {
        request.log.warn({ err, byoServerId: request.params.id }, 'BYO OAuth initiate failed');
        return reply.redirect('/settings?byo_error=initiate', 302);
      }
    });

    // ---------- GET /connect/byo/oauth/callback ----------
    app.get<{
      Querystring: { code?: string; state?: string; error?: string; iss?: string };
    }>('/connect/byo/oauth/callback', async (request, reply) => {
      const { code, state, error: oauthError, iss } = request.query;

      if (oauthError || !code || !state) {
        request.log.warn({ oauthError, hasCode: !!code, hasState: !!state }, 'BYO OAuth callback error or missing params');
        return reply.redirect('/settings?byo_error=callback', 302);
      }

      try {
        await finishByoOAuthConnect(deps, { code, state, iss });
        return reply.redirect('/settings?byo_connected=1', 302);
      } catch (err) {
        request.log.warn({ err }, 'BYO OAuth callback failed');
        return reply.redirect('/settings?byo_error=callback', 302);
      }
    });
  });
