/**
 * Landing page route plugin
 *
 * Registers GET / (landing page) and GET /login (login chooser).
 * Also registers customer-branded routes at /<customer> and /<customer>/login
 * based on the customerBrands registry.
 *
 * If the user already has an active session, GET / redirects to /settings.
 */

import type { FastifyInstance } from 'fastify';
import { renderLandingPage } from './page.js';
import { renderLoginPage, resolveEnabledProviders } from './login.js';
import { customerBrands } from '../brand/customers.js';

export function landingRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // GET / — public landing page (or redirect to dashboard if logged in)
    app.get('/', async (request, reply) => {
      if (request.auth0User) {
        return reply.redirect('/settings', 302);
      }
      return reply.type('text/html').send(renderLandingPage());
    });

    // GET /login — provider chooser. Short-circuits to the single configured
    // provider's login URL when only one is enabled so the user doesn't see
    // a one-button "chooser." Falls through to the chooser HTML when zero
    // or both providers are enabled (zero = misconfigured deployment; the
    // empty UI is preserved so the operator sees the problem).
    app.get('/login', async (_request, reply) => {
      const { showAuth0, showAzure } = resolveEnabledProviders();
      if (showAuth0 && !showAzure) {
        return reply.redirect('/auth/login', 302);
      }
      if (showAzure && !showAuth0) {
        return reply.redirect('/auth/microsoft/login', 302);
      }
      return reply.type('text/html').send(renderLoginPage());
    });

    // GET /auth/choose — alias the chooser at the upstream-mcp-gateway path
    // so existing bookmarks/links resolve. Forwards any return_to.
    app.get<{ Querystring: { return_to?: string } }>('/auth/choose', async (request, reply) => {
      const ret = request.query.return_to;
      const qs = ret ? `?return_to=${encodeURIComponent(ret)}` : '';
      return reply.redirect(`/login${qs}`, 302);
    });

    // Customer-branded routes
    for (const [slug, brandCfg] of Object.entries(customerBrands)) {
      const prefix = `/${slug}`;

      app.get(prefix, async (_request, reply) => {
        return reply.type('text/html').send(renderLandingPage(brandCfg, prefix));
      });

      app.get(`${prefix}/login`, async (_request, reply) => {
        return reply.type('text/html').send(renderLoginPage(brandCfg, prefix));
      });
    }
  };
}
