/**
 * Azure AD Admin Consent — Customer onboarding endpoints
 *
 * Provides endpoints for customer tenant onboarding via Azure AD admin consent:
 *
 *   GET  /auth/admin-consent           — Redirect to Azure AD admin consent prompt
 *   GET  /auth/admin-consent/callback  — Handle consent response, store tenant
 *
 * When a customer's Azure AD admin grants consent, their tenant_id is stored
 * in the customer_tenants table, enabling users from that org to sign in.
 */

import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function adminConsentPlugin(sql: postgres.Sql) {
  return fp(async function plugin(app: FastifyInstance): Promise<void> {
    // Skip if Azure AD is not configured
    if (!config.azureClientId) {
      app.log.warn('Azure AD not configured — skipping admin-consent plugin');
      return;
    }

    const callbackUrl = config.azureCallbackUrl
      ? config.azureCallbackUrl.replace('/auth/callback', '/auth/admin-consent/callback')
      : `${config.baseUrl}/auth/admin-consent/callback`;

    // -----------------------------------------------------------------------
    // Table: customer_tenants
    // -----------------------------------------------------------------------

    await sql`
      CREATE TABLE IF NOT EXISTS customer_tenants (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       TEXT UNIQUE NOT NULL,
        customer_name   TEXT NOT NULL,
        onboarded_at    TIMESTAMPTZ DEFAULT NOW(),
        active          BOOLEAN DEFAULT true
      )
    `;

    // -----------------------------------------------------------------------
    // GET /auth/admin-consent
    // -----------------------------------------------------------------------

    app.get<{ Querystring: { customer_name?: string } }>(
      '/auth/admin-consent',
      async (request, reply) => {
        const customerName = request.query.customer_name || 'Unknown';
        const state = `${randomUUID()}:${Buffer.from(customerName).toString('base64')}`;

        const consentUrl = new URL('https://login.microsoftonline.com/common/adminconsent');
        consentUrl.searchParams.set('client_id', config.azureClientId);
        consentUrl.searchParams.set('redirect_uri', callbackUrl);
        consentUrl.searchParams.set('state', state);

        return reply.redirect(consentUrl.href, 302);
      },
    );

    // -----------------------------------------------------------------------
    // GET /auth/admin-consent/callback
    // -----------------------------------------------------------------------

    app.get('/auth/admin-consent/callback', async (request, reply) => {
      const query = request.query as Record<string, string>;
      const tenantId = query.tenant;
      const state = query.state || '';
      const error = query.error;
      const errorDescription = query.error_description || '';

      if (error) {
        app.log.warn({ error, errorDescription }, 'Admin consent denied or failed');
        return reply.code(400).send(
          `Admin consent failed: ${errorDescription || error}. ` +
          'The organization admin must grant consent for this application.',
        );
      }

      if (!tenantId) {
        return reply.code(400).send('Missing tenant ID in admin consent response.');
      }

      // Extract customer name from state
      let customerName = 'Unknown';
      try {
        const parts = state.split(':');
        if (parts.length >= 2) {
          customerName = Buffer.from(parts.slice(1).join(':'), 'base64').toString('utf8');
        }
      } catch {
        // Keep default
      }

      // Upsert the customer tenant
      await sql`
        INSERT INTO customer_tenants (tenant_id, customer_name)
        VALUES (${tenantId}, ${customerName})
        ON CONFLICT (tenant_id) DO UPDATE SET
          customer_name = EXCLUDED.customer_name,
          active        = true,
          onboarded_at  = NOW()
      `;

      app.log.info({ tenantId, customerName }, 'Customer tenant onboarded via admin consent');

      return reply.send({
        status: 'ok',
        message: `Tenant ${tenantId} onboarded successfully.`,
        tenantId,
        customerName,
      });
    });
  });
}
