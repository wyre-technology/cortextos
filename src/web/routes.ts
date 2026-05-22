import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService, OrgRole } from '../org/org-service.js';
import type { LogShippingService } from '../log-shipping/log-shipping-service.js';
import { ROLE_LEVEL } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { CreditService } from '../billing/credit-service.js';
import { isPaidPlan } from '../billing/gate.js';
import { getVendor } from '../credentials/vendor-config.js';
import { renderConnectPage } from './templates/connect.js';
import { requireAuth0 } from '../auth/auth0.js';
import { runAsSystem } from '../db/context.js';
import { config } from '../config.js';
import {
  buildAuthorizeUrl,
  generateCodeVerifier,
  exchangeCodeForTokens,
  buildCredentialData,
  fetchXeroTenantId,
  extractTenantIdFromIdToken,
} from '../oauth/vendor-oauth.js';
import { nanoid } from 'nanoid';
import { renderLayout } from './layout.js';
import { renderSuccessPage, escapeHtml } from './helpers.js';
import { renderPersonalConnections } from './templates/personal-connections.js';
import { renderTeamOverview, TEAM_OVERVIEW_STYLES } from './templates/team-overview.js';
import { renderTeamMembers, TEAM_MEMBERS_STYLES } from './templates/team-members.js';
import { renderTeamInvitations, TEAM_INVITATIONS_STYLES } from './templates/team-invitations.js';
import { renderTeamConnections, TEAM_CONNECTIONS_STYLES } from './templates/team-connections.js';
import { renderTeamToolAccess, TEAM_TOOL_ACCESS_STYLES } from './templates/team-tool-access.js';
import { renderTeamServerAccess, TEAM_SERVER_ACCESS_STYLES } from './templates/team-server-access.js';
import { renderTeamServiceClients, TEAM_SERVICE_CLIENTS_STYLES } from './templates/team-service-clients.js';
import { renderTeamScim, TEAM_SCIM_STYLES } from './templates/team-scim.js';
import { renderTeamDomains, TEAM_DOMAINS_STYLES } from './templates/team-domains.js';
import { OrgDomainService } from '../org/domain-service.js';
import { ScimConnectionsService } from '../scim/connections-service.js';
import { renderTeamAudit, TEAM_AUDIT_STYLES } from './templates/team-audit.js';
import { renderTeamTeams, TEAM_TEAMS_STYLES } from './templates/team-teams.js';
import { renderTeamLogShipping, TEAM_LOG_SHIPPING_STYLES } from './templates/team-log-shipping.js';
import { renderTeamTeamConnections, TEAM_TEAM_CONNECTIONS_STYLES } from './templates/team-team-connections.js';
import { renderTeamServiceClientConnections, TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES } from './templates/team-service-client-connections.js';
import { renderProfileSettings, PROFILE_SETTINGS_STYLES } from './templates/profile-settings.js';
import { renderTeamDashboard } from './templates/team-dashboard.js';
import {
  renderResellerCustomers,
  RESELLER_CUSTOMERS_STYLES,
  RESELLER_CUSTOMERS_SCRIPT,
  type ResellerCustomer,
} from './templates/reseller-customers.js';
import {
  renderResellerBranding,
  RESELLER_BRANDING_STYLES,
  type ResellerBranding,
} from './templates/reseller-branding.js';
import {
  renderResellerHierarchy,
  RESELLER_HIERARCHY_STYLES,
  RESELLER_HIERARCHY_SCRIPT,
  type TenantNode,
} from './templates/reseller-hierarchy.js';
import {
  renderOnboardMcp,
  coerceStep,
  RESELLER_ONBOARD_MCP_STYLES,
  WIRING_PATTERN_COPY,
  type OnboardMcpData,
} from './templates/reseller-onboard-mcp.js';
import {
  renderResellerCustomerDetail,
  RESELLER_CUSTOMER_DETAIL_STYLES,
  type CustomerSummary,
} from './templates/reseller-customer-detail.js';
import {
  renderNewCustomer,
  coerceNewCustomerStep,
  NEW_CUSTOMER_STYLES,
  type NewCustomerData,
} from './templates/reseller-new-customer.js';
import {
  renderCustomerTab,
  CUSTOMER_TAB_STYLES,
  type CustomerTabId,
  type CustomerTabData,
} from './templates/reseller-customer-tabs.js';
import { renderTeamBilling, TEAM_BILLING_STYLES, DUNNING_TOAST_SCRIPT, type TeamBillingData } from './templates/team-billing.js';
import { getPlan, getDefaultPlan } from '../billing/plan-catalog.js';
import { deriveDunningView } from '../billing/dunning-view.js';
import { assembleOrgVendorHealth, type VendorMonitor } from '../monitoring/vendor-monitor.js';
import Stripe from 'stripe';
import { legacyOrgRedirectTarget } from './legacy-redirect.js';

// ---------------------------------------------------------------------------
// OAuth flow state — DB-backed, see src/oauth/vendor-state-store.ts.
// Background sweep runs every 5 minutes; expired-on-read is also enforced
// inside `consume()`.
// ---------------------------------------------------------------------------

import { VendorOAuthStateStore } from '../oauth/vendor-state-store.js';

// ---------------------------------------------------------------------------
// Route deps
// ---------------------------------------------------------------------------

interface WebRouteDeps {
  credentialService: CredentialService;
  orgService: OrgService;
  billingGate: BillingGate;
  creditService: CreditService;
  vendorOAuthStates: VendorOAuthStateStore;
  completeAuth: (sessionId: string, userId: string) => Promise<{ redirectUrl: string } | null>;
  logShippingService: LogShippingService;
  vendorMonitor: VendorMonitor;
}

/**
 * Helper: require auth + Pro plan + admin/owner role.
 * Returns { user, org, membership } or sends an error/redirect and returns null.
 */
async function requireTeamAccess(
  request: Parameters<typeof requireAuth0>[0],
  reply: Parameters<typeof requireAuth0>[1],
  orgService: OrgService,
  billingGate: BillingGate,
) {
  const user = requireAuth0(request, reply);
  if (!user) return null;

  const plan = await billingGate.getUserPlan(user.sub);
  if (!isPaidPlan(plan)) {
    reply.redirect('/settings', 302);
    return null;
  }

  const orgs = await orgService.getUserOrgs(user.sub);
  const org = orgs[0];
  if (!org) {
    reply.redirect('/settings', 302);
    return null;
  }

  // Dunning-aware service-active gate (Track A, mig 024). isPaidPlan above
  // is the tier-check; canAccessPaidFeatures composes that with isServiceActive
  // (subscription.status + first_failure_at + grace window). A paid org whose
  // subscription is past-grace returns false here and gets redirected to
  // /settings (where the billing-area dunning UI surfaces).
  if (!(await billingGate.canAccessPaidFeatures(org.id))) {
    reply.redirect('/settings', 302);
    return null;
  }

  const membership = await orgService.getMembership(org.id, user.sub);
  if (!membership || ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin) {
    reply.redirect('/settings', 302);
    return null;
  }

  return { user, org, membership };
}

