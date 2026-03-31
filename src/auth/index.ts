/**
 * Auth provider switcher
 *
 * Based on the AUTH_PROVIDER env var, registers either the Auth0 or Azure AD
 * OIDC plugin. Defaults to Auth0 for backward compatibility.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { config } from '../config.js';
import { auth0Plugin } from './auth0.js';
import { azureAdPlugin } from './azure-ad.js';
import { adminConsentPlugin } from './admin-consent.js';

export async function registerAuthPlugin(app: FastifyInstance, sql: postgres.Sql): Promise<void> {
  if (config.authProvider === 'azure-ad') {
    await app.register(azureAdPlugin(sql));
    await app.register(adminConsentPlugin(sql));
  } else {
    await app.register(auth0Plugin(sql));
  }
}

// Re-export for direct use
export { auth0Plugin } from './auth0.js';
export { azureAdPlugin } from './azure-ad.js';
export { adminConsentPlugin } from './admin-consent.js';
export { requireAuth0 } from './auth0.js';
