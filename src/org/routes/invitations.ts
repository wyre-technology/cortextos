import type { FastifyInstance } from 'fastify';
import { brand } from '../../brand/index.js';
import { requireAuth0 } from '../../auth/auth0.js';
import type { OrgService } from '../org-service.js';
import type { BillingGate } from '../../billing/gate.js';
import { config } from '../../config.js';
import { requireOrgRole } from './helpers.js';

// ---------------------------------------------------------------------------
// Minimal inline HTML templates for invite pages
// ---------------------------------------------------------------------------

const INVITE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: #0a0a0a; color: #e5e5e5;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 48px 24px;
  }
  .card {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 40px 32px; max-width: 420px; width: 100%; text-align: center;
  }
  .brand { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: #737373; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 600; color: #f5f5f5; margin-bottom: 8px; }
  .subtitle { font-size: 14px; color: #a3a3a3; margin-bottom: 28px; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 100%; padding: 10px 20px; background: #2563eb; color: #fff;
    font-size: 14px; font-weight: 600; font-family: inherit;
    border: none; border-radius: 6px; cursor: pointer; text-decoration: none;
  }
  .btn:hover { background: #1d4ed8; }
  .error-icon { font-size: 32px; margin-bottom: 16px; color: #ef4444; }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInvitePage(orgName: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Join ${escapeHtml(orgName)} - ${escapeHtml(brand.name)}</title>
<style>${INVITE_STYLES}</style></head>
<body><div class="card">
  <div class="brand">${escapeHtml(brand.name)}</div>
  <h1>Join ${escapeHtml(orgName)}</h1>
  <p class="subtitle">You've been invited to join this team. Accept to share vendor connections and collaborate with your team.</p>
  <form method="POST" action="/invite/${escapeHtml(token)}">
    <button type="submit" class="btn">Accept &amp; Join Team</button>
  </form>
</div></body></html>`;
}

function renderInviteErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Invalid Invitation - ${escapeHtml(brand.name)}</title>
<style>${INVITE_STYLES}</style></head>
<body><div class="card">
  <div class="brand">${escapeHtml(brand.name)}</div>
  <div class="error-icon">&#10007;</div>
  <h1>Invalid Invitation</h1>
  <p class="subtitle">${escapeHtml(message)}</p>
  <a class="btn" href="/settings">Go to Settings</a>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface InvitationRouteDeps {
  orgService: OrgService;
  billingGate: BillingGate;
}

export function invitationRoutes(deps: InvitationRouteDeps) {
  const { orgService, billingGate } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // POST /api/orgs/:orgId/invitations — create invite link
    app.post<{ Params: { orgId: string }; Body: { maxUses?: number | null; expiresInHours?: number } }>(
      '/api/orgs/:orgId/invitations',
      { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        // Require pro plan for team features
        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) {
          return reply.code(402).send({ error: 'Upgrade to Pro to invite team members' });
        }

        const body = (request.body as { maxUses?: number | null; expiresInHours?: number }) || {};

        // Validate maxUses: must be >= 1 or null (unlimited)
        if (body.maxUses !== undefined && body.maxUses !== null) {
          if (typeof body.maxUses !== 'number' || body.maxUses < 1 || !Number.isInteger(body.maxUses)) {
            return reply.code(400).send({ error: 'maxUses must be a positive integer or null' });
          }
        }

        // Validate expiresInHours: must be between 1 and 720 (30 days)
        if (body.expiresInHours !== undefined) {
          if (typeof body.expiresInHours !== 'number' || body.expiresInHours < 1 || body.expiresInHours > 720) {
            return reply.code(400).send({ error: 'expiresInHours must be between 1 and 720' });
          }
        }

        const invitation = await orgService.createInvitation(orgId, user.sub, {
          maxUses: body.maxUses,
          expiresInHours: body.expiresInHours,
        });
        const inviteUrl = `${config.baseUrl}/invite/${invitation.token}`;

        return reply.code(201).send({ ...invitation, inviteUrl });
      },
    );

    // GET /api/orgs/:orgId/invitations — list pending invites
    app.get<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId/invitations',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        const invitations = await orgService.listInvitations(orgId);
        return reply.send(invitations);
      },
    );

    // DELETE /api/orgs/:orgId/invitations/:id — revoke invite
    app.delete<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/invitations/:id',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        await orgService.revokeInvitation(id);
        return reply.code(204).send();
      },
    );

    // GET /invite/:token — show invitation acceptance page
    app.get<{ Params: { token: string } }>(
      '/invite/:token',
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return; // Redirects to login

        const { token } = request.params;
        const invitation = await orgService.getInvitationByToken(token);
        if (!invitation) {
          return reply.code(404).type('text/html').send(renderInviteErrorPage('This invitation has expired or is no longer valid.'));
        }

        const org = await orgService.getOrg(invitation.orgId);
        if (!org) {
          return reply.code(404).type('text/html').send(renderInviteErrorPage('Organization not found.'));
        }

        return reply.type('text/html').send(renderInvitePage(org.name, token));
      },
    );

    // POST /invite/:token — accept invitation
    app.post<{ Params: { token: string } }>(
      '/invite/:token',
      { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
      async (request, reply) => {
        const user = requireAuth0(request, reply);
        if (!user) return;

        const { token } = request.params;
        const member = await orgService.acceptInvitation(token, user.sub);
        if (!member) {
          return reply.code(404).type('text/html').send(renderInviteErrorPage('This invitation has expired or is no longer valid.'));
        }

        return reply.redirect('/settings', 302);
      },
    );
  };
}
