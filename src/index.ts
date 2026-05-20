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
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
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
import { VendorOAuthStateStore } from './oauth/vendor-state-store.js';
import { CreditService } from './billing/credit-service.js';
import { runMigrations } from './db/migrate.js';
import { initPools, runAsSystem, systemPool, getSql, closePools } from './db/context.js';
import { requestContextPlugin } from './db/request-context-plugin.js';
import { orgRoutes } from './org/routes.js';
import { domainRoutes } from './org/domain-routes.js';
import { OrgDomainService } from './org/domain-service.js';
import { billingRoutes } from './billing/checkout.js';
import { stripeWebhookRoutes } from './billing/stripe-webhook.js';
import { auditRoutes } from './audit/routes.js';
import { registerAuthPlugin } from './auth/index.js';
import { landingRoutes } from './landing/index.js';
import { adminMetricsRoutes } from './admin/routes.js';
import { adminReportsRoutes } from './admin/reports.js';
import { adminOrgRoutes } from './admin/org-routes.js';
import { legalRoutes } from './web/legal.js';
import { waitlistRoutes } from './waitlist/routes.js';
import { signupRoutes } from './signup/routes.js';
import { ToolCache } from './proxy/tool-cache.js';
import { unifiedProxyRoutes } from './proxy/unified-router.js';
import { getUnifiedProtectedResourceMetadata, getUnifiedAuthMetadata } from './oauth/metadata.js';
import { toolAccessRoutes } from './org/tool-access-routes.js';
import { requireAdmin } from './lib/admin-auth.js';
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
import { ResellerService } from './reseller/reseller-service.js';
import { resellerRoutes } from './reseller/routes.js';
import { ResellerMemberService } from './org/reseller-member-service.js';
import { scimPlugin } from './scim/router.js';

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
// Two connection classes — see src/db/context.ts. The request pool connects
// as a NOBYPASSRLS role so RLS policies enforce on the HTTP request path; the
// system pool connects as BYPASSRLS for boot DDL, migrations, and sweeps.

