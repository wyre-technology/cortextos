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
import { renderLoginPage } from './login.js';
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

    // GET /login — login chooser page
    app.get('/login', async (_request, reply) => {
      return reply.type('text/html').send(renderLoginPage());
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
