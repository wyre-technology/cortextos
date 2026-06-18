import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { CredentialService } from "../credentials/credential-service.js";
import type { OrgService, OrgRole } from "../org/org-service.js";
import type { LogShippingService } from "../log-shipping/log-shipping-service.js";
import type { AdminAuditService } from "../audit/admin-audit-service.js";
import { ROLE_LEVEL } from "../org/org-service.js";
import type { BillingGate } from "../billing/gate.js";
import type { CreditService } from "../billing/credit-service.js";
import { isPaidPlan } from "../billing/gate.js";
import { getVendor } from "../credentials/vendor-config.js";
import { renderConnectPage } from "./templates/connect.js";
import { requireAuth0 } from "../auth/auth0.js";
import { runAsSystem } from "../db/context.js";
import { config } from "../config.js";
import {
  buildAuthorizeUrl,
  generateCodeVerifier,
  exchangeCodeForTokens,
  buildCredentialData,
  fetchXeroTenantId,
  extractTenantIdFromIdToken,
  validateCallbackIssuer,
} from "../oauth/vendor-oauth.js";
import { nanoid } from "nanoid";
import { renderLayout, actingAsBadgeFromRequest } from "./layout.js";
import { renderSuccessPage, escapeHtml } from "./helpers.js";
import { renderPersonalConnections } from "./templates/personal-connections.js";
import {
  renderTeamOverview,
  TEAM_OVERVIEW_STYLES,
} from "./templates/team-overview.js";
import {
  renderTeamMembers,
  TEAM_MEMBERS_STYLES,
} from "./templates/team-members.js";
import {
  renderTeamInvitations,
  TEAM_INVITATIONS_STYLES,
} from "./templates/team-invitations.js";
import {
  renderTeamConnections,
  TEAM_CONNECTIONS_STYLES,
} from "./templates/team-connections.js";
import {
  renderTeamToolAccess,
  TEAM_TOOL_ACCESS_STYLES,
} from "./templates/team-tool-access.js";
import {
  renderTeamScopeToolAccess,
  TEAM_SCOPE_TOOL_ACCESS_STYLES,
} from "./templates/team-scope-tool-access.js";
import {
  renderTeamServerAccess,
  TEAM_SERVER_ACCESS_STYLES,
} from "./templates/team-server-access.js";
import {
  renderTeamServiceClients,
  TEAM_SERVICE_CLIENTS_STYLES,
} from "./templates/team-service-clients.js";
import { renderTeamScim, TEAM_SCIM_STYLES } from "./templates/team-scim.js";
import {
  renderTeamDomains,
  TEAM_DOMAINS_STYLES,
} from "./templates/team-domains.js";
import { OrgDomainService } from "../org/domain-service.js";
import { ScimConnectionsService } from "../scim/connections-service.js";
import { renderTeamAudit, TEAM_AUDIT_STYLES } from "./templates/team-audit.js";
import { renderTeamTeams, TEAM_TEAMS_STYLES } from "./templates/team-teams.js";
import {
  renderTeamLogShipping,
  TEAM_LOG_SHIPPING_STYLES,
} from "./templates/team-log-shipping.js";
import {
  renderTeamTeamConnections,
  TEAM_TEAM_CONNECTIONS_STYLES,
} from "./templates/team-team-connections.js";
import {
  renderTeamServiceClientConnections,
  TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES,
} from "./templates/team-service-client-connections.js";
import {
  renderProfileSettings,
  PROFILE_SETTINGS_STYLES,
} from "./templates/profile-settings.js";
import { renderTeamDashboard } from "./templates/team-dashboard.js";
import {
  renderResellerCustomers,
  RESELLER_CUSTOMERS_STYLES,
  RESELLER_CUSTOMERS_SCRIPT,
  type ResellerCustomer,
  type CustomerPlan,
} from "./templates/reseller-customers.js";
import {
  renderResellerBranding,
  RESELLER_BRANDING_STYLES,
  type ResellerBranding,
} from "./templates/reseller-branding.js";
import {
  renderResellerGeneral,
  RESELLER_GENERAL_STYLES,
} from "./templates/reseller-general.js";
import {
  renderResellerHierarchy,
  RESELLER_HIERARCHY_STYLES,
  RESELLER_HIERARCHY_SCRIPT,
  buildResellerTree,
  type TenantNode,
} from "./templates/reseller-hierarchy.js";
import {
  renderResellerBilling,
  RESELLER_BILLING_STYLES,
} from "./templates/reseller-billing.js";
import {
  renderResellerAudit,
  RESELLER_AUDIT_STYLES,
} from "./templates/reseller-audit.js";
import {
  renderResellerCustomerDetail,
  RESELLER_CUSTOMER_DETAIL_STYLES,
  type CustomerSummary,
} from "./templates/reseller-customer-detail.js";
import {
  renderNewCustomer,
  coerceNewCustomerStep,
  NEW_CUSTOMER_STYLES,
  type NewCustomerData,
} from "./templates/reseller-new-customer.js";
import {
  renderCustomerTab,
  CUSTOMER_TAB_STYLES,
  type CustomerTabId,
  type CustomerTabData,
} from "./templates/reseller-customer-tabs.js";
import {
  renderTeamBilling,
  TEAM_BILLING_STYLES,
  DUNNING_TOAST_SCRIPT,
  type TeamBillingData,
  type TrialState,
  type DunningView,
} from "./templates/team-billing.js";
import { getPlan, getDefaultPlan } from "../billing/plan-catalog.js";
import { computeSeatBilling } from "../billing/seat-service.js";
import { deriveDunningView } from "../billing/dunning-view.js";
import {
  assembleOrgVendorHealth,
  type VendorMonitor,
} from "../monitoring/vendor-monitor.js";
import Stripe from "stripe";
import { legacyOrgRedirectTarget } from "./legacy-redirect.js";

// ---------------------------------------------------------------------------
// OAuth flow state — DB-backed, see src/oauth/vendor-state-store.ts.
// Background sweep runs every 5 minutes; expired-on-read is also enforced
// inside `consume()`.
// ---------------------------------------------------------------------------

import { VendorOAuthStateStore } from "../oauth/vendor-state-store.js";

// ---------------------------------------------------------------------------
// Route deps
// ---------------------------------------------------------------------------

