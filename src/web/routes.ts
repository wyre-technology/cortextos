import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService, OrgRole } from '../org/org-service.js';
import type { LogShippingService } from '../log-shipping/log-shipping-service.js';
import { ROLE_LEVEL } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import { getVendor } from '../credentials/vendor-config.js';
import { renderConnectPage } from './templates/connect.js';
import { requireAuth0 } from '../auth/auth0.js';
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
import { renderSuccessPage } from './helpers.js';
import { renderPersonalConnections } from './templates/personal-connections.js';
import { renderTeamOverview, TEAM_OVERVIEW_STYLES } from './templates/team-overview.js';
import { renderTeamMembers, TEAM_MEMBERS_STYLES } from './templates/team-members.js';
import { renderTeamInvitations, TEAM_INVITATIONS_STYLES } from './templates/team-invitations.js';
import { renderTeamConnections, TEAM_CONNECTIONS_STYLES } from './templates/team-connections.js';
import { renderTeamToolAccess, TEAM_TOOL_ACCESS_STYLES } from './templates/team-tool-access.js';
import { renderTeamServerAccess, TEAM_SERVER_ACCESS_STYLES } from './templates/team-server-access.js';
import { renderTeamServiceClients, TEAM_SERVICE_CLIENTS_STYLES } from './templates/team-service-clients.js';
import { renderTeamScim, TEAM_SCIM_STYLES } from './templates/team-scim.js';
import { ScimConnectionsService } from '../scim/connections-service.js';
import { renderTeamAudit, TEAM_AUDIT_STYLES } from './templates/team-audit.js';
import { renderTeamTeams, TEAM_TEAMS_STYLES } from './templates/team-teams.js';
import { renderTeamLogShipping, TEAM_LOG_SHIPPING_STYLES } from './templates/team-log-shipping.js';
import { renderTeamTeamConnections, TEAM_TEAM_CONNECTIONS_STYLES } from './templates/team-team-connections.js';
import { renderTeamServiceClientConnections, TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES } from './templates/team-service-client-connections.js';
import { renderProfileSettings, PROFILE_SETTINGS_STYLES } from './templates/profile-settings.js';
import { renderTeamDashboard } from './templates/team-dashboard.js';

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
  sql?: postgres.Sql;
  vendorOAuthStates: VendorOAuthStateStore;
  completeAuth: (sessionId: string, userId: string) => Promise<{ redirectUrl: string } | null>;
  logShippingService: LogShippingService;
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
  if (plan !== 'pro') {
    reply.redirect('/settings', 302);
    return null;
  }

  const orgs = await orgService.getUserOrgs(user.sub);
  const org = orgs[0];
  if (!org) {
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
 * Fastify plugin that registers all web-facing routes for the credential
 * connection flow, settings page, and team management pages.
 */
export function webRoutes(deps: WebRouteDeps) {
  const { credentialService, orgService, billingGate, completeAuth, logShippingService, vendorOAuthStates } = deps;

  const sweepInterval = setInterval(() => {
    void vendorOAuthStates.sweepExpired().catch(() => {
      /* sweep errors are non-fatal; expired-on-read still enforced */
    });
  }, 5 * 60 * 1000);
  sweepInterval.unref();

  return async function (app: FastifyInstance): Promise<void> {
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
          return reply.redirect(`/settings/team/teams/${pending.teamId}/connections`, 302);
        }

        if (pending.orgId) {
          // Org connect flow: store at org level
          await credentialService.storeOrgCredential(pending.orgId, pending.vendorSlug, credData, pending.userId);
          return reply.redirect('/settings/team/connections', 302);
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

      if (deps.sql) {
        const rows = await deps.sql<{ first_name: string | null; last_name: string | null; display_name: string | null }[]>`
          SELECT first_name, last_name, display_name FROM users WHERE id = ${user.sub}
        `;
        if (rows.length > 0) {
          firstName = rows[0].first_name;
          lastName = rows[0].last_name;
          displayName = rows[0].display_name;
        }
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
    // Team management pages (sidebar layout, Pro plan + admin/owner)
    // =====================================================================

    // ---------- GET /settings/team ----------
    app.get('/settings/team', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const members = await orgService.getMembers(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team', title: `${org.name} - Overview`, pageStyles: TEAM_OVERVIEW_STYLES },
        renderTeamOverview({ org, memberCount: members.length }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /settings/team/members ----------
    app.get('/settings/team/members', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org, membership } = ctx;

      const members = await orgService.getMembersWithProfiles(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/members', title: `${org.name} - Members`, pageStyles: TEAM_MEMBERS_STYLES },
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

    // ---------- GET /settings/team/invitations ----------
    app.get('/settings/team/invitations', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const invitations = await orgService.listInvitations(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/invitations', title: `${org.name} - Invitations`, pageStyles: TEAM_INVITATIONS_STYLES },
        renderTeamInvitations({
          orgId: org.id,
          baseUrl: config.baseUrl,
          invitations: invitations.map((inv) => ({
            id: inv.id,
            token: inv.token,
            expiresAt: inv.expiresAt,
            maxUses: inv.maxUses,
            useCount: inv.useCount,
            createdAt: inv.createdAt,
          })),
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /settings/team/connections ----------
    app.get('/settings/team/connections', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/connections', title: `${org.name} - Connections`, pageStyles: TEAM_CONNECTIONS_STYLES },
        renderTeamConnections({ orgId: org.id, orgVendors }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /settings/team/tool-access ----------
    app.get('/settings/team/tool-access', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/tool-access', title: `${org.name} - Tool Access`, pageStyles: TEAM_TOOL_ACCESS_STYLES },
        renderTeamToolAccess({ orgId: org.id, orgVendors }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /settings/team/server-access ----------
    app.get('/settings/team/server-access', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org, membership } = ctx;

      const members = await orgService.getMembersWithProfiles(org.id);
      const orgVendors = await credentialService.listOrgVendors(org.id);
      const serverAccessGrants = await orgService.listServerAccess(org.id);
      const teamGrants = await orgService.listEffectiveTeamAccessForOrg(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/server-access', title: `${org.name} - Server Access`, pageStyles: TEAM_SERVER_ACCESS_STYLES },
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

    // ---------- GET /settings/team/teams ----------
    app.get('/settings/team/teams', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const teams = await orgService.listTeamsWithDetails(org.id);
      const orgMembers = await orgService.getMembersWithProfiles(org.id);
      const orgVendors = await credentialService.listOrgVendors(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/teams', title: `${org.name} - Teams`, pageStyles: TEAM_TEAMS_STYLES },
        renderTeamTeams({
          orgId: org.id,
          teams,
          orgMembers: orgMembers.map((m) => ({ userId: m.userId, name: m.name, email: m.email })),
          orgVendors,
        }),
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /settings/team/service-clients ----------
    app.get('/settings/team/service-clients', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const serviceClients = await orgService.listServiceClients(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/service-clients', title: `${org.name} - Service Clients`, pageStyles: TEAM_SERVICE_CLIENTS_STYLES },
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

    // ---------- GET /settings/team/scim ----------
    app.get('/settings/team/scim', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const connections = new ScimConnectionsService(deps.sql!);
      const rows = await connections.listForOrg(org.id);
      const scope = org.type === 'reseller' ? 'reseller' : 'tenant';

      const html = renderLayout(
        { user, org, activePath: '/settings/team/scim', title: `${org.name} - Provisioning`, pageStyles: TEAM_SCIM_STYLES },
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

    // ---------- GET /settings/team/teams/:teamId/connections ----------
    app.get<{ Params: { teamId: string } }>(
      '/settings/team/teams/:teamId/connections',
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
          { user, org, activePath: '/settings/team/teams', title: `${team.name} - Connections`, pageStyles: TEAM_TEAM_CONNECTIONS_STYLES },
          renderTeamTeamConnections({ orgId: org.id, teamId, teamName: team.name, teamVendors }),
        );
        return reply.type('text/html').send(html);
      },
    );

    // ---------- GET /settings/team/service-clients/:clientId/connections ----------
    app.get<{ Params: { clientId: string } }>(
      '/settings/team/service-clients/:clientId/connections',
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
          { user, org, activePath: '/settings/team/service-clients', title: `${serviceClient.name} - Connections`, pageStyles: TEAM_SERVICE_CLIENT_CONNECTIONS_STYLES },
          renderTeamServiceClientConnections({ orgId: org.id, clientId, clientName: serviceClient.name, clientVendors }),
        );
        return reply.type('text/html').send(html);
      },
    );

    // ---------- GET /settings/team/log-shipping ----------
    app.get('/settings/team/log-shipping', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const destinations = await logShippingService.list(org.id);

      const html = renderLayout(
        { user, org, activePath: '/settings/team/log-shipping', title: `${org.name} - Log Shipping`, pageStyles: TEAM_LOG_SHIPPING_STYLES },
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

    // ---------- GET /settings/team/dashboard ----------
    app.get('/settings/team/dashboard', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const { body, pageStyles, pageScripts } = renderTeamDashboard({ orgId: org.id, orgName: org.name });
      const html = renderLayout(
        { user, org, activePath: '/settings/team/dashboard', title: `${org.name} - Dashboard`, pageStyles, pageScripts },
        body,
      );
      return reply.type('text/html').send(html);
    });

    // ---------- GET /settings/team/audit ----------
    app.get('/settings/team/audit', async (request, reply) => {
      const ctx = await requireTeamAccess(request, reply, orgService, billingGate);
      if (!ctx) return;
      const { user, org } = ctx;

      const html = renderLayout(
        { user, org, activePath: '/settings/team/audit', title: `${org.name} - Audit Log`, pageStyles: TEAM_AUDIT_STYLES },
        renderTeamAudit({ orgId: org.id }),
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
        return reply.redirect('/settings/team', 301);
      },
    );
  };
}
