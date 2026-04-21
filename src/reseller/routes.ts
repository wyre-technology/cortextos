/**
 * Fastify plugin for the MSP Admin Console (`/admin/reseller/*`).
 *
 * Scaffold only — wires up the feature flag + `requireResellerAccess`
 * middleware and returns a placeholder landing page. Real screens
 * (dashboard, customer list, drill-in, etc.) land in follow-up tasks
 * per `.taskmaster/docs/prd-msp-admin.md`.
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { ResellerService } from './reseller-service.js';
import { makeRequireResellerAccess } from './middleware.js';

export interface ResellerRoutesDeps {
  resellerService: ResellerService;
}

export function resellerRoutes(deps: ResellerRoutesDeps) {
  const { resellerService } = deps;
  const requireResellerAccess = makeRequireResellerAccess(resellerService);

  return async function plugin(app: FastifyInstance): Promise<void> {
    // Global 404 for any /admin/reseller/* path when the feature is off.
    // Individual handlers also check the flag via `requireResellerAccess`,
    // but this hook keeps the surface fully dark (including routes we add
    // later that might forget the middleware).
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/admin/reseller')) return;
      if (!config.features.resellerConsole) {
        reply.code(404).send({ error: 'Not found' });
      }
    });

    // GET /admin/reseller/ — placeholder landing page.
    app.get('/admin/reseller/', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply);
      if (!ctx) return;

      return reply.type('text/html; charset=utf-8').send(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MSP Admin Console</title>
  </head>
  <body>
    <h1>Hello reseller</h1>
    <p>MSP Admin Console scaffold. Signed in as ${escapeForHtml(ctx.user.email)}.</p>
    <p>${ctx.memberships.length} reseller membership(s).</p>
  </body>
</html>`,
      );
    });
  };
}

// Minimal local escaper — we don't import src/web/helpers.ts yet because the
// scaffold deliberately avoids pulling the team-admin layout into the
// reseller surface. When real screens land we'll adopt layout.ts + styles.ts.
function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
