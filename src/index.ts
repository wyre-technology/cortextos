/**
 * MCP Gateway — main entry point
 *
 * Starts a Fastify server that:
 *   - Serves OAuth 2.1 + PKCE endpoints for Claude Desktop/Code authentication
 *   - Provides a credential entry web UI for vendor API keys
 *   - Reverse-proxies MCP requests to vendor containers with injected credentials
 *   - Manages organizations, team memberships, and billing
 */

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { config } from './config.js';
import { CredentialService } from './credentials/credential-service.js';
import { TokenStore } from './oauth/token-store.js';
import { OrgService } from './org/org-service.js';
import { DefaultBillingGate } from './billing/gate.js';
import { AuditService } from './audit/audit-service.js';
import { AdminAuditService } from './audit/admin-audit-service.js';
import { oauthRoutes, completeAuthorization } from './oauth/authorization-server.js';
import { proxyRoutes } from './proxy/router.js';
import { cliRoutes } from './proxy/cli-router.js';
import { webRoutes } from './web/routes.js';
import { orgRoutes } from './org/routes.js';
import { billingRoutes } from './billing/checkout.js';
import { stripeWebhookRoutes } from './billing/stripe-webhook.js';
import { auditRoutes } from './audit/routes.js';
import { auth0Plugin } from './auth/auth0.js';
import { waitlistRoutes } from './waitlist/routes.js';
import { ToolCache } from './proxy/tool-cache.js';
import { unifiedProxyRoutes } from './proxy/unified-router.js';
import { getUnifiedProtectedResourceMetadata, getUnifiedAuthMetadata } from './oauth/metadata.js';
import { toolAccessRoutes } from './org/routes/tool-access.js';
import { LogShippingService } from './log-shipping/log-shipping-service.js';
import { LogShipper } from './log-shipping/shipper.js';
import { LokiAdapter } from './log-shipping/adapters/loki.js';
import { GraylogAdapter } from './log-shipping/adapters/graylog.js';
import { LogScaleAdapter } from './log-shipping/adapters/logscale.js';
import { logShippingRoutes } from './log-shipping/routes.js';
import { profileRoutes } from './profile/routes.js';
import { VendorMonitor } from './monitoring/vendor-monitor.js';
import { DashboardService } from './dashboard/dashboard-service.js';
import { dashboardRoutes } from './dashboard/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      config.logLevel === 'debug'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

await app.register(formbody);
await app.register(cookie, {
  secret: config.jwtSecret, // signs session and auth cookies
});
await app.register(cors, {
  origin: [config.baseUrl, 'http://localhost:8080'],
});
await app.register(rateLimit, {
  global: false, // Per-route opt-in, not global
});

// ---------------------------------------------------------------------------
// Database connection (PostgreSQL via postgres.js)
// ---------------------------------------------------------------------------

const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const credentialService = new CredentialService(sql);
await credentialService.initTables();
await credentialService.initTeamCredentialTables();
await credentialService.initServiceClientCredentialTables();

const tokenStore = new TokenStore(sql);
await tokenStore.initTables();

const orgService = new OrgService(sql);
await orgService.initTables();

const billingGate = new DefaultBillingGate(orgService);
const auditService = new AuditService(sql);
const adminAuditService = new AdminAuditService(sql);
const toolCache = new ToolCache();

const dashboardService = new DashboardService(sql);

const logShippingService = new LogShippingService(sql);
await logShippingService.initTables();

const logShippingAdapters = new Map<string, import('./log-shipping/adapters/types.js').LogShippingAdapter>([
  ['loki', new LokiAdapter()],
  ['graylog', new GraylogAdapter()],
  ['logscale', new LogScaleAdapter()],
]);

const logShipper = new LogShipper(logShippingService, logShippingAdapters, app.log);
logShipper.start();

const vendorMonitor = new VendorMonitor(app.log);
vendorMonitor.start();

// Cleanup old request log entries on startup (fire-and-forget)
orgService.cleanupRequestLog(90).then((count) => {
  if (count > 0) app.log.info(`Cleaned up ${count} request_log entries older than 90 days`);
}).catch((err) => {
  app.log.warn({ err }, 'Failed to cleanup request_log');
});

