/**
 * Auth provider switcher
 *
 * Resolves which auth plugins to register based on AUTH_PROVIDER env var:
 *   - `auth0`     → Auth0 only (legacy default)
 *   - `azure-ad`  → Microsoft Entra ID only
 *   - `both`      → Both, side-by-side; the chooser at /login picks one
 *   - unset/auto  → enable whichever credential sets are present
 *
 * Auth0 plugin owns:    /auth/login, /auth/callback, /auth/logout
 * Azure AD plugin owns: /auth/microsoft/login, /auth/microsoft/callback,
 *                       /auth/microsoft/logout
 *
 * Both providers write the same gateway_session cookie format, so the
 * request.auth0User decorator + onRequest hook is registered exactly
 * once — by the Auth0 plugin when it's active, or by the fallback
 * below when only Azure is active.
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { auth0Plugin, type Auth0PluginDeps } from './auth0.js';
import { azureAdPlugin } from './azure-ad.js';
import { adminConsentPlugin } from './admin-consent.js';
import { decodeSessionCookie } from '../lib/session-cookie.js';

const SESSION_COOKIE = 'gateway_session';

/**
 * Deps threaded to the Auth0 plugin for WYREAI-113 Funnel A signup-completion.
 * BOTH-OR-NEITHER per the auth0 plugin discipline: when either dep on
 * Auth0PluginDeps is undefined, the callback handler skips the funnel-
 * completion block and falls through to legacy login.
 */
export interface RegisterAuthDeps {
  auth0?: Auth0PluginDeps;
}

export async function registerAuthPlugin(
  app: FastifyInstance,
  deps: RegisterAuthDeps = {},
): Promise<void> {
  const hasAuth0Creds = !!(config.auth0Domain && config.auth0ClientId && config.auth0ClientSecret);
  const hasAzureCreds = !!(config.azureClientId && config.azureClientSecret);

  let enableAuth0 = false;
  let enableAzureAd = false;

  if (config.authProvider === 'both') {
    enableAuth0 = hasAuth0Creds;
    enableAzureAd = hasAzureCreds;
  } else if (config.authProvider === 'auth0') {
    enableAuth0 = hasAuth0Creds;
  } else if (config.authProvider === 'azure-ad') {
    enableAzureAd = hasAzureCreds;
  } else {
    // unset / 'auto' — register whichever credential sets are present
    enableAuth0 = hasAuth0Creds;
    enableAzureAd = hasAzureCreds;
  }

  if (enableAuth0) {
    await app.register(auth0Plugin(deps.auth0 ?? {}));
  } else {
    // Auth0 isn't registered, so the rest of the gateway needs the
    // decorator + hook to read sessions. Mirrors the Auth0 plugin's logic.
    app.decorateRequest('auth0User', null);
    app.addHook('onRequest', async (request, _reply) => {
      const raw = request.unsignCookie(request.cookies[SESSION_COOKIE] ?? '');
      if (!raw.valid || !raw.value) {
        request.auth0User = null;
        return;
      }
      request.auth0User = decodeSessionCookie(raw.value);
    });
  }

  if (enableAzureAd) {
    await app.register(azureAdPlugin());
    await app.register(adminConsentPlugin());
  }

  // If neither provider is configured, leave the decorator default in place
  // so authenticated routes fall through to "not logged in" rather than
  // throwing on the missing decorator. (decorateRequest above only runs on
  // the !enableAuth0 path; cover the no-config case explicitly.)
  if (!enableAuth0 && !enableAzureAd) {
    app.decorateRequest('auth0User', null);
  }
}

// Re-export for direct use
export { auth0Plugin } from './auth0.js';
export { azureAdPlugin } from './azure-ad.js';
export { adminConsentPlugin } from './admin-consent.js';
export { requireAuth0 } from './auth0.js';
