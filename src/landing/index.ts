/**
 * Landing page route plugin
 *
 * Registers GET / (landing page) and GET /login (login chooser).
 * If the user already has an active session, GET / redirects to /dashboard.
 */

import type { FastifyInstance } from 'fastify';
import { renderLandingPage } from './page.js';
import { renderLoginPage } from './login.js';

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
  };
}