interface WebRouteDeps {
  credentialService: CredentialService;
  orgService: OrgService;
  billingGate: BillingGate;
  creditService: CreditService;
  vendorOAuthStates: VendorOAuthStateStore;
  completeAuth: (
    sessionId: string,
    userId: string,
  ) => Promise<{ redirectUrl: string } | null>;
  logShippingService: LogShippingService;
  vendorMonitor: VendorMonitor;
  /**
   * Required for the OAuth-callback paths that write org/team credentials
   * (ruby VC1 SOC2 audit-trail gap closure 2026-06-05). The credentialService
   * writes are the secret-material movement; without firing the audit event
   * at the callback path, the OAuth-flow store goes unaudited even though
   * the equivalent direct-POST path is audited at src/org/routes.ts.
   */
  adminAuditService: AdminAuditService;
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
    reply.redirect("/settings", 302);
    return null;
  }

  const orgs = await orgService.getUserOrgs(user.sub);
  const org = orgs[0];
  if (!org) {
    reply.redirect("/settings", 302);
    return null;
  }

  // Dunning-aware service-active gate (Track A, mig 024). isPaidPlan above
  // is the tier-check; canAccessPaidFeatures composes that with isServiceActive
  // (subscription.status + first_failure_at + grace window). A paid org whose
  // subscription is past-grace returns false here and gets redirected to
  // /settings (where the billing-area dunning UI surfaces).
  if (!(await billingGate.canAccessPaidFeatures(org.id))) {
    reply.redirect("/settings", 302);
    return null;
  }

  const membership = await orgService.getMembership(org.id, user.sub);
  if (
    !membership ||
    ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin
  ) {
    reply.redirect("/settings", 302);
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
  if (ctx.org.type !== "reseller") {
    reply.redirect("/org", 302);
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
): Promise<Awaited<ReturnType<OrgService["getOrg"]>>> {
  // Sequential, NOT Promise.all: each call issues a DB query on the
  // request's single reserved-tx connection — a Promise.all of two such
  // method calls stalls it (the #196/#199 hang class). requireCustomerOwnership
  // is the shared gate every Track A tab inherits, so the shape matters.
  const customer = await orgService.getOrg(customerId);
  const parent = await orgService.getResellerOfCustomer(customerId);
  if (!customer || !parent || parent.id !== reseller.org.id) {
    reply.redirect("/org/customers", 302);
    return null;
  }
  return customer;
}

/**
 * Map a `subscriptions` row to the trial-banner view-state for /org/billing.
 *
 * Trial banner fires iff the row exists, `status === 'trialing'`, AND there
 * is a non-null `current_period_end` (the Stripe `trial_end` for trialing
 * subs — without it we cannot compute the days-left countdown OR the
 * "first charge on <date>" line, so we MUST not render the banner).
 *
 * Single-source-pin: the same row backs `deriveDunningView` + the
 * `isServiceActive` gate; routing the trial-banner read through the same
 * row guarantees the banner cannot disagree with what Stripe will charge.
 *
 * Exported so the conditional has a falsifiable unit-test surface — see
 * src/web/routes.test.ts. Replaces the previous `const trial = null;`
 * dead-code that hard-suppressed the banner for every request (ruby HIGH
 * launch-blocker audit 2026-06-04).
 */
export function deriveTrialFromSubscription(
  subscription: { status: string; current_period_end: Date | null } | null,
): TrialState | null {
  if (subscription?.status === "trialing" && subscription.current_period_end) {
    return { endsAt: subscription.current_period_end.toISOString() };
  }
  return null;
}

/**
 * Fastify plugin that registers all web-facing routes for the credential
 * connection flow, settings page, and team management pages.
 */
export function webRoutes(deps: WebRouteDeps) {
  const {
    credentialService,
    orgService,
    billingGate,
    completeAuth,
    logShippingService,
    vendorOAuthStates,
    vendorMonitor,
    adminAuditService,
  } = deps;

  const sweepInterval = setInterval(
    () => {
      // The interval tick has NO request context — sweepExpired()'s getSql()
      // would throw "getSql() called with no DB context", so the sweep is
      // wrapped in runAsSystem() (the explicit system-path entry point).
      // getSql()-no-context class — see the sweep in this PR.
      void runAsSystem(() => vendorOAuthStates.sweepExpired()).catch(() => {
        /* sweep errors are non-fatal; expired-on-read still enforced */
      });
    },
    5 * 60 * 1000,
  );
  sweepInterval.unref();

  return async function (app: FastifyInstance): Promise<void> {
    // =====================================================================
    // Legacy URL redirect — single onRequest hook for the prefix-swap class.
    // The pure transform lives in ./legacy-redirect.ts for unit-testability;
    // this hook is the thin Fastify wrapper. See that file's docblock for
    // the design rationale + bounded-applicability note.
    // =====================================================================
    app.addHook("onRequest", async (request, reply) => {
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
      Querystring: {
        oauth_session?: string;
        org_id?: string;
        team_id?: string;
      };
    }>("/connect/:vendor", async (request, reply) => {
      const { vendor: vendorSlug } = request.params;
      const {
        oauth_session: oauthSession,
        org_id: orgId,
        team_id: teamId,
      } = request.query;

      const vendor = getVendor(vendorSlug);
      if (!vendor) {
        return reply.code(404).send("Unknown vendor");
      }

      const user = requireAuth0(request, reply);
      if (!user) return;

      // org_id / team_id flow: verify the user is an admin of the org
      if (orgId) {
        const membership = await orgService.getMembership(orgId, user.sub);
        if (
          !membership ||
          ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin
        ) {
          return reply.redirect("/settings", 302);
        }
        // If team_id provided, verify the team belongs to this org
        if (teamId) {
          const team = await orgService.getTeam(teamId);
          if (!team || team.orgId !== orgId) {
            return reply.redirect("/settings", 302);
          }
        }
      }

      if (!orgId) {
        const hasCreds = await credentialService.has(user.sub, vendorSlug);
        if (!hasCreds) {
          const limit = await billingGate.getConnectionLimit(user.sub);
          const current = await credentialService.listVendors(user.sub);
          if (current.length >= limit) {
            return reply.redirect("/settings", 302);
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

        const authorizeUrl = buildAuthorizeUrl(
          vendor.oauthConfig,
          stateToken,
          codeVerifier,
        );
        return reply.redirect(authorizeUrl, 302);
      }

      const hasCreds = orgId
        ? (await credentialService.getOrgCredential(orgId, vendorSlug)) !== null
        : await credentialService.has(user.sub, vendorSlug);
      const html = renderConnectPage(vendor, oauthSession, undefined, hasCreds);
      return reply.type("text/html").send(html);
    });

    // ---------- GET /connect/oauth/callback ----------
    app.get<{
      Querystring: {
        code?: string;
        state?: string;
        error?: string;
        realmId?: string;
        iss?: string;
      };
    }>("/connect/oauth/callback", async (request, reply) => {
      const { code, state, error: oauthError, realmId, iss } = request.query;

      if (oauthError || !code || !state) {
        app.log.warn(
          { oauthError, state },
          "OAuth callback error or missing params",
        );
        return reply.redirect("/settings", 302);
      }

      const pending = await vendorOAuthStates.consume(state);
      if (!pending) {
        app.log.warn({ state }, "Unknown or expired OAuth state token");
        return reply.redirect("/settings", 302);
      }

      const vendor = getVendor(pending.vendorSlug);
      if (!vendor?.oauthConfig) {
        return reply.code(400).send("Invalid vendor for OAuth callback");
      }

      // RFC 9207 — OAuth 2.0 Authorization Server Issuer Identification.
      // Opt-in via OAuthVendorConfig.issuer; when set, fail closed on missing
      // or mismatched `iss` to mitigate the OAuth mix-up attack class. The
      // state token was already consumed above (single-use), so this
      // post-consume validation is correct — a replay attempt fails at the
      // state-consume step before reaching here. WYREAI-75 PR B.
      const issError = validateCallbackIssuer(vendor.oauthConfig.issuer, iss);
      if (issError === "missing_iss") {
        app.log.warn(
          {
            vendor: pending.vendorSlug,
            expectedIssuer: vendor.oauthConfig.issuer,
          },
          "OAuth callback missing iss parameter (RFC 9207)",
        );
        return reply.code(400).send("Missing iss parameter on OAuth callback");
      }
      if (issError === "iss_mismatch") {
        app.log.warn(
          {
            vendor: pending.vendorSlug,
            expectedIssuer: vendor.oauthConfig.issuer,
            actualIss: iss,
          },
          "OAuth callback iss mismatch (RFC 9207)",
        );
        return reply.code(400).send("OAuth issuer mismatch");
      }

      try {
        const tokens = await exchangeCodeForTokens(
          vendor.oauthConfig,
          code,
          pending.codeVerifier,
        );

        const extras: Record<string, string> = {};

        if (pending.vendorSlug === "xero") {
          const tenantId = await fetchXeroTenantId(tokens.accessToken);
          if (tenantId) extras.tenantId = tenantId;
        }

        if (pending.vendorSlug === "qbo" && realmId) {
          extras.realmId = realmId;
        }

        if (pending.vendorSlug === "m365") {
          const idToken = tokens.raw.id_token as string | undefined;
          if (idToken) {
            const tenantId = extractTenantIdFromIdToken(idToken);
            if (tenantId) extras.tenantId = tenantId;
          }
        }

        const credData = buildCredentialData(tokens, extras);

        if (pending.teamId && pending.orgId) {
          // Sub-team connect flow: store at team level
          await credentialService.storeTeamCredential(
            pending.teamId,
            pending.orgId,
            pending.vendorSlug,
            credData,
            pending.userId,
          );
          // VC1 SOC2 audit-trail closure: equivalent direct-POST path
          // at src/org/routes.ts also fires this event; OAuth-callback
          // path now matches.
          void adminAuditService
            .log({
              orgId: pending.orgId,
              actorId: pending.userId,
              targetId: pending.teamId,
              eventType: "team_credential_created",
              metadata: {
                teamId: pending.teamId,
                vendor: pending.vendorSlug,
                source: "oauth_callback",
              },
            })
            .catch((err) => request.log.error(err, "admin audit log failed"));
          return reply.redirect(
            `/org/teams/${pending.teamId}/connections`,
            302,
          );
        }

        if (pending.orgId) {
          // Org connect flow: store at org level
          await credentialService.storeOrgCredential(
            pending.orgId,
            pending.vendorSlug,
            credData,
            pending.userId,
          );
          void adminAuditService
            .log({
              orgId: pending.orgId,
              actorId: pending.userId,
              eventType: "org_credential_created",
              metadata: {
                vendor: pending.vendorSlug,
                source: "oauth_callback",
              },
            })
            .catch((err) => request.log.error(err, "admin audit log failed"));
          return reply.redirect("/org/connections", 302);
        }

        await credentialService.store(
          pending.userId,
          pending.vendorSlug,
          credData,
        );

        if (pending.oauthSession) {
          const result = await completeAuth(
            pending.oauthSession,
            pending.userId,
          );
          if (result) {
            return reply.redirect(result.redirectUrl);
          }
        }

        return reply.type("text/html").send(renderSuccessPage(vendor));
      } catch (err) {
        app.log.error(
          { err, vendor: pending.vendorSlug },
          "OAuth token exchange failed",
        );
        return reply.redirect(`/connect/${pending.vendorSlug}`, 302);
      }
    });

    // ---------- POST /connect/:vendor ----------
    app.post<{
      Params: { vendor: string };
      Body: Record<string, string>;
    }>(
      "/connect/:vendor",
      {
        config: {
          rateLimit: { max: 10, timeWindow: "1 minute" },
        },
      },
      async (request, reply) => {
        const { vendor: vendorSlug } = request.params;
        const vendor = getVendor(vendorSlug);
        if (!vendor) {
          return reply.code(404).send("Unknown vendor");
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
            return reply.redirect("/settings", 302);
          }
        }

        for (const field of vendor.fields) {
          if (field.required && !body[field.key]?.trim()) {
            const html = renderConnectPage(
              vendor,
              oauthSession,
              `${field.label} is required`,
            );
            return reply.type("text/html").send(html);
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
              const html = renderConnectPage(
                vendor,
                oauthSession,
                result.error || "Invalid credentials",
              );
              return reply.type("text/html").send(html);
            }
          } catch {
            app.log.warn(
              { vendor: vendorSlug },
              "Credential validation skipped: vendor API unreachable",
            );
          }
        }

        await credentialService.store(userId, vendorSlug, credData);

        if (oauthSession) {
          const result = await completeAuth(oauthSession, userId);
          if (result) {
            return reply.redirect(result.redirectUrl);
          }
        }

        return reply.type("text/html").send(renderSuccessPage(vendor));
      },
    );

    // ---------- POST /disconnect/:vendor ----------
    app.post<{
      Params: { vendor: string };
    }>(
      "/disconnect/:vendor",
      {
        config: {
          rateLimit: { max: 10, timeWindow: "1 minute" },
        },
      },
      async (request, reply) => {
        const { vendor: vendorSlug } = request.params;

        const vendor = getVendor(vendorSlug);
        if (!vendor) {
          return reply.code(404).send("Unknown vendor");
        }

        const user = requireAuth0(request, reply);
        if (!user) return;

        await credentialService.delete(user.sub, vendorSlug);

        return reply.redirect("/settings", 302);
      },
    );

    // =====================================================================
    // Settings page — personal connections (sidebar layout)
    // =====================================================================

    app.get<{ Querystring: { upgraded?: string } }>(
      "/settings",
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const connectedVendors = await credentialService.listVendors(user.sub);
        const orgs = await orgService.getUserOrgs(user.sub);
        const org = orgs[0] ?? null;

        let orgVendors: string[] = [];
        let memberCount = 0;
        let isOwner = false;
        let dunning: DunningView = { state: "none" };
        let trial: TrialState | null = null;
        if (org) {
          orgVendors = await credentialService.listOrgVendors(org.id);
          const members = await orgService.getMembers(org.id);
          memberCount = members.length;
          const membership = await orgService.getMembership(org.id, user.sub);
          isOwner =
            membership?.role === "owner" || membership?.role === "admin";

          // Dunning surface on /settings — ruby D1 HIGH launch-blocker
          // (2026-06-04): a suspended customer trying any billing surface
          // gets 302'd here by requireTeamAccess + canAccessPaidFeatures,
          // and previously this page rendered ZERO dunning state — so
          // their first signal of suspension is "the redirect dropped me
          // somewhere that doesn't explain anything." Now /settings reads
          // the same dunning view as /org/billing (single-source-pin) and
          // the template surfaces the banner / suspended-card. Customer
          // sees the same picture whether they were 302'd here or arrived
          // directly. Same `subscriptions` row drives both.
          //
          // Trial-banner pull-through (ruby OC6 elevation): the trial-
          // banner is also surfaced here for the same reason — flat-
          // pricing, /settings is the personal-default landing surface
          // for trialing users, the banner cannot live only on
          // /org/billing. Single read of `subscriptions` drives both
          // `trial` and `dunning` for one round-trip.
          const settingsStripeClient = config.stripeSecretKey
            ? new Stripe(config.stripeSecretKey)
            : null;
          const subscription = await orgService.getSubscription(org.id);
          trial = deriveTrialFromSubscription(subscription);
          dunning = await deriveDunningView(org.id, {
            orgService,
            stripe: settingsStripeClient,
            graceDays: config.dunningGraceDays,
            stripeSubscriptionId: org.stripeSubscriptionId,
          });
        }

        const connectionLimit = await billingGate.getConnectionLimit(user.sub);
        const upgraded = request.query.upgraded === "true";

        // Seat-billing only needed when we render the trial banner — it
        // carries the per-seat charge composition for "first charge of
        // $X on <date>" copy. Loaded conditionally to avoid an extra
        // service-clients roundtrip on the /settings cold-path.
        let seatBillingForTrial = null;
        if (org && trial) {
          const serviceClients = await orgService.listServiceClients(org.id);
          seatBillingForTrial = computeSeatBilling({
            humans: memberCount,
            agents: serviceClients.length,
          });
        }

        const {
          body: bodyContent,
          pageStyles: connectionsPageStyles,
          pageScripts: connectionsPageScripts,
        } = renderPersonalConnections({
          connectedVendors,
          org,
          orgVendors,
          memberCount,
          connectionLimit,
          upgraded,
          isOwner,
          stripeEnabled: !!(config.stripeSecretKey && config.stripeProPriceId),
          dunning,
          trial,
          seatBilling: seatBillingForTrial,
          firstName: (user.name || "").split(/\s+/)[0] || null,
        });

        const html = renderLayout(
          {
            user,
            org,
            activePath: "/settings",
            title: "Settings",
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            pageStyles: connectionsPageStyles,
            pageScripts: connectionsPageScripts,
          },
          bodyContent,
        );

        return reply.type("text/html").send(html);
      },
    );

    // =====================================================================
    // Profile settings page (sidebar layout)
    // =====================================================================

    app.get("/settings/profile", async (request, reply) => {
      const user = requireAuth0(request, reply);
      if (!user) return;

      const orgs = await orgService.getUserOrgs(user.sub);
      const org = orgs[0] ?? null;

      // Fetch profile fields from the database
      let firstName: string | null = null;
      let lastName: string | null = null;
      let displayName: string | null = null;

      const { getSql } = await import("../db/context.js");
      const rows = await getSql()<
        {
          first_name: string | null;
          last_name: string | null;
          display_name: string | null;
        }[]
      >`
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

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/settings/profile",
          title: "Profile",
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: PROFILE_SETTINGS_STYLES,
        },
        bodyContent,
      );

      return reply.type("text/html").send(html);
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

    const stripeClient = config.stripeSecretKey
      ? new Stripe(config.stripeSecretKey)
      : null;

    app.get("/org/billing", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const plan = getPlan(org.plan) ?? getDefaultPlan();

      // Layer 1 §8 — seat-billing view object. Layer 1 data layer (PR #221)
      // landed; reading via `computeSeatBilling({ humans, agents })`, the pure
      // no-I/O variant explicitly written for callers that already hold the
      // counts (seat-service.ts:73-80). Same Object.freeze snapshot, zero
      // extra DB roundtrip. Sequential awaits on the two count loads (each
      // is a SELECT on the request reserved-tx; postgres.js queues plain
      // SELECTs cleanly, but the #196/#199 hang-class discipline keeps them
      // sequential here regardless).
      const members = await orgService.getMembers(org.id);
      const serviceClients = await orgService.listServiceClients(org.id);
      const seatBilling = computeSeatBilling({
        humans: members.length,
        agents: serviceClients.length,
      });
      // Trial state — derived from the subscriptions row (post-#275). When
      // the row is `status='trialing'` with a non-null `current_period_end`
      // (the Stripe `trial_end` for trialing subs), surface the trial banner
      // + "After your trial" bill label. Single-source-pin: the same row
      // backs `dunning` below + `isServiceActive` upstream, so the trial
      // banner cannot disagree with what Stripe will charge.
      const subscription = await orgService.getSubscription(org.id);
      const trial = deriveTrialFromSubscription(subscription);

      const dunning = await deriveDunningView(org.id, {
        orgService,
        stripe: stripeClient,
        graceDays: config.dunningGraceDays,
        stripeSubscriptionId: org.stripeSubscriptionId,
      });

      const data: TeamBillingData = {
        org,
        plan,
        seatBilling,
        trial,
        // Payment method, upcoming invoice, and invoice history are not
        // rendered on-page — they are shown in the customer's real Stripe
        // billing portal (the "Billing details" block links out to it). An
        // org with no Stripe customer gets the honest managed-directly state.
        // No fabricated billing data reaches this page. Flat-pricing: no
        // credits — the former credit-usage + credit-pack surfaces are gone.
        dunning,
        firstName: (user.name || "").split(/\s+/)[0] || null,
      };

      const pageScripts =
        data.dunning.state === "recovered" ? DUNNING_TOAST_SCRIPT : undefined;

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/billing",
          title: `${org.name} - Billing`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_BILLING_STYLES,
          pageScripts,
        },
        renderTeamBilling(data),
      );

      return reply.type("text/html").send(html);
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

    /**
     * Path-based URL slug for a customer org, display-only. Lowercase
     * + non-alphanumeric → hyphens + collapse repeats + trim. Matches
     * the customer URL shape `conduit.wyre.ai/v1/mcp/<reseller>/<slug>`.
     * Not stored on the org (architectural decision deferred — Aaron-
     * batched task: customer URL routing path-based vs subdomain-based).
     */
    function customerUrlSlug(name: string): string {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    /**
     * Coerce the org's `plan` field to the template's `CustomerPlan`
     * union (badge display). Layer 1 collapses all paid orgs onto a
     * single plan; the template still carries three legacy labels
     * (free/pro/business) for the badge. Display-only mapping — for
     * paid-vs-free gating, route through `isPaidPlan(plan)` from
     * `src/billing/gate.ts` (sub-pattern #10 regression guard).
     */
    function coerceCustomerPlan(plan: string | null | undefined): CustomerPlan {
      const known: Record<string, CustomerPlan> = {
        free: "free",
        pro: "pro",
        business: "business",
      };
      return known[plan ?? ""] ?? "business";
    }

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

    // Real reseller-scoped sibling roster for the customer-detail tenant
    // switcher — replaces the former hardcoded placeholder roster. Scoped by
    // parent_org_id = resellerOrgId AND type = 'customer' (getCustomersOfReseller),
    // the same tenant boundary as the hierarchy fix — never a cross-tenant jump.
    async function resellerSiblings(
      resellerOrgId: string,
    ): Promise<Array<{ id: string; name: string }>> {
      const customers = await orgService.getCustomersOfReseller(resellerOrgId);
      return customers.map((c) => ({ id: c.id, name: c.name }));
    }

    // Real customer-summary header from a VERIFIED-OWNED customer org (always
    // obtained via requireCustomerOwnership). No fabricated identity. Per-customer
    // counts default to honest zero pending the wire phase; the detail/tab
    // templates render honest empty-states ("No MCPs connected", "No members
    // yet") for the empty data arrays — never fabricated figures.
    function customerSummaryOf(
      c: NonNullable<Awaited<ReturnType<OrgService["getOrg"]>>>,
    ): CustomerSummary {
      return {
        id: c.id,
        name: c.name,
        plan: coerceCustomerPlan(c.plan).toUpperCase(),
        userCount: 0,
        mcpCount: 0,
        subdomain: customerUrlSlug(c.name),
      };
    }

    // ---------- GET /org/customers (Track C Surface 1 — Reseller Dashboard) ----------
    //
    // Real customer-organization list for a reseller. Reads from
    // `orgService.getCustomersOfReseller(org.id)` — the data layer
    // already enforces `parent_org_id === resellerId AND type='customer'`
    // (warden Track C review, Finding 2). Auth gate is
    // `requireResellerAccess`: org.type must be 'reseller' AND the caller
    // must hold a membership on the reseller — so the listing is
    // reseller-OWNERSHIP-scoped by construction at this site.
    //
    // Shape mapping Organization → ResellerCustomer:
    //   id, name, plan          → direct
    //   subdomain               → slugify(name), display-only (no storage;
    //                             customer URL is path-based per
    //                             conduit.wyre.ai/v1/mcp/<reseller>/<customer>)
    //   userCount, mcpCalls30d, lastActivity
    //                           → null (em-dash placeholders). The per-
    //                             customer-stats aggregator is filed as
    //                             a separate full-triangle task (see
    //                             commit body); rendering an em-dash
    //                             preserves the visibility-distinct-by-
    //                             design rule (#233 F3 lesson + #235
    //                             obvious-over-compelling pin) — never
    //                             a fabricated stat alongside real id/name.
    app.get("/org/customers", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      // getResellerHierarchy is parent_org_id+type=customer scoped (same
      // boundary as getCustomersOfReseller) and returns each customer's REAL
      // member count in the same 2 cheap queries — no per-customer N+1. The
      // usage stats (mcpCalls30d / lastActivity) stay null (honest em-dash)
      // until the batched per-customer usage aggregator lands — never a
      // fabricated number for a pending one (F3 discipline).
      const { customers: hierarchy } = await orgService.getResellerHierarchy(
        org.id,
      );
      const customers: ResellerCustomer[] = hierarchy.map(
        ({ org: o, userCount }) => ({
          id: o.id,
          name: o.name,
          subdomain: customerUrlSlug(o.name),
          plan: coerceCustomerPlan(o.plan),
          userCount,
          mcpCalls30d: null,
          lastActivity: null,
        }),
      );

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/customers",
          title: `${org.name} - Customers`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: RESELLER_CUSTOMERS_STYLES,
          pageScripts: RESELLER_CUSTOMERS_SCRIPT,
        },
        renderResellerCustomers({ org, customers }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/customers/new (Track C Area 2 — sub-customer onboarding) ----------
    //
    // 3-step wizard to provision a new customer org under the reseller.
    // Registered before /org/customers/:id — Fastify resolves the static
    // segment first, so "new" never falls through to the :id handler.
    // Mock-data-first: a fixed example draft; the final "Create customer"
    // CTA is disabled until the Track A provisioning endpoint lands.
    app.get("/org/customers/new", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      // The draft is carried across the 3 steps via the form-GET query string
      // (each step's Next submits its inputs forward as query params). The
      // wizard is the source of truth — first load (no query) shows an empty
      // identity + sensible defaults, NOT mock data, so the create POST sends
      // exactly what the reseller-admin typed. (Previously a hard-coded
      // "Northwind IT Group" example draft that ignored input + omitted
      // admin_email from the POST.)
      const q = request.query as Record<string, string | undefined>;
      const step = coerceNewCustomerStep(q.step);
      const draftName = typeof q.name === "string" ? q.name : "";
      const derivedSlug = draftName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const data: NewCustomerData = {
        org,
        step,
        draft: {
          name: draftName,
          subdomain:
            typeof q.subdomain === "string" && q.subdomain.length > 0
              ? q.subdomain
              : derivedSlug,
          adminEmail: typeof q.adminEmail === "string" ? q.adminEmail : "",
          inheritBranding: q.inheritBranding !== "false",
          accent:
            typeof q.accent === "string" && q.accent.length > 0
              ? q.accent
              : "#00C9DB",
        },
      };

      const { body, pageScripts } = renderNewCustomer(data);
      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/customers",
          title: `${org.name} - New customer`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: NEW_CUSTOMER_STYLES,
          pageScripts,
        },
        body,
      );
      return reply.type("text/html").send(html);
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
    app.get("/org/customers/:id", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const customerId = (request.params as { id: string }).id;
      // Ownership gate: a reseller may only view a customer it owns
      // (parent_org_id === reseller). Real verified identity — no mock.
      const owned = await requireCustomerOwnership(
        reply,
        ctx,
        customerId,
        orgService,
      );
      if (!owned) return;

      // Real overview counts for the verified-owned customer. Sequential
      // (NOT Promise.all) — both queries run on the request's single
      // reserved-tx connection; a concurrent pair stalls it (#196/#199 hang
      // class). Each is org-scoped to the owned customer.
      const members = await orgService.getMembers(owned.id);
      const vendorSlugs = await credentialService.listOrgVendors(owned.id);
      const customer: CustomerSummary = {
        ...customerSummaryOf(owned),
        userCount: members.length,
        mcpCount: vendorSlugs.length,
      };

      // Real reseller-scoped sibling roster for the tenant switcher.
      const siblings = await resellerSiblings(org.id);

      const { body, pageScripts } = renderResellerCustomerDetail({
        org,
        customer,
      });

      const html = renderLayout(
        {
          user,
          org,
          activePath: `/org/customers/${customerId}`,
          title: `${org.name} - ${customer.name}`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          navMode: "customer-detail",
          customerContext: { id: customer.id, name: customer.name, siblings },
          pageStyles: RESELLER_CUSTOMER_DETAIL_STYLES,
          pageScripts,
        },
        body,
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/customers/:id/{mcps,users,usage,tools,audit,billing,settings} ----------
    //
    // Track C step 5 — the 7 per-org management tabs (Aaron "ship it all").
    // Usage is live (client-fetch of the reseller-scoped dashboard
    // endpoint, which owns reseller-owns-:id authz); the rest are
    // mock-data-first with documented swap-in contracts. All gated by
    // requireResellerAccess. Registered in a loop — the hrefs are
    // dynamic (:id), so they are not part of the static nav lock-step.
    const CUSTOMER_TAB_IDS: CustomerTabId[] = [
      "mcps",
      "users",
      "usage",
      "tools",
      "audit",
      "billing",
      "settings",
    ];

    // Honest empty tab data for a VERIFIED-OWNED customer. Real identity
    // (customerSummaryOf an owned org); data arrays empty so the tab
    // templates render their honest empty-states ("No MCPs connected",
    // "No members yet", "No audit events") — NO fabricated data. Each
    // array is wired to its real reseller-scoped source per-surface in
    // the follow-up wire phase. Usage + audit tabs fetch their bodies live
    // (client-side, endpoint-authz'd) — unaffected by these empties.
    function buildCustomerTabData(
      org: NonNullable<
        Awaited<ReturnType<typeof requireResellerAccess>>
      >["org"],
      customer: CustomerSummary,
      tab: CustomerTabId,
    ): CustomerTabData {
      return {
        org,
        customer,
        tab,
        mcps: [],
        members: [],
        memberTotal: 0,
        toolDepartment: "",
        toolDepartments: [],
        toolGroups: [],
        audit: [],
      };
    }

    // Shared render+send for a customer-detail tab page. Siblings roster is
    // the REAL reseller-scoped customer list (getCustomersOfReseller).
    async function sendCustomerTab(
      request: FastifyRequest,
      reply: FastifyReply,
      user: NonNullable<
        Awaited<ReturnType<typeof requireResellerAccess>>
      >["user"],
      org: NonNullable<
        Awaited<ReturnType<typeof requireResellerAccess>>
      >["org"],
      customerId: string,
      data: CustomerTabData,
    ) {
      const siblings = await resellerSiblings(org.id);
      const { body, pageScripts } = renderCustomerTab(data);
      const html = renderLayout(
        {
          user,
          org,
          activePath: `/org/customers/${customerId}/${data.tab}`,
          title: `${org.name} - ${data.customer.name}`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          navMode: "customer-detail",
          customerContext: {
            id: customerId,
            name: data.customer.name,
            siblings,
          },
          pageStyles: CUSTOMER_TAB_STYLES,
          pageScripts,
        },
        body,
      );
      return reply.type("text/html").send(html);
    }

    // The remaining tabs — one loop. Each verifies the caller OWNS the
    // customer (requireCustomerOwnership) before rendering real identity, then
    // renders honest empty-states (no fabricated data). The usage tab fetches
    // its body live (endpoint-authz'd); the rest await their wire-phase source.
    // 'audit' (live feed), 'users' (real members), and 'mcps' (real connected
    // vendors + health, below) have dedicated handlers.
    for (const tab of CUSTOMER_TAB_IDS.filter(
      (t) => t !== "audit" && t !== "users" && t !== "mcps",
    )) {
      app.get(`/org/customers/:id/${tab}`, async (request, reply) => {
        const ctx = await requireResellerAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const customerId = (request.params as { id: string }).id;
        const owned = await requireCustomerOwnership(
          reply,
          ctx,
          customerId,
          orgService,
        );
        if (!owned) return;
        return sendCustomerTab(request, reply,
          ctx.user,
          ctx.org,
          customerId,
          buildCustomerTabData(ctx.org, customerSummaryOf(owned), tab),
        );
      });
    }

    // ---------- GET /org/customers/:id/users (Track A — real members) ----------
    // The Users tab lists the customer's real org members. Ownership-gated
    // (parent_org_id === reseller). Identity fields (name/email/role) come from
    // the real profile join; department / toolAccess / lastActive have no source
    // in the data model yet -> honest em-dash (never fabricated; F3 discipline),
    // wired when their sources land (tool-access in the tools surface, activity
    // in the usage aggregator, task_1779916566910).
    app.get("/org/customers/:id/users", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const customerId = (request.params as { id: string }).id;
      const owned = await requireCustomerOwnership(
        reply,
        ctx,
        customerId,
        orgService,
      );
      if (!owned) return;
      const profiles = await orgService.getMembersWithProfiles(owned.id);
      const members = profiles.map((m) => ({
        name: m.name ?? m.email ?? "—",
        email: m.email ?? "—",
        role: m.role,
        department: "—",
        toolAccess: "—",
        lastActive: "—",
      }));
      const data = buildCustomerTabData(
        ctx.org,
        customerSummaryOf(owned),
        "users",
      );
      return sendCustomerTab(request, reply, ctx.user, ctx.org, customerId, {
        ...data,
        members,
        memberTotal: members.length,
      });
    });

    // ---------- GET /org/customers/:id/mcps (Track A — real connected vendors) ----------
    // The MCPs tab lists the customer's real connected vendors + live health.
    // Ownership-gated (parent_org_id === reseller). Vendor name + health status
    // come from the real connection set (listOrgVendors) joined with the vendor
    // monitor cache (assembleOrgVendorHealth — the SAME source as the connections
    // health-dot, so status incl 'reachable'/'unknown' is consistent). The
    // wiring `pattern` + per-vendor `seats` have no source in the data model yet
    // -> honest em-dash (never fabricated; F3 discipline).
    app.get("/org/customers/:id/mcps", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const customerId = (request.params as { id: string }).id;
      const owned = await requireCustomerOwnership(
        reply,
        ctx,
        customerId,
        orgService,
      );
      if (!owned) return;
      const slugs = await credentialService.listOrgVendors(owned.id);
      const mcps = assembleOrgVendorHealth(
        slugs,
        vendorMonitor.getStatus(),
      ).map((h) => ({
        vendor: h.displayName,
        pattern: "—",
        seats: "—",
        status: h.status,
      }));
      const data = buildCustomerTabData(
        ctx.org,
        customerSummaryOf(owned),
        "mcps",
      );
      return sendCustomerTab(request, reply, ctx.user, ctx.org, customerId, {
        ...data,
        mcps,
      });
    });

    // ---------- GET /org/customers/:id/audit (Track A — wired to real data) ----------
    //
    // The Audit Log tab serves a real reseller-scoped customer audit feed.
    // Per warden Finding 2 the page swaps the bare requireResellerAccess for
    // the :id-ownership gate (requireCustomerOwnership) BEFORE it renders any
    // real customer identity — a reseller cannot load /audit for a customer
    // it does not own. The feed itself is a live client-fetch of the
    // reseller-scoped /admin/reseller/.../audit endpoint, which independently
    // re-checks ownership + RLS. Gate enforced twice (web shell + endpoint).
    app.get("/org/customers/:id/audit", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const customerId = (request.params as { id: string }).id;
      const customer = await requireCustomerOwnership(
        reply,
        ctx,
        customerId,
        orgService,
      );
      if (!customer) return;
      // Real verified-owned identity + empty arrays; audit feed is live
      // (client fetch of the reseller-scoped endpoint, which owns authz).
      const data = buildCustomerTabData(
        ctx.org,
        customerSummaryOf(customer),
        "audit",
      );
      return sendCustomerTab(request, reply, ctx.user, ctx.org, customerId, data);
    });

    // ---------- GET /org/customers/:id/onboard-mcp (Track C Surface 3 — Onboard wizard) ----------
    //
    // 4-step MCP onboarding wizard. Was a fixed mock scenario shaped like
    // the Track A onboarding read model. `?step=1..4` selected the body. Launched
    // from the (stubbed) S2 Customer Detail surface — reachable by URL
    // until S2 lands. GATED to an honest "coming soon" until the Track A
    // onboarding read model lands — the wizard was a fixed mock scenario
    // (fabricated customer/seats/summary); rather than ship fabricated
    // onboarding data, render the stub. Ownership-verified so it cannot be
    // loaded for a customer the caller doesn't own. (Wire phase rebuilds
    // the wizard against the real provisioning endpoint.)
    app.get("/org/customers/:id/onboard-mcp", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const customerId = (request.params as { id: string }).id;
      const owned = await requireCustomerOwnership(
        reply,
        ctx,
        customerId,
        orgService,
      );
      if (!owned) return;

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/customers",
          title: `${org.name} - Onboard MCP`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          navMode: "customer-detail",
          customerContext: {
            id: owned.id,
            name: owned.name,
            siblings: await resellerSiblings(org.id),
          },
        },
        resellerStubBody("Onboard MCP"),
      );
      return reply.type("text/html").send(html);
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
    app.get("/org/hierarchy", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      // Real reseller-rooted tree: the caller's reseller + its direct customer
      // orgs. getResellerHierarchy is scoped by parent_org_id = org.id AND
      // type = 'customer' (the tenant boundary); the depth-2 hierarchy cap
      // means direct customers are the whole tree (no subtenant level).
      const { customers, resellerUserCount } =
        await orgService.getResellerHierarchy(org.id);
      const root: TenantNode = buildResellerTree(
        org,
        resellerUserCount,
        customers,
      );

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/hierarchy",
          title: `${org.name} - Hierarchy`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: RESELLER_HIERARCHY_STYLES,
          pageScripts: RESELLER_HIERARCHY_SCRIPT,
        },
        renderResellerHierarchy({ org, root }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/reseller/* (Track C Surface 5 — stubs) ----------
    //
    // Registered as explicit `app.get('<literal>', …)` calls (not a loop)
    // so the layout.test.ts lock-step source-grep can statically verify
    // each nav href has a handler. The shared `resellerSettingsStub`
    // factory keeps the bodies DRY without hiding the path literal.
    const resellerSettingsStub =
      (path: string, label: string) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await requireResellerAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const { user, org } = ctx;
        const html = renderLayout(
          {
            user,
            org,
            activePath: path,
            title: `${org.name} - ${label}`,
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            navMode: "reseller-settings",
          },
          resellerStubBody(label),
        );
        return reply.type("text/html").send(html);
      };

    // /org/reseller/general — Reseller-scoped General settings (sweep-3, June 29
    // launch). Replaces the resellerSettingsStub with the actual form surface.
    // Per boss dispatch msg-1781452776703: slug stays derived for v1 (reseller-
    // custom-slug = Aaron-decision-class slice with downstream link-rot
    // implications). Form POSTs to the existing PATCH /api/orgs/:orgId.
    app.get<{ Querystring: { flash_ok?: string; flash_err?: string } }>(
      "/org/reseller/general",
      async (request, reply) => {
        const ctx = await requireResellerAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const { user, org } = ctx;
        const html = renderLayout(
          {
            user,
            org,
            activePath: "/org/reseller/general",
            title: `${org.name} - General`,
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            navMode: "reseller-settings",
            pageStyles: RESELLER_GENERAL_STYLES,
          },
          renderResellerGeneral({
            org,
            flashOk: request.query.flash_ok,
            flashErr: request.query.flash_err,
          }),
        );
        return reply.type("text/html").send(html);
      },
    );
    // 2026-06-13 sweep-2 cluster-1 (3) (boss): /org/reseller/billing replaces
    // the stub with the real Stripe-billing-portal surface. POST
    // /api/billing/portal is org-id-keyed + org-type-agnostic + already
    // handles the no-stripeCustomerId + non-owner-403 cases.
    app.get("/org/reseller/billing", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;
      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/reseller/billing",
          title: `${org.name} - Billing & Plans`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          navMode: "reseller-settings",
          pageStyles: RESELLER_BILLING_STYLES,
        },
        renderResellerBilling({ org }),
      );
      return reply.type("text/html").send(html);
    });
    app.get(
      "/org/reseller/api",
      resellerSettingsStub("/org/reseller/api", "API & Webhooks"),
    );
    // 2026-06-14 sweep-2 cluster-2 (c) (boss): /org/reseller/audit replaces
    // the stub with the real Audit Log surface. AdminAuditService.query is
    // already org-scoped + paginated; this route just plumbs the reseller's
    // own org_id + URL pagination/filter params into it.
    app.get<{ Querystring: { page?: string; event_type?: string } }>(
      "/org/reseller/audit",
      async (request, reply) => {
        const ctx = await requireResellerAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const { user, org } = ctx;

        const PAGE_SIZE = 50;
        const pageParam = Number.parseInt(request.query.page ?? "1", 10);
        const page =
          Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
        const eventTypeFilter = request.query.event_type?.trim() || null;

        // Two queries: paginated entries for the current page, and the
        // distinct event types present in the underlying log (for the
        // filter dropdown). Sequential not Promise.all on the request's
        // single reserved-tx connection — same hang-class as the
        // tools/call site (see shouldCapturePrompt note).
        const { entries, total } = await adminAuditService.query({
          orgId: org.id,
          eventType: eventTypeFilter ?? undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });
        const availableEventTypes = await adminAuditService.distinctEventTypes(
          org.id,
        );

        const html = renderLayout(
          {
            user,
            org,
            activePath: "/org/reseller/audit",
            title: `${org.name} - Audit Log`,
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            navMode: "reseller-settings",
            pageStyles: RESELLER_AUDIT_STYLES,
          },
          renderResellerAudit({
            org,
            entries,
            total,
            page,
            pageSize: PAGE_SIZE,
            eventTypeFilter,
            availableEventTypes,
          }),
        );
        return reply.type("text/html").send(html);
      },
    );

    // ---------- GET /org/reseller/branding (Track C Surface 5 — White-Label Branding) ----------
    //
    // The reseller-settings "Branding" tab. Mock-data-first: the `branding`
    // record below is shaped like the Track A reseller-settings read model.
    // When that endpoint lands, the mock builder is the single swap-in point
    // — the template renders unchanged. v1 ships the layout with a disabled
    // "Save changes" affordance (no dead persistence route).
    app.get("/org/reseller/branding", async (request, reply) => {
      const ctx = await requireResellerAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const slug = org.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const branding: ResellerBranding = {
        defaultUrl: `conduit.wyre.ai/v1/mcp/${slug}/example-customer`,
        brandAlias: "mcp.wyretechnology.com",
        aliasVerified: true,
        logoUrl: null,
        colors: {
          accent: "#D93232",
          textOnDark: "#F2F2F5",
          textOnLight: "#212126",
        },
        emailFromName: org.name,
        emailFromAddress: "notifications@conduit.wyre.ai",
        emailAuthStatus: "SPF + DKIM verified · DMARC pending",
        emailAuthVerified: false,
        directBillingEnabled: false,
      };

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/reseller/branding",
          title: `${org.name} - Branding`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          navMode: "reseller-settings",
          pageStyles: RESELLER_BRANDING_STYLES,
        },
        renderResellerBranding({
          org,
          branding,
          sampleCustomerName: "Example Customer",
        }),
      );
      return reply.type("text/html").send(html);
    });

    // =====================================================================
    // Team management pages (sidebar layout, Pro plan + admin/owner)
    // =====================================================================

    // ---------- GET /org ----------
    app.get("/org", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const members = await orgService.getMembers(org.id);
      // 2026-06-13 sweep-2 cluster-1 (4) (boss): when the org is a reseller,
      // surface the customers count alongside member count so the Overview
      // header gives the reseller at-a-glance context about their managed
      // fleet size. The query is scoped to parent_org_id = org.id AND
      // type = 'customer' (same tenant boundary as getResellerHierarchy +
      // customer-list — never a cross-tenant jump). Customer + standalone
      // orgs skip the query entirely (no customerCount, subtitle unchanged).
      let customerCount: number | undefined;
      if (org.type === "reseller") {
        const customers = await orgService.getCustomersOfReseller(org.id);
        customerCount = customers.length;
      }

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org",
          title: `${org.name} - Overview`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_OVERVIEW_STYLES,
        },
        renderTeamOverview({ org, memberCount: members.length, customerCount }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/members ----------
    app.get("/org/members", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org, membership } = ctx;

      const members = await orgService.getMembersWithProfiles(org.id);
      // Per-seat cost note reads PER_SEAT_PRICE_CENTS from the named SoT
      // constant in the template — no seat-billing snapshot needed here.

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/members",
          title: `${org.name} - Members`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_MEMBERS_STYLES,
        },
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
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/invitations ----------
    app.get("/org/invitations", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const invitations = await orgService.listInvitations(org.id);
      // Per-seat cost note reads PER_SEAT_PRICE_CENTS from the named SoT
      // constant in the template — no seat-billing snapshot needed here.

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/invitations",
          title: `${org.name} - Invitations`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_INVITATIONS_STYLES,
        },
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
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/connections ----------
    app.get("/org/connections", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const orgVendors = await credentialService.listOrgVendors(org.id);

      // Vendor container health — SSR reads the VendorMonitor cache directly
      // (no self-HTTP-fetch). assembleOrgVendorHealth is the SAME function the
      // GET /api/orgs/:orgId/vendor-health endpoint uses; passing orgVendors
      // (the org's connected slugs) org-scopes it — the global cache is never
      // rendered unfiltered.
      const vendorHealth = new Map(
        assembleOrgVendorHealth(orgVendors, vendorMonitor.getStatus()).map(
          (vh) => [vh.vendorSlug, vh] as const,
        ),
      );

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/connections",
          title: `${org.name} - Connections`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_CONNECTIONS_STYLES,
        },
        renderTeamConnections({ orgId: org.id, orgVendors, vendorHealth }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/tool-access ----------
    app.get("/org/tool-access", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/tool-access",
          title: `${org.name} - Tool Access`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_TOOL_ACCESS_STYLES,
        },
        renderTeamToolAccess({ orgId: org.id, orgVendors }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/server-access ----------
    app.get("/org/server-access", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org, membership } = ctx;

      const members = await orgService.getMembersWithProfiles(org.id);
      const orgVendors = await credentialService.listOrgVendors(org.id);
      const serverAccessGrants = await orgService.listServerAccess(org.id);
      const teamGrants = await orgService.listEffectiveTeamAccessForOrg(org.id);

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/server-access",
          title: `${org.name} - Server Access`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_SERVER_ACCESS_STYLES,
        },
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
          serverAccess: serverAccessGrants.map((g) => ({
            userId: g.userId,
            vendorSlug: g.vendorSlug,
          })),
          teamGrants,
        }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/teams ----------
    app.get("/org/teams", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const teams = await orgService.listTeamsWithDetails(org.id);
      const orgMembers = await orgService.getMembersWithProfiles(org.id);
      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/teams",
          title: `${org.name} - Teams`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_TEAMS_STYLES,
        },
        renderTeamTeams({
          orgId: org.id,
          teams,
          orgMembers: orgMembers.map((m) => ({
            userId: m.userId,
            name: m.name,
            email: m.email,
          })),
          orgVendors,
        }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/service-clients ----------
    app.get("/org/service-clients", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      // Layer 1 §8 — seat-billing for the at-creation cost copy. Real Layer 1
      // data layer (PR #221) via the pure no-I/O `computeSeatBilling`.
      const members = await orgService.getMembers(org.id);
      const serviceClients = await orgService.listServiceClients(org.id);
      const seatBilling = computeSeatBilling({
        humans: members.length,
        agents: serviceClients.length,
      });
      // Trial state — derived from the same subscriptions row backing
      // /org/billing's trial banner. The service-clients page uses the
      // boolean to swap the at-creation cost copy ("During trial …" vs
      // "$X/mo per agent"); same single-source-pin as the billing banner.
      const trialing =
        deriveTrialFromSubscription(
          await orgService.getSubscription(org.id),
        ) !== null;

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/service-clients",
          title: `${org.name} - Service Clients`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_SERVICE_CLIENTS_STYLES,
        },
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
          seatBilling,
          trialing,
        }),
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/scim ----------
    app.get("/org/scim", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const connections = new ScimConnectionsService();
      const rows = await connections.listForOrg(org.id);
      const scope = org.type === "reseller" ? "reseller" : "tenant";

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/scim",
          title: `${org.name} - Provisioning`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_SCIM_STYLES,
        },
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
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/domains ----------
    app.get("/org/domains", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const domainService = new OrgDomainService();
      const domains = await domainService.list(org.id);
      // Auto-join seat-cost note reads PER_SEAT_PRICE_CENTS from the named
      // SoT constant in the template — no seat-billing snapshot needed here.

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/domains",
          title: `${org.name} - Domains`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_DOMAINS_STYLES,
        },
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
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/teams/:teamId/connections ----------
    app.get<{ Params: { teamId: string } }>(
      "/org/teams/:teamId/connections",
      async (request, reply) => {
        const ctx = await requireTeamAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const { user, org } = ctx;

        const { teamId } = request.params;
        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== org.id) {
          return reply.code(404).send("Team not found");
        }

        const teamVendors = await credentialService.listTeamVendors(teamId);

        const html = renderLayout(
          {
            user,
            org,
            activePath: "/org/teams",
            title: `${team.name} - Connections`,
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            pageStyles: TEAM_TEAM_CONNECTIONS_STYLES,
          },
          renderTeamTeamConnections({
            orgId: org.id,
            teamId,
            teamName: team.name,
            teamVendors,
          }),
        );
        return reply.type("text/html").send(html);
      },
    );

    // ---------- GET /org/teams/:teamId/tool-access/:vendor (WYREAI-63) ----------
    // Team-scoped tool-access admin UI — parity port of gateway #200 frontend.
    // Authz baseline = requireTeamAccess (admin/owner role at the request shell)
    // mirrors the WYREAI-62 API admin-gate. The team-ownership check
    // (team.orgId === org.id) defends against IDOR — a reseller-admin cannot
    // load /tool-access for a team owned by a different org via URL guessing.
    app.get<{ Params: { teamId: string; vendor: string } }>(
      "/org/teams/:teamId/tool-access/:vendor",
      async (request, reply) => {
        const ctx = await requireTeamAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const { user, org } = ctx;

        const { teamId, vendor: vendorSlug } = request.params;
        const team = await orgService.getTeam(teamId);
        if (!team || team.orgId !== org.id) {
          return reply.code(404).send("Team not found");
        }
        const vendorConfig = getVendor(vendorSlug);
        if (!vendorConfig) {
          return reply.code(404).send("Unknown vendor");
        }

        // The WYREAI-62 audit-extended read. null = inherit-org-defaults state.
        const allowlist = await orgService.getTeamToolAllowlistWithAudit(
          org.id,
          teamId,
          vendorSlug,
        );

        const html = renderLayout(
          {
            user,
            org,
            activePath: "/org/teams",
            title: `${team.name} - ${vendorConfig.name} tool access`,
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            pageStyles: TEAM_SCOPE_TOOL_ACCESS_STYLES,
          },
          renderTeamScopeToolAccess({
            org,
            team,
            vendorSlug,
            vendorName: vendorConfig.name,
            allowlist,
          }),
        );
        return reply.type("text/html").send(html);
      },
    );

    // ---------- GET /org/service-clients/:clientId/connections ----------
    app.get<{ Params: { clientId: string } }>(
      "/org/service-clients/:clientId/connections",
      async (request, reply) => {
        const ctx = await requireTeamAccess(
          request,
          reply,
          orgService,
          billingGate,
        );
        if (!ctx) return;
        const { user, org } = ctx;

        const { clientId } = request.params;
        const serviceClient =
          await orgService.getServiceClientByClientId(clientId);
        if (!serviceClient || serviceClient.orgId !== org.id) {
          return reply.code(404).send("Service client not found");
        }

        const clientVendors =
          await credentialService.listServiceClientVendors(clientId);

        const html = renderLayout(
          {
            user,
            org,
            activePath: "/org/service-clients",
            title: `${serviceClient.name} - Connections`,
            actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
            pageStyles: TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES,
          },
          renderTeamServiceClientConnections({
            orgId: org.id,
            clientId,
            clientName: serviceClient.name,
            clientVendors,
          }),
        );
        return reply.type("text/html").send(html);
      },
    );

    // ---------- GET /org/log-shipping ----------
    app.get("/org/log-shipping", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const destinations = await logShippingService.list(org.id);

      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/log-shipping",
          title: `${org.name} - Log Shipping`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_LOG_SHIPPING_STYLES,
        },
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
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/dashboard ----------
    app.get("/org/dashboard", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
      if (!ctx) return;
      const { user, org } = ctx;

      const { body, pageStyles, pageScripts } = renderTeamDashboard({
        orgId: org.id,
        orgName: org.name,
      });
      const html = renderLayout(
        {
          user,
          org,
          activePath: "/org/dashboard",
          title: `${org.name} - Dashboard`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles,
          pageScripts,
        },
        body,
      );
      return reply.type("text/html").send(html);
    });

    // ---------- GET /org/audit ----------
    app.get("/org/audit", async (request, reply) => {
      const ctx = await requireTeamAccess(
        request,
        reply,
        orgService,
        billingGate,
      );
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
        {
          user,
          org,
          activePath: "/org/audit",
          title: `${org.name} - Audit Log`,
          actingAsBadge: await actingAsBadgeFromRequest(request, orgService),
          pageStyles: TEAM_AUDIT_STYLES,
        },
        renderTeamAudit({
          orgId: org.id,
          captureEnabled,
          planAllowsCapture,
          isOwner: membership.role === "owner",
        }),
      );
      return reply.type("text/html").send(html);
    });

    // =====================================================================
    // Redirects
    // =====================================================================

    // Legacy team management URL → new sidebar URL
    app.get<{ Params: { orgId: string } }>(
      "/org/:orgId/settings",
      async (_request, reply) => {
        return reply.redirect("/org", 301);
      },
    );
  };
}