initPools({
  systemUrl: config.databaseUrl,
  requestUrl: config.databaseUrlRequest,
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
// Service constructors do no DB work — each resolves its connection lazily via
// getSql() at query time. Boot-time DB work (DDL, initTables, migrations,
// sweeps) runs below inside runAsSystem so getSql() resolves to the system
// pool; HTTP requests resolve it to a request-path transaction instead.

const orgService = new OrgService();
const domainService = new OrgDomainService();
const credentialService = new CredentialService();
const tokenStore = new TokenStore();
const billingGate = new DefaultBillingGate(orgService);
const creditService = new CreditService(billingGate);
const vendorOAuthStates = new VendorOAuthStateStore(Buffer.from(config.masterKey, 'hex'));
const auditService = new AuditService();
const adminAuditService = new AdminAuditService();
const toolCache = new ToolCache();
const dashboardService = new DashboardService();

// Reseller (MSP Admin Console) — dark-shipped behind RESELLER_CONSOLE_ENABLED.
// Tables (`reseller_members` et al.) are owned by migrations 002–007; no
// initTables() here.
const resellerService = new ResellerService(orgService);
const resellerMemberService = new ResellerMemberService();

const logShippingService = new LogShippingService();

const logShippingAdapters = new Map<string, import('./log-shipping/adapters/types.js').LogShippingAdapter>([
  ['loki', new LokiAdapter()],
  ['graylog', new GraylogAdapter()],
  ['logscale', new LogScaleAdapter()],
]);
const logShipper = new LogShipper(logShippingService, logShippingAdapters, app.log);
const vendorMonitor = new VendorMonitor(app.log);

// ---------------------------------------------------------------------------
// Boot-time DB initialisation — system-path (BYPASSRLS)
// ---------------------------------------------------------------------------
// DDL, per-service schema init, and the migration runner all connect as the
// BYPASSRLS system role. runAsSystem establishes that context so every
// getSql() below — including those inside the initTables() methods —
// resolves to the system pool. The auth plugin is registered here too: it
// performs CREATE TABLE at registration time.

await runAsSystem(async () => {
  // Core tables — auth plugins depend on `users` / `auth_state` existing.
  await getSql()`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      auth0_sub  TEXT UNIQUE,
      email      TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tenant_id  TEXT
    )
  `;
  await getSql()`
    CREATE TABLE IF NOT EXISTS auth_state (
      state         TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      return_to     TEXT NOT NULL DEFAULT '/',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Auth plugin — registers /auth/* routes + the session onRequest hook, and
  // performs its own CREATE TABLE. Must be registered before the request-
  // context plugin so `request.auth0User` is populated when the request-
  // context onRequest hook reads it.
  await registerAuthPlugin(app);

  // Request-context plugin — opens a request-path RLS transaction per
  // non-exempt HTTP request. Registered immediately after auth so its
  // onRequest hook runs after the auth session hook.
  await app.register(requestContextPlugin());

  // Per-service schema init.
  await orgService.initTables();
  await credentialService.initTables();
  await credentialService.initTeamCredentialTables();
  await credentialService.initServiceClientCredentialTables();
  await tokenStore.initTables();
  await logShippingService.initTables();

  // Migration runner — applies unapplied migrations/*.sql after initTables()
  // has created the base schema. Idempotent. See src/db/migrate.ts.
  await runMigrations(systemPool(), { log: app.log });

  // Background sweeps (fire-and-forget). Initiated inside runAsSystem so the
  // system context propagates into their detached promise chains.
  orgService.cleanupRequestLog(90).then((count) => {
    if (count > 0) app.log.info(`Cleaned up ${count} request_log entries older than 90 days`);
  }).catch((err) => {
    app.log.warn({ err }, 'Failed to cleanup request_log');
  });
  orgService.migrateServerAccessForExistingMembers().then(() => {
    app.log.info('Server access migration complete');
  }).catch((err) => {
    app.log.warn({ err }, 'Failed to migrate server access for existing members');
  });
});

logShipper.start();
vendorMonitor.start();

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// Liveness check — unauthenticated, no rate limit. Carries no vendor or
// tenant data, so it is safe to leave open for uptime monitors.
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Vendor health — admin-gated (ops monitoring only). This was previously
// unauthenticated and global: it exposed every vendor container's `version`
// and `lastError` to any unauthenticated caller, across all tenants — a
// cross-tenant info disclosure. requireAdmin accepts the ADMIN_API_KEY
// bearer token (the ops/monitoring path) or an admin browser session.
app.get('/health/vendors', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return {
    timestamp: new Date().toISOString(),
    vendors: vendorMonitor.getStatus(),
  };
});

// Waitlist (conditionally registered if webhook URL configured)
if (config.features.waitlist) {
  await app.register(waitlistRoutes());
}

// Public reseller signup (Funnel A) — dark by default; gated on SIGNUP_ENABLED.
if (config.features.signup) {
  await app.register(signupRoutes({}));
}

// Auth plugin already registered above (before service init for table ordering)

// Platform admin (WYRE-internal) — gated by ADMIN_API_KEY (script/CI) or by
// a logged-in browser session whose email is in config.adminEmails AND has
// emailVerified=true. See src/lib/admin-auth.ts.
await app.register(adminMetricsRoutes());
await app.register(adminReportsRoutes());
await app.register(adminOrgRoutes({
  orgService,
  billingGate,
  creditService,
  adminAuditService,
}));

// Legal pages (public): /terms, /privacy
await app.register(legalRoutes());

// Landing page (public) — must be after auth plugin so auth0User is available
await app.register(landingRoutes());

// Stripe webhook — conditionally registered if Stripe is configured.
// MUST be registered before @fastify/static because it needs its own
// content type parser for raw body verification.
if (config.features.billing) {
  await app.register(stripeWebhookRoutes(orgService, creditService, systemPool()));
}

// Static files — serves the built docs site from public/ when present.
// Fastify registered routes always take priority over static.
// public/ is a build artifact (gitignored) and is not bundled in every
// image — register @fastify/static only when the directory exists, so a
// docs-less image boots clean instead of warning "root path must exist".
const publicDir = path.join(__dirname, '..', 'public');
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: false,
    decorateReply: false,
  });
} else {
  app.log.info(
    `Static dir ${publicDir} absent — skipping @fastify/static (docs not bundled in this image)`,
  );
}

// OAuth 2.1 endpoints (Claude Desktop/Code ↔ Gateway authentication)
// orgService enables the client_credentials grant for AI agent access
await app.register(oauthRoutes(tokenStore, credentialService, orgService));

// SCIM 2.0 inbound provisioning (tenant + reseller scopes)
await app.register(scimPlugin());

// Unified MCP endpoint well-known metadata (RFC 9728 + RFC 8414)
app.get('/.well-known/oauth-protected-resource/v1/mcp', async (_request, reply) => {
  return reply.type('application/json').send(getUnifiedProtectedResourceMetadata(config.baseUrl));
});
app.get('/.well-known/oauth-authorization-server/v1/mcp', async (_request, reply) => {
  return reply.type('application/json').send(getUnifiedAuthMetadata(config.baseUrl));
});

// Profile API routes
await app.register(profileRoutes());

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
  creditService,
  vendorOAuthStates,
  completeAuth,
  logShippingService,
  vendorMonitor,
}));

// Organization management API + invitation routes
await app.register(orgRoutes({
  orgService,
  credentialService,
  billingGate,
  adminAuditService,
  vendorMonitor,
}));

// Domain claim / verify — org-admin domain management + the current-user
// claim flow (GAP-1 staging-parity port from mcp-gateway).
await app.register(domainRoutes({ orgService, domainService }));

// Tool access API (discover tools, manage allowlists per vendor/role)
await app.register(toolAccessRoutes({ orgService, credentialService, toolCache }));

// Billing routes (checkout + portal) — only if Stripe configured
if (config.features.billing) {
  await app.register(billingRoutes(orgService));
}

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

// MSP Admin Console (`/admin/reseller/*`) — scaffold, dark by default.
// The plugin itself also enforces the RESELLER_CONSOLE_ENABLED flag so the
// surface 404s even if the flag flips at runtime.
await app.register(resellerRoutes({ resellerService, resellerMemberService, orgService, dashboardService, auditService }));

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

  await orgService.updateOrgPlan(orgId, plan as 'free' | 'pro' | 'business');
  return reply.send({ orgId, plan });
});

// CLI REST endpoint (tool calls as plain JSON, not MCP JSON-RPC)
await app.register(cliRoutes({
  credentialService,
  orgService,
  billingGate,
  toolCache,
}));

// Unified MCP endpoint — single URL for all vendors (/v1/mcp)
await app.register(unifiedProxyRoutes({
  credentialService,
  orgService,
  billingGate,
  toolCache,
}));

// Per-vendor MCP reverse proxy (deprecated — catches /v1/:vendor/mcp)
await app.register(proxyRoutes({
  credentialService,
  orgService,
  billingGate,
  creditService,
}));

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async () => {
  app.log.info('Shutting down...');
  logShipper.stop();
  vendorMonitor.stop();
  await app.close();
  await closePools();
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