/**
 * Helper: require team access AND that the caller's org is a reseller.
 * Gate for every reseller-console route (Track C) — the customer list,
 * customer detail, onboarding wizards, hierarchy, and reseller settings.
 *
 * requireTeamAccess alone admits any paid admin of any org; a non-reseller
 * admin could otherwise load the reseller console by URL. For a
 * multi-tenant surface that is the wrong default — and it is the seam the
 * Track A swap-ins would leak through (a real customer-list/ownership
 * query dropped behind a reseller-only gate is contained; behind a
 * paid-admin-of-anything gate it is not). See warden's review of the
 * Track C stack, Finding 1.
 *
 * Returns { user, org, membership } or redirects (to /org) and returns null.
 */
async function requireResellerAccess(
  request: Parameters<typeof requireAuth0>[0],
  reply: Parameters<typeof requireAuth0>[1],
  orgService: OrgService,
  billingGate: BillingGate,
) {
  const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
  if (!ctx) return null;
  if (ctx.org.type !== 'reseller') {
    reply.redirect('/org', 302);
    return null;
  }
  return ctx;
}

/**
 * Track A — the :id-ownership gate (warden Finding 2). For a customer-detail
 * page wired to real data, requireResellerAccess alone is not enough — it
 * proves the caller is *a* reseller, not that the caller's reseller owns
 * customer `:id`. This verifies the customer org's parent IS the caller's
 * reseller, fail-closed (redirect to /org/customers). Returns the customer
 * org so the handler can render real identity without a second fetch.
 *
 * Defense-in-depth: the reseller-scoped data endpoints (src/reseller/routes.ts)
 * independently re-check via requireResellerOrCustomerAccess + RLS.
 */
async function requireCustomerOwnership(
  reply: Parameters<typeof requireAuth0>[1],
  reseller: NonNullable<Awaited<ReturnType<typeof requireResellerAccess>>>,
  customerId: string,
  orgService: OrgService,
): Promise<Awaited<ReturnType<OrgService['getOrg']>>> {
  // Sequential, NOT Promise.all: each call issues a DB query on the
  // request's single reserved-tx connection — a Promise.all of two such
  // method calls stalls it (the #196/#199 hang class). requireCustomerOwnership
  // is the shared gate every Track A tab inherits, so the shape matters.
  const customer = await orgService.getOrg(customerId);
  const parent = await orgService.getResellerOfCustomer(customerId);
  if (!customer || !parent || parent.id !== reseller.org.id) {
    reply.redirect('/org/customers', 302);
    return null;
  }
  return customer;
}

/**
 * Fastify plugin that registers all web-facing routes for the credential
 * connection flow, settings page, and team management pages.
 */