// Backfill server access grants for existing members (fire-and-forget, idempotent)
orgService.migrateServerAccessForExistingMembers().then(() => {
  app.log.info('Server access migration complete');
}).catch((err) => {
  app.log.warn({ err }, 'Failed to migrate server access for existing members');
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// Health check (unauthenticated, no rate limit)
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Vendor health (unauthenticated, like /health)
app.get('/health/vendors', async () => ({
  timestamp: new Date().toISOString(),
  vendors: vendorMonitor.getStatus(),
}));

// Waitlist (unauthenticated, rate-limited)
await app.register(waitlistRoutes(sql));

// Auth0 OIDC (user authentication) — must be registered before all
// authenticated routes so request.auth0User is available.
await app.register(auth0Plugin(sql));

// Stripe webhook — MUST be registered before @fastify/static because it
// needs its own content type parser for raw body verification.
// Registered as a separate encapsulated plugin so the custom JSON parser
// doesn't leak to other routes.
await app.register(stripeWebhookRoutes(orgService));

// Static files — serves Astro docs site from public/.
// Fastify registered routes always take priority over static.
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  wildcard: false,
  decorateReply: false,
});

// OAuth 2.1 endpoints (Claude Desktop/Code ↔ Gateway authentication)
// orgService enables the client_credentials grant for AI agent access
await app.register(oauthRoutes(tokenStore, credentialService, orgService));

// Unified MCP endpoint well-known metadata (RFC 9728 + RFC 8414)
app.get('/.well-known/oauth-protected-resource/v1/mcp', async (_request, reply) => {
  return reply.type('application/json').send(getUnifiedProtectedResourceMetadata(config.baseUrl));
});
app.get('/.well-known/oauth-authorization-server/v1/mcp', async (_request, reply) => {
  return reply.type('application/json').send(getUnifiedAuthMetadata(config.baseUrl));
});

// Profile API routes
await app.register(profileRoutes({ sql }));

// Credential entry web UI
const completeAuth = async (sessionId: string, userId: string) => {
  const result = await completeAuthorization(tokenStore, sessionId, userId);
  if ('error' in result) return null;
  return result;
};
await app.register(webRoutes({
  credentialService,
  orgService,
  billingGate,
  sql,
  completeAuth,
  logShippingService,
}));

// Organization management API + invitation routes
await app.register(orgRoutes({
  orgService,
  credentialService,
  billingGate,
  adminAuditService,
}));

// Tool access API (discover tools, manage allowlists per vendor/role)
await app.register(toolAccessRoutes({ orgService, credentialService, toolCache }));

// Billing routes (checkout + portal)
await app.register(billingRoutes(orgService));

// Audit log routes
await app.register(auditRoutes({
  auditService,
  adminAuditService,
  orgService,
  billingGate,
}));

// Log shipping API routes
await app.register(logShippingRoutes({
  orgService,
  billingGate,
  adminAuditService,
  logShippingService,
  adapters: logShippingAdapters,
}));

// Dashboard API routes
await app.register(dashboardRoutes({
  dashboardService,
  orgService,
  billingGate,
}));

// Admin API: set org plan directly (for managed services contracts)
app.post<{
  Params: { orgId: string };
  Body: { plan: string };
}>('/api/admin/orgs/:orgId/plan', async (request, reply) => {
  const apiKey = request.headers['x-admin-api-key'];
  if (!config.adminApiKey || apiKey !== config.adminApiKey) {
    return reply.code(401).send({ error: 'Invalid admin API key' });
  }

  const { orgId } = request.params;
  const { plan } = request.body;
  if (!plan || typeof plan !== 'string') {
    return reply.code(400).send({ error: 'plan is required' });
  }

  const org = await orgService.getOrg(orgId);
  if (!org) {
    return reply.code(404).send({ error: 'Organization not found' });
  }

  await orgService.updateOrgPlan(orgId, plan as 'free' | 'pro');
  return reply.send({ orgId, plan });
});

// CLI REST endpoint (tool calls as plain JSON, not MCP JSON-RPC)
await app.register(cliRoutes({
  credentialService,
  orgService,
  billingGate,
  toolCache,
  sql,
}));

// Unified MCP endpoint — single URL for all vendors (/v1/mcp)
await app.register(unifiedProxyRoutes({
  credentialService,
  orgService,
  billingGate,
  toolCache,
  sql,
}));

// Per-vendor MCP reverse proxy (deprecated — catches /v1/:vendor/mcp)
await app.register(proxyRoutes({
  credentialService,
  orgService,
  billingGate,
  sql,
}));

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async () => {
  app.log.info('Shutting down...');
  logShipper.stop();
  vendorMonitor.stop();
  await app.close();
  await sql.end();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`MCP Gateway listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
