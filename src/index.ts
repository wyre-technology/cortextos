/**
 * MCP Gateway — main entry point
 *
 * Starts a Fastify server that:
 *   - Serves OAuth 2.1 + PKCE endpoints for MCP client authentication (Claude Desktop/Code and any MCP-capable client)
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
import { computeDocsNoindex, buildRobotsTxt, isInternalDocsPath } from './robots.js';
import { LLMS_TXT } from './llms.js';
import path from 'node:path';

import { config } from './config.js';
import { CredentialService } from './credentials/credential-service.js';
import { TokenStore } from './oauth/token-store.js';
import Stripe from 'stripe';
import { OrgService, OrgNotFoundError } from './org/org-service.js';
import { OrgApiKeyService } from './org/org-api-key-service.js';
import { createConduitBillingProvisioner } from './org/org-billing-provisioner.js';
import { Auth0ManagementClient } from './auth/auth0-management.js';
import { createAuth0OrgProvisioner } from './org/org-auth0-provisioner.js';
import { OrgIdpConnectionService } from './org/org-idp-connection-service.js';
import { DefaultBillingGate } from './billing/gate.js';
import { DefaultSeatService } from './billing/seat-service.js';
import { DefaultOrgDiscountService } from './billing/discounts.js';
import { createConduitSeatSyncer } from './billing/seat-syncer.js';
import { AuditService } from './audit/audit-service.js';
import { AdminAuditService } from './audit/admin-audit-service.js';
import { ConsentService } from './consent/consent-service.js';
import { oauthRoutes, completeAuthorization } from './oauth/authorization-server.js';
import { proxyRoutes } from './proxy/router.js';
import { cliRoutes } from './proxy/cli-router.js';
import { webRoutes } from './web/routes.js';
import { VendorOAuthStateStore } from './oauth/vendor-state-store.js';
import { CreditService } from './billing/credit-service.js';
import { runMigrations } from './db/migrate.js';
import { initPools, runAsSystem, systemPool, getSql, closePools } from './db/context.js';
import { hydrateVendorsFromRegistry } from './credentials/vendor-registry.js';
import { requestContextPlugin } from './db/request-context-plugin.js';
import { byoOAuthRoutes } from './byo/byo-oauth-routes.js';
import { byoToolRoutes } from './byo/byo-tool-routes.js';
import { byoRegistrationRoutes } from './byo/byo-registration-routes.js';
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
import {
  RelayControlPlaneClient,
  classifyControlPlaneBoot,
} from './proxy/relay-control-plane-client.js';
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
import { DripScheduler } from './email/drip-scheduler.js';
import { DunningSuspensionScheduler } from './billing/dunning-suspension-scheduler.js';
import { DashboardService } from './dashboard/dashboard-service.js';
import { dashboardRoutes } from './dashboard/routes.js';
import { ResellerService } from './reseller/reseller-service.js';
import { resellerRoutes } from './reseller/routes.js';
import { operatorRoutes } from './reseller/operator-routes.js';
import { ActingAsSessionService } from './reseller/acting-as-session-service.js';
import { actingAsMiddleware } from './reseller/acting-as-middleware.js';
import { verifyResellerActingAuthority } from './reseller/reseller-acting-authority.js';
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
// Robots / crawler policy (docs + all responses)
// ---------------------------------------------------------------------------
// Non-production surfaces (staging, the pre-cutover kinddesert FQDN, local)
// must NOT be indexed by search engines or ingested by AI crawlers — they
// serve pre-launch docs + customer data and are not public-access. The
// production customer-facing docs host (conduit.wyre.ai) MUST be indexable +
// crawlable (the docs are a customer-acquisition surface at launch).
//
// Gate keys on BASE_URL host: index ONLY on `conduit.wyre.ai`; everything else
// noindex. Fail-safe (noindex-unless-explicitly-prod-apex) and ties the
// index-flip to the RECORD-2 cutover automatically — the conduit-prod gateway
// runs the kinddesert FQDN (noindex) until cutover sets BASE_URL to
// conduit.wyre.ai, which flips it indexable. `DOCS_NOINDEX=true|false` is an
// explicit override that wins when set.
//
// NOTE: noindex/robots is crawler+AI-agent POLITENESS, not access-control —
// well-behaved crawlers respect it; malicious scrapers ignore robots.txt. The
// concern here is search-index-pollution + AI-training-ingestion of pre-launch
// product docs, not secret-protection (the docs contain no secrets), so
// politeness-not-authgate is the correct + sufficient tool.
const docsNoindex = computeDocsNoindex(config.baseUrl, process.env.DOCS_NOINDEX);

// Layer 1 — X-Robots-Tag header on every response when noindex. The most
// reliable signal: applies to non-HTML responses too + is honored even if a
// crawler never fetches robots.txt. Absent entirely on the prod apex.
if (docsNoindex) {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return payload;
  });
}

// Belt — path-matched X-Robots-Tag: noindex on /docs/internal/* REGARDLESS of
// env, including the indexed prod apex. The internal/ docs carry full per-agent
// system-prompt contents and must never be indexed; the durable fix is
// build-excluding internal/ from the published site (enforced by the
// /docs/internal/-404 cutover gate in CONDUIT-PROD-DEPLOY.md). This belt is
// defense-in-depth: it covers compliant crawlers in the window before the
// build-exclusion lands AND a regression that re-includes internal/. Registered
// unconditionally — when docsNoindex the Layer-1 hook already covers it; on the
// indexed apex this is the only header protecting internal/. Header-based, NOT a
// robots.txt Disallow (a Disallow on the indexed prod robots.txt advertises the
// path — reconnaissance leak). [Finding A, docs-publish triangle 2026-05-24]
app.addHook('onSend', async (req, reply, payload) => {
  if (isInternalDocsPath(req.url)) {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
  }
  return payload;
});

// Layer 2 — robots.txt. Registered as an explicit route (priority over
// @fastify/static) so its content is env-gated at runtime rather than a static
// build artifact.
const robotsTxt = buildRobotsTxt(docsNoindex, config.baseUrl);
app.get('/robots.txt', async (_req, reply) => {
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  return robotsTxt;
});

// llms.txt — GEO AI-crawler map (llmstxt.org). Env-gated by the SAME
// discriminator as robots: served ONLY on the indexed prod surface. On a
// noindex surface it 404s — advertising an AI-crawler map to pre-launch docs
// contradicts the staging-noindex posture (advertised-resource-must-exist:
// the map only exists where its link targets are live). Body is a placeholder
// pending docs-content curation.
const llmsTxt = LLMS_TXT;
app.get('/llms.txt', async (_req, reply) => {
  if (docsNoindex) {
    reply.code(404).header('Content-Type', 'text/plain; charset=utf-8');
    return 'Not found';
  }
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  return llmsTxt;
});

app.log.info(
  { docsNoindex },
  docsNoindex
    ? 'robots policy: NOINDEX (non-production surface — crawlers + AI agents disallowed)'
    : 'robots policy: INDEXED (production docs host — crawlable)',
);

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
// Per-org discount primitive (mig 054, WYREAI-25). The EAP slice (b) lands
// here so getSeatBilling honors org_discounts rows at every consumer —
// display, Stripe sub-create, invoice preview. DefaultOrgDiscountService
// resolves its connection via getSql() lazily (request-path or system-path
// depending on the caller's context), same pattern as OrgService.
const orgDiscountService = new DefaultOrgDiscountService();
const seatService = new DefaultSeatService(orgService, orgDiscountService);
// WYREAI-172 actingAs-UI-flow foundation (boss msg-1781784272248).
// DB-backed session storage for MSP-as-OPERATOR actingAs state
// (mig 049). Consumed by acting-as-middleware (read every request) +
// operator-routes (mint at /switch, end at /exit).
const actingAsSessionService = new ActingAsSessionService();
// Layer 1: standalone-org creation provisions a Stripe trialing
// subscription via the conduit provisioner.
//
// Two-mode wiring (ruby msg 1779412681446 + boss disposition):
//   - CONDUIT_BILLING_REQUIRED=true (prod): missing price IDs throw at
//     boot via ConduitBillingConfigError. Failing-loud beats silent rot.
//   - default (dev/test/CI): missing price IDs make the provisioner
//     return null at invoke time → createOrg quietly skips the Stripe
//     attach; org row's stripe IDs stay null. Pre-forge-cred environments
//     boot cleanly.
//
// We always call createConduitBillingProvisioner when stripeSecretKey is
// set — that's the seam where required-mode's boot-time throw fires. If
// stripeSecretKey itself is unset (dev w/o Stripe at all), provisioner
// stays undefined and createOrg degrades.
if (config.stripeSecretKey) {
  if (
    !config.conduitBillingRequired &&
    (!config.stripeConduitBasePriceId || !config.stripeConduitSeatPriceId)
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[conduit-billing] STRIPE_CONDUIT_BASE_PRICE_ID / STRIPE_CONDUIT_SEAT_PRICE_ID not set — ' +
        'new orgs will be created WITHOUT a Stripe subscription. Set CONDUIT_BILLING_REQUIRED=true ' +
        'in production to make this a boot failure instead.',
    );
  }
  const stripe = new Stripe(config.stripeSecretKey);
  orgService.setBillingProvisioner(
    createConduitBillingProvisioner({
      stripe,
      seatService,
      basePriceId: config.stripeConduitBasePriceId,
      seatPriceId: config.stripeConduitSeatPriceId,
      required: config.conduitBillingRequired,
    }),
  );
  // Seat-syncer wired alongside the provisioner — same env-gating, same
  // skip-when-IDs-missing-in-dev / throw-when-required disposition. The
  // syncer's seatPriceId requirement subset matches the provisioner's
  // (the syncer only needs seatPriceId because it touches the seat-item,
  // never the base item).
  orgService.setSeatSyncer(
    createConduitSeatSyncer({
      stripe,
      seatService,
      seatPriceId: config.stripeConduitSeatPriceId,
      getSubscriptionId: async (orgId) => {
        const org = await orgService.getOrg(orgId);
        return org?.stripeSubscriptionId ?? null;
      },
      required: config.conduitBillingRequired,
    }),
  );
}

// Multi-IdP foundation slice 3 (June 29 launch directive 2026-06-13): wire
// the Auth0 org-provisioner alongside the billing pair. createIfConfigured
// returns null when AUTH0_M2M_CLIENT_ID/SECRET are unset (dev, test, prod-
// without-creds); createAuth0OrgProvisioner returns null when the client
// is null. Either null path means we never call setAuth0Provisioner and
// every createOrg falls through to the legacy null-auth0OrgId path. When
// both creds + the client are configured, BOTH-OR-NEITHER applies:
// Auth0 create runs BEFORE the DB INSERT, with rollback on post-Auth0 DB
// failure (see src/org/org-auth0-provisioner.ts for the discipline-doc).
const auth0ManagementClient = Auth0ManagementClient.createIfConfigured();
const auth0OrgPair = createAuth0OrgProvisioner(auth0ManagementClient);
if (auth0OrgPair) {
  orgService.setAuth0Provisioner(auth0OrgPair.provisioner, auth0OrgPair.rollback);
  app.log.info('Auth0 Management API client configured — org-create pairs with Auth0 Organization peer.');
} else {
  app.log.info(
    'Auth0 Management API client not configured (AUTH0_M2M_CLIENT_ID/SECRET unset) — org-create uses legacy Universal Login path.',
  );
}

const domainService = new OrgDomainService();
const credentialService = new CredentialService();
const tokenStore = new TokenStore();
const billingGate = new DefaultBillingGate(orgService, seatService);
const creditService = new CreditService();
const vendorOAuthStates = new VendorOAuthStateStore(Buffer.from(config.masterKey, 'hex'));
const auditService = new AuditService();
const adminAuditService = new AdminAuditService();
// WYREAI-113 Funnel A signup completion: ConsentService instantiated with
// adminAuditService injected so org_consent_accepted + user_consent_acknowledged
// events fire on the binding writes per pearl's PR #306 design (audit-trail
// side-effect kept atomic with the row insert at the service layer).
const consentService = new ConsentService({ adminAuditService });
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
const dripScheduler = new DripScheduler(app.log);
const dunningSuspensionScheduler = new DunningSuspensionScheduler(app.log, orgService);

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
  await registerAuthPlugin(app, {
    auth0: { orgService, consentService },
  });

  // Request-context plugin — opens a request-path RLS transaction per
  // non-exempt HTTP request. Registered immediately after auth so its
  // onRequest hook runs after the auth session hook.
  await app.register(requestContextPlugin());

  // WYREAI-172 actingAs-UI-flow foundation (boss msg-1781784272248).
  // The acting-as-middleware decorates request.caller.actingAs on every
  // request by reading the signed `acting_as_session` cookie + running
  // the LIFECYCLE-BIND 3-check revalidation against the session row.
  // Must register AFTER auth (so request.caller.userId is populated)
  // and AFTER requestContextPlugin (so the RLS-aware DB reads run in
  // the right pool).
  //
  // emitAuditEvent: the V4=B transactional security-notice (notify the
  // customer-org owner email at session_started boundary) is a follow-
  // up — see operator-routes deps factory below for the same emit
  // shape's TODO marker. Today the audit row is written to
  // admin_audit_log; the email-fire wraps land in a sibling PR.
  await app.register(
    actingAsMiddleware({
      actingAsSessionService,
      orgService,
      emitAuditEvent: async (event) => {
        // Write the revoke event to admin_audit_log (the route layer's
        // started/ended emits go through operator-routes' deps emit
        // below; this middleware path covers ONLY the 3-check failure
        // revoke). Same event-type vocabulary across both surfaces.
        //
        // Narrow on type — the discriminated union has variant-specific
        // fields (revokedAt/revokeReason live ONLY on the _revoked
        // variant). The middleware only emits _revoked from
        // revalidate()'s failure path, but the deps signature accepts
        // the full union, so we narrow defensively. Non-revoked events
        // bypass this middleware-side emit entirely (started/ended
        // emits go through operator-routes' deps).
        if (event.type !== 'msp_operator_session_revoked') return;
        await adminAuditService.log({
          orgId: event.customerOrgId,
          actorId: event.actorUserId,
          eventType: 'msp_operator_session_revoked',
          metadata: {
            reseller_org_id: event.resellerOrgId,
            session_started_at: event.sessionStartedAt,
            revoked_at: event.revokedAt,
            revoke_reason: event.revokeReason,
            ip: event.ip,
            user_agent: event.userAgent,
          },
        });
      },
    }),
  );

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
// Drip-scheduler (WYREAI-96 boot wire-in, completes E3 axis from WYREAI-76).
// .start() establishes runAsSystem internally (PR #303 in-iteration lift),
// honors DRIP_SCHEDULER_DISABLED kill-switch + DRIP_MAX_PER_TICK rate-cap,
// and is a no-op tick when neither RESEND_API_KEY nor GRAPH_* config is set
// (per-tick transport-configured guard). interval.unref() means it does not
// block process exit. .stop() is called from the shutdown hook below.
dripScheduler.start();
dunningSuspensionScheduler.start();

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
// Multi-IdP foundation slice 6+7 PR-B (June 29 launch directive
// 2026-06-13): wizard substrate for per-org SAML IdP connection
// management. Reuses the auth0ManagementClient singleton from slice 2
// + the singleton OrgIdpConnectionService instance.
// When auth0ManagementClient is null (M2M creds unset), the wizard
// routes render but the POST handler 503-fails-loud (rather than
// silently no-op'ing) — admin sees the disabled-state banner + an
// explicit error explaining why the action didn't fire.
const orgIdpConnectionService = new OrgIdpConnectionService();
await app.register(adminOrgRoutes({
  orgService,
  billingGate,
  creditService,
  adminAuditService,
  orgDiscountService,
  orgIdpConnectionService,
  auth0ManagementClient: auth0ManagementClient ?? undefined,
}));

// Legal pages (public): /terms, /privacy
await app.register(legalRoutes());

// Landing page (public) — must be after auth plugin so auth0User is available
await app.register(landingRoutes());

// Stripe webhook — conditionally registered if Stripe is configured.
// MUST be registered before @fastify/static because it needs its own
// content type parser for raw body verification.
if (config.features.billing) {
  await app.register(stripeWebhookRoutes(orgService, systemPool()));
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
    // wildcard:true — a single `GET /*` catch-all that resolves any file under
    // root at request time. wildcard:false enumerated files at STARTUP and
    // registered a route per file, but in prod that didn't serve the nested
    // `public/docs/**` tree (sitemap-*.xml, /docs/_astro/*, /docs/<subpage>,
    // /docs/index.html) — only the `/docs/` index served, everything else 404'd
    // (WYREAI-107, verified live by wh-infra against a fresh no-cache image).
    // Explicit Fastify routes (the MCP/oauth/scim/landing/etc. paths) still win
    // over `/*` by radix-tree specificity regardless of registration order, and
    // there is no global GET notFoundHandler for the catch-all to shadow.
    wildcard: true,
    decorateReply: false,
    // redirect: a directory requested WITHOUT a trailing slash (e.g. `/docs`,
    // `/docs/getting-started`) 301s to the slashed form that serves the
    // directory index. Without this, @fastify/static 404s the no-slash form
    // (the natural URL a customer types) while `/docs/` serves 200 — the docs
    // site is live but its entry URL appears broken. Only DIRECTORY requests
    // redirect; file requests (`/docs/_astro/*.css`) serve directly, never
    // redirected. redirect:true is unconditionally valid under wildcard:true
    // (the wildcard:false + ignoreTrailingSlash:true prohibition does not apply).
    redirect: true,
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
  adminAuditService,
}));

// BYOMCP OAuth connect routes (WYREAI-187) — start/callback for user-supplied
// MCP servers. Self-contained plugin; registered after webRoutes and after
// requestContextPlugin (line ~388) so its owner-scoped DB work runs under the
// request-path RLS context.
await app.register(byoOAuthRoutes());

// BYOMCP tool-discovery route (WYREAI-189) — GET /connect/byo/:id/tools.
// Reuses the shared ToolCache (owner-namespaced keys); SSRF-guarded + owner-
// scoped inside ByoToolDiscoveryService.
await app.register(byoToolRoutes({ toolCache }));

// BYOMCP registration UI (WYREAI-191) — GET /connect/byo page + POST create/
// delete/tier-override. Owner-scoped; create SSRF-guards the endpoint.
await app.register(byoRegistrationRoutes());

// Organization management API + invitation routes
// Track C reseller-settings sweep-3 substrate (June 29 launch).
// Headless JSON API for org API keys + sign-axis discipline pinned at
// the service layer. PR-B adds the HTML render layer (/org/reseller/api)
// after the Aaron-Figma cycle.
const orgApiKeyService = new OrgApiKeyService();

await app.register(orgRoutes({
  orgService,
  credentialService,
  billingGate,
  adminAuditService,
  vendorMonitor,
  orgApiKeyService,
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
await app.register(resellerRoutes({ resellerService, resellerMemberService, orgService, dashboardService, auditService, adminAuditService }));

// WYREAI-172 actingAs-UI-flow foundation (boss msg-1781784272248).
// MSP-as-OPERATOR routes — GET /api/reseller/me/customers (list),
// POST /:customerOrgId/switch (start session + mint cookie),
// POST /exit (end session + clear cookie). The substrate (#398
// LIFECYCLE-BIND + #441 audit-triplet) is already in main; this PR
// closes the substrate loop by registering the plugin + wiring real
// deps so request.caller.actingAs is populated end-to-end.
await app.register(
  operatorRoutes({
    listOperatableCustomers: async (resellerOrgId) => {
      if (!resellerOrgId) return [];
      const customers = await orgService.getCustomersOfReseller(resellerOrgId);
      return customers.map((org) => ({
        customerOrgId: org.id,
        customerName: org.name,
        customerCreatedAt: org.createdAt,
      }));
    },
    authorizeActAs: async (userId, resellerOrgId, customerOrgId) => {
      if (!userId || !resellerOrgId || !customerOrgId) {
        return { ok: false, reason: 'NOT_RESELLER_OF_CUSTOMER' };
      }
      const result = await verifyResellerActingAuthority(
        orgService,
        userId,
        resellerOrgId,
        customerOrgId,
      );
      if (result.ok) return { ok: true };
      // Map the primitive's deny vocabulary to the OperatorRoutes
      // authz-result vocabulary. Both 'actor_removed_from_reseller'
      // and 'customer_unparented_from_reseller' collapse to
      // NOT_RESELLER_OF_CUSTOMER (the operator simply isn't authorized
      // for THIS customer-org); role demotion maps to INSUFFICIENT_ROLE;
      // suspended/deleted customer maps to CUSTOMER_ARCHIVED (covers
      // both the suspended_at + deleted_at retired-states from mig 012
      // + mig 053, per the warden VERIFY-1 extension).
      switch (result.reason) {
        case 'role_demoted_below_admin':
          return { ok: false, reason: 'INSUFFICIENT_ROLE' };
        case 'customer_archived':
        case 'customer_deleted':
          return { ok: false, reason: 'CUSTOMER_ARCHIVED' };
        default:
          return { ok: false, reason: 'NOT_RESELLER_OF_CUSTOMER' };
      }
    },
    emitActingAsAuditEvent: async (event) => {
      // V4=B transactional security-notice (email customer-org owner
      // at session_started boundary) — TODO follow-up PR. For now we
      // write the admin_audit_log row only; the email-fire wraps land
      // in a sibling PR with the email-template + sender-config
      // sourced from existing src/email/loops.ts machinery. The audit
      // event-type vocabulary is already aligned (msp_operator_session_*).
      const customerOrgId =
        'customerOrgId' in event ? event.customerOrgId : '';
      const eventType =
        event.type === 'msp_operator_session_started'
          ? 'msp_operator_session_started'
          : event.type === 'msp_operator_session_ended'
            ? 'msp_operator_session_ended'
            : 'msp_operator_session_revoked';
      await adminAuditService.log({
        orgId: customerOrgId,
        actorId: event.actorUserId,
        eventType,
        metadata: {
          reseller_org_id:
            'resellerOrgId' in event ? event.resellerOrgId : null,
          session_started_at: event.sessionStartedAt,
          ip: event.ip,
          user_agent: event.userAgent,
          // event-specific fields
          ...(event.type === 'msp_operator_session_started'
            ? { customer_org_owner_email: event.customerOrgOwnerEmail }
            : {}),
          ...(event.type === 'msp_operator_session_ended'
            ? { session_ended_at: event.sessionEndedAt }
            : {}),
        },
      });
    },
    getCustomerOrgOwnerEmail: async (customerOrgId) => {
      // At-fire-time lookup (NOT cached) — the V4=B transactional
      // security-notice MUST reach the CURRENT owner even after
      // ownership transfers. ownerId on the org is the user_id;
      // the email lives on the users table. Fall back to empty
      // string if either lookup fails (the audit-event field is
      // required by the ratified schema but defensive — better to
      // emit an empty-string field than to fail the /switch flow).
      try {
        const org = await orgService.getOrg(customerOrgId);
        if (!org?.ownerId) return '';
        const rows = await systemPool()<{ email: string | null }[]>`
          SELECT email FROM users WHERE id = ${org.ownerId} LIMIT 1
        `;
        return rows[0]?.email ?? '';
      } catch {
        return '';
      }
    },
    actingAsSessionService,
  }),
);

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

  // Flat-pricing: one plan. Any requested value normalizes to 'conduit'
  // (the admin endpoint is retained for parity but there are no tiers to
  // set). The response echoes the canonical plan, not the requested value.
  await orgService.updateOrgPlan(orgId, 'conduit');
  return reply.send({ orgId, plan: 'conduit' });
});

// Admin API: backfill Stripe billing for an org created without it.
// Idempotent — safe to call multiple times; no-ops if Stripe IDs already present.
app.post<{ Params: { orgId: string } }>(
  '/api/admin/orgs/:orgId/backfill-stripe',
  async (request, reply) => {
    const apiKey = request.headers['x-admin-api-key'];
    if (!config.adminApiKey || apiKey !== config.adminApiKey) {
      return reply.code(401).send({ error: 'Invalid admin API key' });
    }
    try {
      const r = await orgService.backfillStripeForOrg(request.params.orgId);
      if (r === null) {
        return reply.send({ orgId: request.params.orgId, skipped: true, reason: 'billing not configured' });
      }
      return reply.send({ orgId: request.params.orgId, ...r });
    } catch (e) {
      if (e instanceof OrgNotFoundError) return reply.code(404).send({ error: 'Organization not found' });
      throw e;
    }
  },
);

// Admin API: promote a standalone org to reseller type.
// Idempotent — safe to call multiple times; returns alreadyReseller:true if already promoted.
app.post<{ Params: { orgId: string } }>(
  '/api/admin/orgs/:orgId/promote-reseller',
  async (request, reply) => {
    const apiKey = request.headers['x-admin-api-key'];
    if (!config.adminApiKey || apiKey !== config.adminApiKey) {
      return reply.code(401).send({ error: 'Invalid admin API key' });
    }
    try {
      const r = await orgService.promoteToReseller(request.params.orgId);
      return reply.send({ orgId: request.params.orgId, ...r });
    } catch (e) {
      if (e instanceof OrgNotFoundError) return reply.code(404).send({ error: 'Organization not found' });
      if (e instanceof Error && e.message.includes('customer org')) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  },
);

// CLI REST endpoint (tool calls as plain JSON, not MCP JSON-RPC)
await app.register(cliRoutes({
  credentialService,
  orgService,
  billingGate,
  toolCache,
}));

// Gateway-side on-prem relay client wiring. Three boot dispositions (see
// `classifyControlPlaneBoot()` in `proxy/relay-control-plane-client.ts`):
//   - wired:        both CONTROL_PLANE_{RELAY_URL,SECRET} set → construct
//                   the client and hand it to the unified-router.
//   - unconfigured: both absent → soft-skip (the gateway runs without the
//                   on-prem path; dev/test friendly + an intentional state
//                   in deployments that do not yet need on-prem routing).
//   - ambiguous:    exactly ONE set → refuse-to-boot LOUD. An asymmetric
//                   misconfig (typo, half-rotation, partial KV provision)
//                   is far more dangerous than either fully-on or fully-off,
//                   because it looks "almost configured" while being
//                   non-functional. The named-actionable-choice in the
//                   thrown error tells the operator exactly which way out.
let relayControlPlane: RelayControlPlaneClient | null = null;
{
  const disposition = classifyControlPlaneBoot();
  if (disposition.kind === 'ambiguous') {
    throw new Error(disposition.reason);
  }
  if (disposition.kind === 'wired') {
    relayControlPlane = new RelayControlPlaneClient({
      relayUrl: disposition.relayUrl,
      secret: disposition.secret,
    });
    app.log.info(
      { relayUrl: disposition.relayUrl },
      'on-prem control-plane client wired',
    );
  } else {
    app.log.info(
      'on-prem control-plane client unconfigured (CONTROL_PLANE_RELAY_URL + ' +
        'CONTROL_PLANE_SECRET both absent); /v1/mcp on-prem-routed vendors ' +
        'will short-circuit to the unknown-vendor arm.',
    );
  }
}

// Unified MCP endpoint — single URL for all vendors (/v1/mcp)
await app.register(unifiedProxyRoutes({
  credentialService,
  orgService,
  billingGate,
  toolCache,
  relayControlPlane,
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
  dripScheduler.stop();
  dunningSuspensionScheduler.stop();
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
  // Vendor-registry Phase 1: hydrate the in-memory VENDORS map from the DB
  // registry BEFORE serving (flag-gated; no-op + today's compiled-map behavior
  // when VENDOR_REGISTRY_ENABLED is off). Must complete pre-listen — there are
  // no top-level VENDORS reads (all are request-time), so a boot-time hydrate
  // cannot race a stale read. initPools already ran above.
  if (config.features.vendorRegistry) {
    const { merged, inserted } = await hydrateVendorsFromRegistry();
    app.log.info({ merged, inserted }, 'vendor registry hydrated (Phase 1)');
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`MCP Gateway listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