export function webRoutes(deps: WebRouteDeps) {
  const { credentialService, orgService, billingGate, creditService, completeAuth, logShippingService, vendorOAuthStates, vendorMonitor } = deps;

  const sweepInterval = setInterval(() => {
    // The interval tick has NO request context — sweepExpired()'s getSql()
    // would throw "getSql() called with no DB context", so the sweep is
    // wrapped in runAsSystem() (the explicit system-path entry point).
    // getSql()-no-context class — see the sweep in this PR.
    void runAsSystem(() => vendorOAuthStates.sweepExpired()).catch(() => {
      /* sweep errors are non-fatal; expired-on-read still enforced */
    });
  }, 5 * 60 * 1000);
  sweepInterval.unref();

  return async function (app: FastifyInstance): Promise<void> {
    // =====================================================================
    // Legacy URL redirect — single onRequest hook for the prefix-swap class.
    // The pure transform lives in ./legacy-redirect.ts for unit-testability;
    // this hook is the thin Fastify wrapper. See that file's docblock for
    // the design rationale + bounded-applicability note.
    // =====================================================================
    app.addHook('onRequest', async (request, reply) => {
      const target = legacyOrgRedirectTarget(request.url);
      if (target) {
        return reply.redirect(target, 301);
      }
    });

    // =====================================================================
    // Connect / Disconnect / OAuth callback routes (unchanged)
    // =====================================================================

    // ---------- GET /connect/:vendor ----------
    app.get<{
      Params: { vendor: string };
      Querystring: { oauth_session?: string; org_id?: string; team_id?: string };
    }>('/connect/:vendor', async (request, reply) => {
      const { vendor: vendorSlug } = request.params;
      const { oauth_session: oauthSession, org_id: orgId, team_id: teamId } = request.query;

      const vendor = getVendor(vendorSlug);
      if (!vendor) {
        return reply.code(404).send('Unknown vendor');
      }

      const user = requireAuth0(request, reply);
      if (!user) return;

      // org_id / team_id flow: verify the user is an admin of the org
      if (orgId) {
        const membership = await orgService.getMembership(orgId, user.sub);
        if (!membership || ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin) {
          return reply.redirect('/settings', 302);
        }
        // If team_id provided, verify the team belongs to this org
        if (teamId) {
          const team = await orgService.getTeam(teamId);
          if (!team || team.orgId !== orgId) {
            return reply.redirect('/settings', 302);
          }
        }
      }

      if (!orgId) {
        const hasCreds = await credentialService.has(user.sub, vendorSlug);
        if (!hasCreds) {
          const limit = await billingGate.getConnectionLimit(user.sub);
          const current = await credentialService.listVendors(user.sub);
          if (current.length >= limit) {
            return reply.redirect('/settings', 302);
          }
        }
      }

      if (vendor.oauthConfig) {
        const codeVerifier = generateCodeVerifier();
        const stateToken = nanoid();

        await vendorOAuthStates.create({
          stateToken,
          userId: user.sub,
          vendorSlug,
          codeVerifier,
          oauthSession,
          orgId,
          teamId,
        });

        const authorizeUrl = buildAuthorizeUrl(vendor.oauthConfig, stateToken, codeVerifier);
        return reply.redirect(authorizeUrl, 302);
      }

      const hasCreds = orgId
        ? (await credentialService.getOrgCredential(orgId, vendorSlug)) !== null
        : await credentialService.has(user.sub, vendorSlug);
      const html = renderConnectPage(vendor, oauthSession, undefined, hasCreds);
      return reply.type('text/html').send(html);
    });

    // ---------- GET /connect/oauth/callback ----------
    app.get<{
      Querystring: { code?: string; state?: string; error?: string; realmId?: string };
    }>('/connect/oauth/callback', async (request, reply) => {
      const { code, state, error: oauthError, realmId } = request.query;

      if (oauthError || !code || !state) {
        app.log.warn({ oauthError, state }, 'OAuth callback error or missing params');
        return reply.redirect('/settings', 302);
      }

      const pending = await vendorOAuthStates.consume(state);
      if (!pending) {
        app.log.warn({ state }, 'Unknown or expired OAuth state token');
        return reply.redirect('/settings', 302);
      }

      const vendor = getVendor(pending.vendorSlug);
      if (!vendor?.oauthConfig) {
        return reply.code(400).send('Invalid vendor for OAuth callback');
      }

      try {
        const tokens = await exchangeCodeForTokens(
          vendor.oauthConfig,
          code,
          pending.codeVerifier,
        );

        const extras: Record<string, string> = {};

        if (pending.vendorSlug === 'xero') {
          const tenantId = await fetchXeroTenantId(tokens.accessToken);
          if (tenantId) extras.tenantId = tenantId;
        }

        if (pending.vendorSlug === 'qbo' && realmId) {
          extras.realmId = realmId;
        }

        if (pending.vendorSlug === 'm365') {
          const idToken = tokens.raw.id_token as string | undefined;
          if (idToken) {
            const tenantId = extractTenantIdFromIdToken(idToken);
            if (tenantId) extras.tenantId = tenantId;
          }
        }

        const credData = buildCredentialData(tokens, extras);

        if (pending.teamId && pending.orgId) {
          // Sub-team connect flow: store at team level
          await credentialService.storeTeamCredential(pending.teamId, pending.orgId, pending.vendorSlug, credData, pending.userId);
          return reply.redirect(`/org/teams/${pending.teamId}/connections`, 302);
        }

        if (pending.orgId) {
          // Org connect flow: store at org level
          await credentialService.storeOrgCredential(pending.orgId, pending.vendorSlug, credData, pending.userId);
          return reply.redirect('/org/connections', 302);
        }

        await credentialService.store(pending.userId, pending.vendorSlug, credData);

        if (pending.oauthSession) {
          const result = await completeAuth(pending.oauthSession, pending.userId);
          if (result) {
            return reply.redirect(result.redirectUrl);
          }
        }

        return reply.type('text/html').send(renderSuccessPage(vendor));
      } catch (err) {
        app.log.error({ err, vendor: pending.vendorSlug }, 'OAuth token exchange failed');
        return reply.redirect(`/connect/${pending.vendorSlug}`, 302);
      }
    });

    // ---------- POST /connect/:vendor ----------
    app.post<{
      Params: { vendor: string };
      Body: Record<string, string>;
    }>('/connect/:vendor', {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    }, async (request, reply) => {
      const { vendor: vendorSlug } = request.params;
      const vendor = getVendor(vendorSlug);
      if (!vendor) {
        return reply.code(404).send('Unknown vendor');
      }

      const user = requireAuth0(request, reply);
      if (!user) return;
      const userId = user.sub;

      const body = request.body;
      const oauthSession = body.oauth_session;

      const hasCreds = await credentialService.has(userId, vendorSlug);
      if (!hasCreds) {
        const limit = await billingGate.getConnectionLimit(userId);
        const current = await credentialService.listVendors(userId);
        if (current.length >= limit) {
          return reply.redirect('/settings', 302);
        }
      }

      for (const field of vendor.fields) {
        if (field.required && !body[field.key]?.trim()) {
          const html = renderConnectPage(vendor, oauthSession, `${field.label} is required`);
          return reply.type('text/html').send(html);
        }
      }

      const credData: Record<string, string> = {};
      for (const field of vendor.fields) {
        if (body[field.key]) {
          credData[field.key] = body[field.key].trim();
        }
      }

      if (vendor.validate) {
        try {
          const result = await vendor.validate(credData);
          if (!result.valid) {
            const html = renderConnectPage(vendor, oauthSession, result.error || 'Invalid credentials');
            return reply.type('text/html').send(html);
          }
        } catch {
          app.log.warn({ vendor: vendorSlug }, 'Credential validation skipped: vendor API unreachable');
        }
      }

      await credentialService.store(userId, vendorSlug, credData);

      if (oauthSession) {
        const result = await completeAuth(oauthSession, userId);
        if (result) {
          return reply.redirect(result.redirectUrl);
        }
      }

      return reply.type('text/html').send(renderSuccessPage(vendor));
    });

    // ---------- POST /disconnect/:vendor ----------
    app.post<{
      Params: { vendor: string };
    }>('/disconnect/:vendor', {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    }, async (request, reply) => {
      const { vendor: vendorSlug } = request.params;

      const vendor = getVendor(vendorSlug);
      if (!vendor) {
        return reply.code(404).send('Unknown vendor');
      }

      const user = requireAuth0(request, reply);
      if (!user) return;

      await credentialService.delete(user.sub, vendorSlug);

      return reply.redirect('/settings', 302);
    });

    // =====================================================================
    // Settings page — personal connections (sidebar layout)
    // =====================================================================

    app.get<{ Querystring: { upgraded?: string } }>(
      '/settings',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const connectedVendors = await credentialService.listVendors(user.sub);
        const orgs = await orgService.getUserOrgs(user.sub);
        const org = orgs[0] ?? null;

        let orgVendors: string[] = [];
        let memberCount = 0;
        let isOwner = false;
        if (org) {
          orgVendors = await credentialService.listOrgVendors(org.id);
          const members = await orgService.getMembers(org.id);
          memberCount = members.length;
          const membership = await orgService.getMembership(org.id, user.sub);
          isOwner = membership?.role === 'owner' || membership?.role === 'admin';
        }

        const connectionLimit = await billingGate.getConnectionLimit(user.sub);
        const upgraded = request.query.upgraded === 'true';

        const { body: bodyContent, pageStyles: connectionsPageStyles } = renderPersonalConnections({
          connectedVendors,
          org,
          orgVendors,
          memberCount,
          connectionLimit,
          upgraded,
          isOwner,
          stripeEnabled: !!(config.stripeSecretKey && config.stripeProPriceId),
        });

        const html = renderLayout({
          user,
          org,
          activePath: '/settings',
          title: 'Settings',
          pageStyles: connectionsPageStyles,
        }, bodyContent);

        return reply.type('text/html').send(html);
      },
    );

    // =====================================================================
    // Profile settings page (sidebar layout)
    // =====================================================================

    app.get('/settings/profile', async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const orgs = await orgService.getUserOrgs(user.sub);
      const org = orgs[0] ?? null;

      // Fetch profile fields from the database
      let firstName: string | null = null;
      let lastName: string | null = null;
      let displayName: string | null = null;

      const { getSql } = await import('../db/context.js');
      const rows = await getSql()<{ first_name: string | null; last_name: string | null; display_name: string | null }[]>`
        SELECT first_name, last_name, display_name FROM users WHERE id = ${user.sub}
      `;
      if (rows.length > 0) {
        firstName = rows[0].first_name;
        lastName = rows[0].last_name;
        displayName = rows[0].display_name;
      }

      const bodyContent = renderProfileSettings({
        firstName,
        lastName,
        displayName,
        email: user.email,
        name: user.name,
      });

      const html = renderLayout({
        user,
        org,
        activePath: '/settings/profile',
        title: 'Profile',
        pageStyles: PROFILE_SETTINGS_STYLES,
      }, bodyContent);

      return reply.type('text/html').send(html);
    });

    // =====================================================================
    // Billing page — IA shell + dunning (Track B, real-data swap-in)
    // =====================================================================
    //
    // Dunning state is now derived live from
    //   - orgService.getSubscription (Conduit DB: status, first_failure_at,
    //     recovered_at; mig 017 + mig 024)
    //   - Stripe API direct (card brand/last4, attempt_count, next-retry,
    //     amount/currency, current_period_end)
    // per Hank's Track A architecture (derive-on-fly, no dunning_state mirror).
    //
    // The remaining mock fields (next-invoice line, invoice history) stay
    // until the dedicated Stripe-invoice-fetch surface lands. Same template
    // + same insertion points — only the data sources change.

    const stripeClient = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

    app.get('/org/billing', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const plan = getPlan(org.plan) ?? getDefaultPlan();
      const members = await orgService.getMembers(org.id);
      const memberCount = members.length;
      const creditsAllocated = plan.maxMembers === Infinity
        ? plan.creditAllocation * memberCount
        : plan.creditAllocation;

      const dunning = await deriveDunningView(org.id, {
        orgService,
        stripe: stripeClient,
        graceDays: config.dunningGraceDays,
        stripeSubscriptionId: org.stripeSubscriptionId,
      });

      const data: TeamBillingData = {
        org,
        plan,
        memberCount,
        creditsUsed: await creditService.getUsageThisMonth(org.id),
        creditsAllocated,
        // Payment method, upcoming invoice, and invoice history are not
        // rendered on-page — they are shown in the customer's real Stripe
        // billing portal (the "Billing details" block links out to it). An
        // org with no Stripe customer gets the honest managed-directly state.
        // No fabricated billing data reaches this page.
        dunning,
        firstName: (user.name || '').split(/\s+/)[0] || null,
        // Only offer packs that have a configured Stripe price ID — the
        // checkout-credits route 500s on an unconfigured pack, so do not
        // surface it as a button.
        availableCreditPacks: [
          config.stripeCredits1000PriceId ? 1000 : 0,
          config.stripeCredits2500PriceId ? 2500 : 0,
          config.stripeCredits5000PriceId ? 5000 : 0,
        ].filter((n) => n > 0),
      };

      const pageScripts = data.dunning.state === 'recovered' ? DUNNING_TOAST_SCRIPT : undefined;

      const html = renderLayout(
        { user, org, activePath: '/org/billing', title: `${org.name} - Billing`, pageStyles: TEAM_BILLING_STYLES, pageScripts },
        renderTeamBilling(data),
      );

      return reply.type('text/html').send(html);
    });

    // =====================================================================
    // Reseller-console shell — stub routes (Track C)
    // =====================================================================
    //
    // The reseller-channel UX (Track C "Conduit — Subtenant Experience"
    // Figma, 5 surfaces) is built surface-by-surface in follow-up PRs.
    // This PR pours the layout foundation: the reseller-console nav
    // ("Customers") + the reseller-settings nav (General / Branding /
    // Billing & Plans / API & Webhooks / Audit Log).
    //
    // The PR #70 lock-step invariant requires a registered handler for
    // every nav href. These stubs honor it — each renders the layout
    // shell + a "coming soon" body so a sidebar click resolves to a 200,
    // not a 404. Real surfaces replace each stub in its own PR (same
    // play as the /org/billing stub → IA shell progression).

    function resellerStubBody(surface: string): string {
      // `surface` is a literal label today, but escape it anyway — a
      // latent injection point the moment a dynamic value is ever wired
      // through (analyst review of the Track C stack).
      const label = escapeHtml(surface);
      return `
        <section style="max-width:560px;margin:48px auto;padding:24px">
          <h1 style="font-size:22px;font-weight:700;margin-bottom:12px">${label}</h1>
          <p style="color:var(--text-secondary);line-height:1.6">
            This is part of the Conduit reseller console. The ${label}
            surface is in active development and will land in a follow-up
            release.
          </p>
        </section>
      `;
    }

    // ---------- GET /org/customers (Track C Surface 1 — Reseller Dashboard) ----------
    //
    // Customer-organization list for a reseller. Mock-data-first: the
    // customer rows below are placeholders shaped like the Track A
    // customer-list read model. When that endpoint lands, the mock builder
    // is the single swap-in point — the template renders unchanged.
    // SWAP-IN CONTRACT: the real customer-list query MUST be reseller-scoped
    // (only orgs whose parent_org_id === the caller's reseller). A bare
    // SELECT here leaks every org. See warden Track C review, Finding 2.
    app.get('/org/customers', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const now = Date.now();
      const min = 60 * 1000;
      const customers: ResellerCustomer[] = [
        { id: 'cust_mock_1', name: 'AM3 Technology & Cybersecurity', subdomain: 'am3.conduit.wyre.ai',     plan: 'business', userCount: 12, mcpCalls30d: 8247,  lastActivity: new Date(now - 2 * min).toISOString() },
        { id: 'cust_mock_2', name: 'Team DNS Solutions',             subdomain: 'teamdns.conduit.wyre.ai', plan: 'pro',      userCount: 8,  mcpCalls30d: 3182,  lastActivity: new Date(now - 47 * min).toISOString() },
        { id: 'cust_mock_3', name: 'Mountain MSP Group',             subdomain: 'mtnmsp.conduit.wyre.ai',  plan: 'pro',      userCount: 6,  mcpCalls30d: 1094,  lastActivity: new Date(now - 3 * 60 * min).toISOString() },
        { id: 'cust_mock_4', name: 'Coastal IT Partners',            subdomain: 'coastal.conduit.wyre.ai', plan: 'business', userCount: 15, mcpCalls30d: 12403, lastActivity: new Date(now - 24 * 60 * min).toISOString() },
      ];

      const html = renderLayout(
        {
          user,
          org,
          activePath: '/org/customers',
          title: `${org.name} - Customers`,
          pageStyles: RESELLER_CUSTOMERS_STYLES,
          pageScripts: RESELLER_CUSTOMERS_SCRIPT,
        },
        renderResellerCustomers({ org, customers }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/customers/new (Track C Area 2 — sub-customer onboarding) ----------
    //
    // 3-step wizard to provision a new customer org under the reseller.
    // Registered before /org/customers/:id — Fastify resolves the static
    // segment first, so "new" never falls through to the :id handler.
    // Mock-data-first: a fixed example draft; the final "Create customer"
    // CTA is disabled until the Track A provisioning endpoint lands.
    app.get('/org/customers/new', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const step = coerceNewCustomerStep((request.query as { step?: string }).step);
      const data: NewCustomerData = {
        org,
        step,
        planTiers: ['Free', 'Pro', 'Business'],
        draft: {
          name: 'Northwind IT Group',
          subdomain: 'northwind-it-group',
          plan: 'Pro',
          adminEmail: 'admin@northwind.example',
          inheritBranding: true,
          accent: '#00C9DB',
        },
      };

      const { body, pageScripts } = renderNewCustomer(data);
      const html = renderLayout(
        {
          user,
          org,
          activePath: '/org/customers',
          title: `${org.name} - New customer`,
          pageStyles: NEW_CUSTOMER_STYLES,
          pageScripts,
        },
        body,
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/customers/:id (Track C Surface 2 — Customer Detail) ----------
    //
    // A reseller drilled into one customer org. Analytics are wired LIVE:
    // the template renders a shell and fetches the reseller-scoped
    // customer-dashboard endpoints (conduit PR #130/#136) client-side.
    // Customer identity is mock until the Track A customer-detail
    // endpoint lands — same gap Surface 1 carries.
    // SWAP-IN CONTRACT: the real customer-detail fetch MUST verify the
    // :id org's parent_org_id === the caller's reseller before returning
    // it — a reseller iterating :id values must get 403, not another
    // reseller's customer. See warden Track C review, Finding 2.
    app.get('/org/customers/:id', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const customerId = (request.params as { id: string }).id;
      const customer: CustomerSummary = {
        id: customerId,
        name: 'AM3 Technology & Cybersecurity',
        plan: 'BUSINESS',
        userCount: 12,
        mcpCount: 4,
        subdomain: 'am3.conduit.wyre.ai',
      };

      // Sibling customer roster — feeds the Area 3 tenant switcher. Mock,
      // like the Surface 1 customer list, until the Track A customer-list
      // endpoint lands; the current customer is included and marked.
      // SWAP-IN CONTRACT: same as the Surface 1 list — the real roster
      // MUST be reseller-scoped, or the switcher becomes a cross-tenant
      // jump. See warden Track C review, Finding 2.
      const siblings = [
        { id: customerId, name: customer.name },
        { id: 'cust_mock_2', name: 'Team DNS Solutions' },
        { id: 'cust_mock_3', name: 'Mountain MSP Group' },
        { id: 'cust_mock_4', name: 'Coastal IT Partners' },
      ];

      const { body, pageScripts } = renderResellerCustomerDetail({ org, customer });

      const html = renderLayout(
        {
          user,
          org,
          activePath: `/org/customers/${customerId}`,
          title: `${org.name} - ${customer.name}`,
          navMode: 'customer-detail',
          customerContext: { id: customer.id, name: customer.name, siblings },
          pageStyles: RESELLER_CUSTOMER_DETAIL_STYLES,
          pageScripts,
        },
        body,
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/customers/:id/{mcps,users,usage,tools,audit,billing,settings} ----------
    //
    // Track C step 5 — the 7 per-org management tabs (Aaron "ship it all").
    // Usage is live (client-fetch of the reseller-scoped dashboard
    // endpoint, which owns reseller-owns-:id authz); the rest are
    // mock-data-first with documented swap-in contracts. All gated by
    // requireResellerAccess. Registered in a loop — the hrefs are
    // dynamic (:id), so they are not part of the static nav lock-step.
    const CUSTOMER_TAB_IDS: CustomerTabId[] =
      ['mcps', 'users', 'usage', 'tools', 'audit', 'billing', 'settings'];

    function buildCustomerTabData(
      reseller: Awaited<ReturnType<typeof requireResellerAccess>>,
      customerId: string,
      tab: CustomerTabId,
    ): CustomerTabData {
      const org = reseller!.org;
      const customer: CustomerSummary = {
        id: customerId,
        name: 'AM3 Technology & Cybersecurity',
        plan: 'BUSINESS',
        userCount: 12,
        mcpCount: 4,
        subdomain: 'am3.conduit.wyre.ai',
      };
      // Mock builders — shaped like the Track A read models. SWAP-IN
      // CONTRACT: every real query below MUST be reseller-scoped and
      // verify the :id org's parent === the caller's reseller (warden
      // Finding 2). Usage does not appear here — it fetches live.
      return {
        org,
        customer,
        tab,
        mcps: [
          { vendor: 'Autotask',   pattern: 'OEM · BYOC',   seats: '8/12 users',  status: 'healthy' },
          { vendor: 'Datto RMM',  pattern: 'OEM · Shared', seats: '12/12 users', status: 'healthy' },
          { vendor: 'Huntress',   pattern: 'OEM · Shared', seats: '6/12 users',  status: 'degraded' },
          { vendor: 'ITGlue',     pattern: 'Self-hosted',  seats: '12/12 users', status: 'healthy' },
        ],
        members: [
          { name: 'C. Ramirez',  email: 'cramirez@am3-it.com',  role: 'Owner',  department: 'Service Delivery', toolAccess: 'All MCPs',     lastActive: '12m ago' },
          { name: 'J. Martinez', email: 'jmartinez@am3-it.com', role: 'Admin',  department: 'Service Delivery', toolAccess: 'All MCPs',     lastActive: '47m ago' },
          { name: 'K. Williams', email: 'kwilliams@am3-it.com', role: 'Member', department: 'Tier 1 Support',   toolAccess: '3 of 4 MCPs',  lastActive: '2h ago' },
          { name: 'M. Chen',     email: 'mchen@am3-it.com',     role: 'Member', department: 'Tier 1 Support',   toolAccess: '3 of 4 MCPs',  lastActive: '5h ago' },
          { name: 'S. Patel',    email: 'spatel@am3-it.com',    role: 'Member', department: 'Tier 2 Support',   toolAccess: '2 of 4 MCPs',  lastActive: '1d ago' },
        ],
        memberTotal: 12,
        toolDepartment: 'Service Delivery (4 users)',
        toolDepartments: ['Service Delivery', 'Tier 1 Support', 'Tier 2 Support'],
        toolGroups: [
          { name: 'Tickets', tools: [
            { name: 'create_ticket', enabled: true }, { name: 'update_ticket', enabled: true },
            { name: 'search_tickets', enabled: true }, { name: 'delete_ticket', enabled: false },
          ] },
          { name: 'Time Entries', tools: [
            { name: 'create_time_entry', enabled: true }, { name: 'search_time_entries', enabled: true },
          ] },
          { name: 'Contacts & Companies', tools: [
            { name: 'search_contacts', enabled: true }, { name: 'create_contact', enabled: false },
          ] },
        ],
        audit: [
          { when: '12m ago',  actor: 'C. Ramirez',      action: 'mcp.tool.invoke',   target: 'Autotask · search_tickets' },
          { when: '1h ago',   actor: 'J. Martinez',     action: 'member.role.update', target: 'K. Williams → Member' },
          { when: '3h ago',   actor: 'WYRE Technology', action: 'mcp.onboard',       target: 'Huntress' },
          { when: '1d ago',   actor: 'C. Ramirez',      action: 'tool.access.grant', target: 'Tier 1 Support → search_tickets' },
          { when: '2d ago',   actor: 'WYRE Technology', action: 'customer.create',   target: 'AM3 Technology & Cybersecurity' },
        ],
        billingPlan: 'Business',
        billingRate: '$49 / user / month · 12 users',
        invoices: [
          { number: 'INV-2026-0042', date: '2026-05-01', amount: '$588.00', status: 'paid' },
          { number: 'INV-2026-0031', date: '2026-04-01', amount: '$588.00', status: 'paid' },
          { number: 'INV-2026-0020', date: '2026-03-01', amount: '$539.00', status: 'paid' },
        ],
      };
    }

    // Shared render+send for a customer-detail tab page.
    function sendCustomerTab(
      reply: FastifyReply,
      user: NonNullable<Awaited<ReturnType<typeof requireResellerAccess>>>['user'],
      org: NonNullable<Awaited<ReturnType<typeof requireResellerAccess>>>['org'],
      customerId: string,
      data: CustomerTabData,
    ) {
      const siblings = [
        { id: customerId, name: data.customer.name },
        { id: 'cust_mock_2', name: 'Team DNS Solutions' },
        { id: 'cust_mock_3', name: 'Mountain MSP Group' },
        { id: 'cust_mock_4', name: 'Coastal IT Partners' },
      ];
      const { body, pageScripts } = renderCustomerTab(data);
      const html = renderLayout(
        {
          user,
          org,
          activePath: `/org/customers/${customerId}/${data.tab}`,
          title: `${org.name} - ${data.customer.name}`,
          navMode: 'customer-detail',
          customerContext: { id: customerId, name: data.customer.name, siblings },
          pageStyles: CUSTOMER_TAB_STYLES,
          pageScripts,
        },
        body,
      );
      return reply.type('text/html').send(html);
    }

    // The 6 still-mock tabs — one loop, mock data, page-level reseller gate.
    for (const tab of CUSTOMER_TAB_IDS.filter((t) => t !== 'audit')) {
      app.get(`/org/customers/:id/${tab}`, async (request, reply) => {
        const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
        if (!ctx) return;
        const customerId = (request.params as { id: string }).id;
        return sendCustomerTab(reply, ctx.user, ctx.org, customerId,
          buildCustomerTabData(ctx, customerId, tab));
      });
    }

    // ---------- GET /org/customers/:id/audit (Track A — wired to real data) ----------
    //
    // The Audit Log tab serves a real reseller-scoped customer audit feed.
    // Per warden Finding 2 the page swaps the bare requireResellerAccess for
    // the :id-ownership gate (requireCustomerOwnership) BEFORE it renders any
    // real customer identity — a reseller cannot load /audit for a customer
    // it does not own. The feed itself is a live client-fetch of the
    // reseller-scoped /admin/reseller/.../audit endpoint, which independently
    // re-checks ownership + RLS. Gate enforced twice (web shell + endpoint).
    app.get('/org/customers/:id/audit', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const customerId = (request.params as { id: string }).id;
      const customer = await requireCustomerOwnership(reply, ctx, customerId, orgService);
      if (!customer) return;
      const data: CustomerTabData = {
        ...buildCustomerTabData(ctx, customerId, 'audit'),
        // Real customer identity — verified-owned above.
        customer: {
          id: customerId,
          name: customer.name,
          plan: customer.plan.toUpperCase(),
          userCount: 0,
          mcpCount: 0,
          subdomain: '',
        },
        audit: [], // live — the auditScript fetches the feed; endpoint owns authz
      };
      return sendCustomerTab(reply, ctx.user, ctx.org, customerId, data);
    });

    // ---------- GET /org/customers/:id/onboard-mcp (Track C Surface 3 — Onboard wizard) ----------
    //
    // 4-step MCP onboarding wizard. Mock-data-first: a fixed scenario
    // (Autotask · BYOC · AM3 Technology) shaped like the Track A
    // onboarding read model. `?step=1..4` selects the body. Launched
    // from the (stubbed) S2 Customer Detail surface — reachable by URL
    // until S2 lands. The final action is disabled (no persistence).
    app.get('/org/customers/:id/onboard-mcp', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const customerId = (request.params as { id: string }).id;
      const step = coerceStep((request.query as { step?: string }).step);

      const data: OnboardMcpData = {
        org,
        customerId,
        customerName: 'AM3 Technology',
        step,
        vendorName: 'Autotask',
        catalogCategories: ['All', 'PSA', 'RMM', 'Security', 'Microsoft 365', 'DNS', 'Backup'],
        catalog: [
          { id: 'autotask',    name: 'Autotask',     abbr: 'AT', iconColor: '#d93333', vendor: 'Datto',       category: 'PSA',      hosting: 'OEM · BYOC' },
          { id: 'datto-rmm',   name: 'Datto RMM',    abbr: 'DR', iconColor: '#1a66d9', vendor: 'Datto',       category: 'RMM',      hosting: 'OEM · Shared' },
          { id: 'halo',        name: 'Halo PSA',     abbr: 'HA', iconColor: '#f28c1a', vendor: 'HaloITSM',    category: 'PSA',      hosting: 'OEM · BYOC' },
          { id: 'connectwise', name: 'ConnectWise',  abbr: 'CW', iconColor: '#33a673', vendor: 'ConnectWise', category: 'PSA',      hosting: 'OEM · BYOC' },
          { id: 'huntress',    name: 'Huntress',     abbr: 'HU', iconColor: '#7333bf', vendor: 'Huntress',    category: 'Security', hosting: 'OEM · Shared' },
          { id: 'itglue',      name: 'ITGlue',       abbr: 'IG', iconColor: '#6666d9', vendor: 'Kaseya',      category: 'Docs',     hosting: 'Self-hosted' },
          { id: 'cipp',        name: 'M365 (CIPP)',  abbr: 'CI', iconColor: '#1a8c40', vendor: 'CIPP',        category: 'M365',     hosting: 'OEM · Shared' },
          { id: 'rocketcyber', name: 'RocketCyber',  abbr: 'RC', iconColor: '#d95933', vendor: 'Kaseya',      category: 'Security', hosting: 'OEM · Shared' },
          { id: 'checkpoint',  name: 'Check Point',  abbr: 'CP', iconColor: '#8c59d9', vendor: 'Check Point', category: 'Security', hosting: 'OEM · BYOC', isNew: true },
        ],
        // Per-vendor pattern *data* (support + recommendation) only.
        // Copy comes from WIRING_PATTERN_COPY (Surface 3a) — Track A
        // swap-in replaces these three rows with whatever the vendor
        // catalog reports, and the spread keeps copy a single source.
        patterns: [
          { id: 'byoc',        supported: true, recommended: true, ...WIRING_PATTERN_COPY.byoc },
          { id: 'shared',      supported: true,                    ...WIRING_PATTERN_COPY.shared },
          { id: 'self-hosted', supported: true,                    ...WIRING_PATTERN_COPY['self-hosted'] },
        ],
        seats: [
          { name: 'C. Ramirez',  department: 'Service Delivery', role: 'Owner',  selected: true },
          { name: 'J. Martinez', department: 'Service Delivery', role: 'Admin',  selected: true },
          { name: 'K. Williams', department: 'Tier 1 Support',   role: 'Member', selected: true },
          { name: 'M. Chen',     department: 'Tier 1 Support',   role: 'Member', selected: true },
          { name: 'S. Patel',    department: 'Tier 2 Support',   role: 'Member', selected: false },
        ],
        extraSeatCount: 7,
        toolPresets: ['Read Only', 'Service Delivery', 'Full Access', 'Custom'],
        activePreset: 'Service Delivery',
        department: 'Service Delivery (4 users)',
        toolGroups: [
          { name: 'Tickets', tools: [
            { name: 'create_ticket', enabled: true }, { name: 'update_ticket', enabled: true },
            { name: 'search_tickets', enabled: true }, { name: 'delete_ticket', enabled: false },
          ] },
          { name: 'Time Entries', tools: [
            { name: 'create_time_entry', enabled: true }, { name: 'search_time_entries', enabled: true },
          ] },
          { name: 'Contacts & Companies', tools: [
            { name: 'search_contacts', enabled: true }, { name: 'create_contact', enabled: false },
            { name: 'search_companies', enabled: true },
          ] },
          { name: 'Invoicing', tools: [
            { name: 'search_invoices', enabled: false }, { name: 'get_invoice_details', enabled: false },
          ] },
        ],
        summary: [
          { label: 'Vendor', value: 'Autotask (Datto)' },
          { label: 'Wiring pattern', value: 'BYOC — Per User' },
          { label: 'Customer', value: 'AM3 Technology & Cybersecurity' },
          { label: 'Seats provisioned', value: '5 of 12 users' },
          { label: 'Department scoped', value: 'Service Delivery' },
          { label: 'Tools enabled', value: '8 of 13' },
          { label: 'MCP URL', value: 'am3.conduit.wyre.ai/mcp' },
          { label: 'Per-user setup link', value: 'Email + dashboard banner' },
        ],
      };

      const html = renderLayout(
        {
          user,
          org,
          activePath: '/org/customers',
          title: `${org.name} - Onboard MCP`,
          pageStyles: RESELLER_ONBOARD_MCP_STYLES,
        },
        renderOnboardMcp(data),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/hierarchy (Track C Surface 4 — Nested Hierarchy) ----------
    //
    // Tenant tree below a reseller. Mock-data-first: the tree below is
    // shaped like the Track A org-hierarchy read model (reseller →
    // customer → subtenant). When that endpoint lands, the mock builder
    // is the single swap-in point — the template renders unchanged.
    // SWAP-IN CONTRACT: the real tree query MUST be rooted at the caller's
    // reseller (only its descendant orgs), and the builder must cap
    // recursion depth + carry a visited-set against a deep or cyclic
    // org graph. See warden + analyst Track C review, Finding 2.
    app.get('/org/hierarchy', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const root: TenantNode = {
        id: org.id,
        name: org.name,
        kind: 'reseller',
        meta: '4 customers · 8 users · BUSINESS',
        children: [
          {
            id: 'cust_mock_1', name: 'AM3 Technology', kind: 'customer',
            meta: '12 users · BUSINESS',
            children: [
              { id: 'sub_mock_1', name: 'AM3 — Internal IT',     kind: 'subtenant', meta: '5 users', children: [] },
              { id: 'sub_mock_2', name: 'AM3 — Client Services', kind: 'subtenant', meta: '7 users', children: [] },
            ],
          },
          { id: 'cust_mock_2', name: 'Team DNS Solutions', kind: 'customer', meta: '8 users · PRO', children: [] },
          {
            id: 'cust_mock_3', name: 'Mountain MSP Group', kind: 'customer',
            meta: '6 users · PRO',
            children: [
              { id: 'sub_mock_3', name: 'Mountain — Healthcare', kind: 'subtenant', meta: '3 users', children: [] },
              { id: 'sub_mock_4', name: 'Mountain — Legal',      kind: 'subtenant', meta: '2 users', children: [] },
              { id: 'sub_mock_5', name: 'Mountain — SMB Pool',   kind: 'subtenant', meta: '1 user',  children: [] },
            ],
          },
          { id: 'cust_mock_4', name: 'Coastal IT Partners', kind: 'customer', meta: '15 users · BUSINESS', children: [] },
        ],
      };

      const html = renderLayout(
        {
          user,
          org,
          activePath: '/org/hierarchy',
          title: `${org.name} - Hierarchy`,
          pageStyles: RESELLER_HIERARCHY_STYLES,
          pageScripts: RESELLER_HIERARCHY_SCRIPT,
        },
        renderResellerHierarchy({ org, root }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/reseller/* (Track C Surface 5 — stubs) ----------
    //
    // Registered as explicit `app.get('<literal>', …)` calls (not a loop)
    // so the layout.test.ts lock-step source-grep can statically verify
    // each nav href has a handler. The shared `resellerSettingsStub`
    // factory keeps the bodies DRY without hiding the path literal.
    const resellerSettingsStub = (path: string, label: string) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
        if (!ctx) return;
        const { user, org } = ctx;
        const html = renderLayout(
          { user, org, activePath: path, title: `${org.name} - ${label}`, navMode: 'reseller-settings' },
          resellerStubBody(label),
        );
        return reply.type('text/html').send(html);
      };

    app.get('/org/reseller/general',  resellerSettingsStub('/org/reseller/general', 'General'));
    app.get('/org/reseller/billing',  resellerSettingsStub('/org/reseller/billing', 'Billing & Plans'));
    app.get('/org/reseller/api',      resellerSettingsStub('/org/reseller/api', 'API & Webhooks'));
    app.get('/org/reseller/audit',    resellerSettingsStub('/org/reseller/audit', 'Audit Log'));

    // ---------- GET /org/reseller/branding (Track C Surface 5 — White-Label Branding) ----------
    //
    // The reseller-settings "Branding" tab. Mock-data-first: the `branding`
    // record below is shaped like the Track A reseller-settings read model.
    // When that endpoint lands, the mock builder is the single swap-in point
    // — the template renders unchanged. v1 ships the layout with a disabled
    // "Save changes" affordance (no dead persistence route).
    app.get('/org/reseller/branding', async (request, reply) => {
      const ctx = await requireResellerAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const branding: ResellerBranding = {
        defaultUrl: `conduit.wyre.ai/v1/mcp/${slug}/am3-technology`,
        brandAlias: 'mcp.wyretechnology.com',
        aliasVerified: true,
        logoUrl: null,
        colors: { accent: '#D93232', textOnDark: '#F2F2F5', textOnLight: '#212126' },
        emailFromName: org.name,
        emailFromAddress: 'notifications@conduit.wyre.ai',
        emailAuthStatus: 'SPF + DKIM verified · DMARC pending',
        emailAuthVerified: false,
        directBillingEnabled: false,
      };

      const html = renderLayout(
        {
          user,
          org,
          activePath: '/org/reseller/branding',
          title: `${org.name} - Branding`,
          navMode: 'reseller-settings',
          pageStyles: RESELLER_BRANDING_STYLES,
        },
        renderResellerBranding({ org, branding, sampleCustomerName: 'AM3 Technology' }),
      );
      return reply.type('text/html').send(html);
    });

    // =====================================================================
    // Team management pages (sidebar layout, Pro plan + admin/owner)
    // =====================================================================

    // ---------- GET /org ----------
    app.get('/org', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const members = await orgService.getMembers(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org', title: `${org.name} - Overview`, pageStyles: TEAM_OVERVIEW_STYLES },
        renderTeamOverview({ org, memberCount: members.length }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/members ----------
    app.get('/org/members', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org, membership } = ctx;

      const members = await orgService.getMembersWithProfiles(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/members', title: `${org.name} - Members`, pageStyles: TEAM_MEMBERS_STYLES },
        renderTeamMembers({
          orgId: org.id,
          viewerUserId: user.sub,
          viewerRole: membership.role as OrgRole,
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role as OrgRole,
            joinedAt: m.joinedAt,
            email: m.email,
            name: m.name,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/invitations ----------
    app.get('/org/invitations', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const invitations = await orgService.listInvitations(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/invitations', title: `${org.name} - Invitations`, pageStyles: TEAM_INVITATIONS_STYLES },
        renderTeamInvitations({
          orgId: org.id,
          baseUrl: config.baseUrl,
          // Post-015 contract: existing invitations don't carry the plaintext
          // token — only the hash persists. The list UI shows status only;
          // the copyable invite URL is shown exactly once at create time
          // (POST /api/orgs/:orgId/invitations response). Re-issuing requires
          // revoke + create-new.
          invitations: invitations.map((inv) => ({
            id: inv.id,
            expiresAt: inv.expiresAt,
            maxUses: inv.maxUses,
            useCount: inv.useCount,
            createdAt: inv.createdAt,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/connections ----------
    app.get('/org/connections', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const orgVendors = await credentialService.listOrgVendors(org.id);

      // Vendor container health — SSR reads the VendorMonitor cache directly
      // (no self-HTTP-fetch). assembleOrgVendorHealth is the SAME function the
      // GET /api/orgs/:orgId/vendor-health endpoint uses; passing orgVendors
      // (the org's connected slugs) org-scopes it — the global cache is never
      // rendered unfiltered.
      const vendorHealth = new Map(
        assembleOrgVendorHealth(orgVendors, vendorMonitor.getStatus())
          .map((vh) => [vh.vendorSlug, vh] as const),
      );

      const html = renderLayout(
        { user, org, activePath: '/org/connections', title: `${org.name} - Connections`, pageStyles: TEAM_CONNECTIONS_STYLES },
        renderTeamConnections({ orgId: org.id, orgVendors, vendorHealth }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/tool-access ----------
    app.get('/org/tool-access', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/tool-access', title: `${org.name} - Tool Access`, pageStyles: TEAM_TOOL_ACCESS_STYLES },
        renderTeamToolAccess({ orgId: org.id, orgVendors }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/server-access ----------
    app.get('/org/server-access', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org, membership } = ctx;

      const members = await orgService.getMembersWithProfiles(org.id);
      const orgVendors = await credentialService.listOrgVendors(org.id);
      const serverAccessGrants = await orgService.listServerAccess(org.id);
      const teamGrants = await orgService.listEffectiveTeamAccessForOrg(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/server-access', title: `${org.name} - Server Access`, pageStyles: TEAM_SERVER_ACCESS_STYLES },
        renderTeamServerAccess({
          orgId: org.id,
          org,
          viewerRole: membership.role as OrgRole,
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role as OrgRole,
            name: m.name,
            email: m.email,
          })),
          orgVendors,
          serverAccess: serverAccessGrants.map((g) => ({ userId: g.userId, vendorSlug: g.vendorSlug })),
          teamGrants,
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/teams ----------
    app.get('/org/teams', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const teams = await orgService.listTeamsWithDetails(org.id);
      const orgMembers = await orgService.getMembersWithProfiles(org.id);
      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/teams', title: `${org.name} - Teams`, pageStyles: TEAM_TEAMS_STYLES },
        renderTeamTeams({
          orgId: org.id,
          teams,
          orgMembers: orgMembers.map((m) => ({ userId: m.userId, name: m.name, email: m.email })),
          orgVendors,
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/service-clients ----------
    app.get('/org/service-clients', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const serviceClients = await orgService.listServiceClients(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/service-clients', title: `${org.name} - Service Clients`, pageStyles: TEAM_SERVICE_CLIENTS_STYLES },
        renderTeamServiceClients({
          orgId: org.id,
          baseUrl: config.baseUrl,
          serviceClients: serviceClients.map((c) => ({
            id: c.id,
            name: c.name,
            clientId: c.clientId,
            lastUsedAt: c.lastUsedAt,
            expiresAt: c.expiresAt,
            createdAt: c.createdAt,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/scim ----------
    app.get('/org/scim', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const connections = new ScimConnectionsService();
      const rows = await connections.listForOrg(org.id);
      const scope = org.type === 'reseller' ? 'reseller' : 'tenant';

      const html = renderLayout(
        { user, org, activePath: '/org/scim', title: `${org.name} - Provisioning`, pageStyles: TEAM_SCIM_STYLES },
        renderTeamScim({
          orgId: org.id,
          baseUrl: config.baseUrl,
          scope,
          connections: rows.map((c) => ({
            id: c.id,
            idpType: c.idpType,
            defaultRole: c.defaultRole,
            status: c.status,
            lastSyncAt: c.lastSyncAt,
            lastError: c.lastError,
            createdAt: c.createdAt,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/domains ----------
    app.get('/org/domains', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const domainService = new OrgDomainService();
      const domains = await domainService.list(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/domains', title: `${org.name} - Domains`, pageStyles: TEAM_DOMAINS_STYLES },
        renderTeamDomains({
          orgId: org.id,
          domains: domains.map((d) => ({
            id: d.id,
            domain: d.domain,
            verificationToken: d.verificationToken,
            verifiedAt: d.verifiedAt,
            autoJoinRole: d.autoJoinRole,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/teams/:teamId/connections ----------
    app.get<{ Params: { teamId: string } }>(
      '/org/teams/:teamId/connections',
      async (request, reply) => {
        const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
        if (!ctx) return;
        const { user, org } = ctx;

        const { teamId } = request.params;
        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== org.id) {
          return reply.code(404).send('Team not found');
        }

        const teamVendors = await credentialService.listTeamVendors(teamId);

        const html = renderLayout(
          { user, org, activePath: '/org/teams', title: `${team.name} - Connections`, pageStyles: TEAM_TEAM_CONNECTIONS_STYLES },
          renderTeamTeamConnections({ orgId: org.id, teamId, teamName: team.name, teamVendors }),
        );
        return reply.type('text/html').send(html);
      },
    );

    // ---------- GET /org/service-clients/:clientId/connections ----------
    app.get<{ Params: { clientId: string } }>(
      '/org/service-clients/:clientId/connections',
      async (request, reply) => {
        const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
        if (!ctx) return;
        const { user, org } = ctx;

        const { clientId } = request.params;
        const serviceClient = await orgService.getServiceClientByClientId(clientId);
        if (!serviceClient || serviceClient.orgId !== org.id) {
          return reply.code(404).send('Service client not found');
        }

        const clientVendors = await credentialService.listServiceClientVendors(clientId);

        const html = renderLayout(
          { user, org, activePath: '/org/service-clients', title: `${serviceClient.name} - Connections`, pageStyles: TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES },
          renderTeamServiceClientConnections({ orgId: org.id, clientId, clientName: serviceClient.name, clientVendors }),
        );
        return reply.type('text/html').send(html);
      },
    );

    // ---------- GET /org/log-shipping ----------
    app.get('/org/log-shipping', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const destinations = await logShippingService.list(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/log-shipping', title: `${org.name} - Log Shipping`, pageStyles: TEAM_LOG_SHIPPING_STYLES },
        renderTeamLogShipping({
          orgId: org.id,
          destinations: destinations.map((d) => ({
            id: d.id,
            label: d.label,
            platform: d.platform,
            endpointUrl: d.endpointUrl,
            config: d.config,
            enabled: d.enabled,
            createdAt: d.createdAt,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/dashboard ----------
    app.get('/org/dashboard', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const { body, pageStyles, pageScripts } = renderTeamDashboard({ orgId: org.id, orgName: org.name });
      const html = renderLayout(
        { user, org, activePath: '/org/dashboard', title: `${org.name} - Dashboard`, pageStyles, pageScripts },
        body,
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /org/audit ----------
    app.get('/org/audit', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org, membership } = ctx;

      // Capture toggle is gated on plan + owner role. Members see the page
      // and the captured data, but the toggle UI is read-only / hidden.
      // Sequential, NOT Promise.all: each check issues a DB query on the
      // request's single reserved-tx connection — a Promise.all of
      // service-method calls querying that connection stalls it (same class
      // as the tools/call hang). See shouldCapturePrompt for the full note.
      const planAllowsCapture = await billingGate.canUsePromptCapture(org.id);
      const captureEnabled = await orgService.getPromptCaptureEnabled(org.id);

      const html = renderLayout(
        { user, org, activePath: '/org/audit', title: `${org.name} - Audit Log`, pageStyles: TEAM_AUDIT_STYLES },
        renderTeamAudit({
          orgId: org.id,
          captureEnabled,
          planAllowsCapture,
          isOwner: membership.role === 'owner',
        }),
      );
      return reply.type('text/html').send(html);
    });

    // =====================================================================
    // Redirects
    // =====================================================================

    // Legacy team management URL → new sidebar URL
    app.get<{ Params: { orgId: string } }>(
      '/org/:orgId/settings',
      async (_request, reply) => {
        return reply.redirect('/org', 301);
      },
    );
  };
}
