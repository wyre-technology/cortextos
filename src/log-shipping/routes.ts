import type { FastifyInstance } from 'fastify';
import { requireAuth0 } from '../auth/auth0.js';
import type { OrgService, OrgRole } from '../org/org-service.js';
import { ROLE_LEVEL } from '../org/org-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { AdminAuditService } from '../audit/admin-audit-service.js';
import type { LogShippingService } from './log-shipping-service.js';
import { maskConfig } from './log-shipping-service.js';
import type { LogShippingAdapter } from './adapters/types.js';

interface LogShippingRouteDeps {
  orgService: OrgService;
  billingGate: BillingGate;
  adminAuditService: AdminAuditService;
  logShippingService: LogShippingService;
  adapters: Map<string, LogShippingAdapter>;
}

async function requireOrgAdmin(
  request: Parameters<typeof requireAuth0>[0],
  reply: Parameters<typeof requireAuth0>[1],
  orgService: OrgService,
  orgId: string,
) {
  const user = requireAuth0(request, reply);
  if (!user) return null;
  const membership = await orgService.getMembership(orgId, user.sub);
  if (!membership || ROLE_LEVEL[membership.role as OrgRole] < ROLE_LEVEL.admin) {
    reply.code(403).send({ error: 'You do not have permission to perform this action' });
    return null;
  }
  return user;
}

export function logShippingRoutes(deps: LogShippingRouteDeps) {
  const { orgService, billingGate, adminAuditService, logShippingService, adapters } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    // GET /api/orgs/:orgId/log-shipping — list destinations
    app.get<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId/log-shipping',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const dests = await logShippingService.list(orgId);
        return reply.send(dests.map((d) => ({ ...d, config: maskConfig(d.config) })));
      },
    );

    // POST /api/orgs/:orgId/log-shipping — create destination
    app.post<{
      Params: { orgId: string };
      Body: { label: string; platform: string; endpointUrl: string; config: Record<string, string> };
    }>(
      '/api/orgs/:orgId/log-shipping',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const { label, platform, endpointUrl, config } = request.body;
        if (!label?.trim()) return reply.code(400).send({ error: 'Label is required' });
        if (!['loki', 'graylog', 'logscale'].includes(platform)) {
          return reply.code(400).send({ error: 'platform must be loki, graylog, or logscale' });
        }
        if (!endpointUrl?.trim()) return reply.code(400).send({ error: 'endpointUrl is required' });

        const dest = await logShippingService.create({
          orgId,
          label: label.trim(),
          platform: platform as 'loki' | 'graylog' | 'logscale',
          endpointUrl: endpointUrl.trim(),
          config: config ?? {},
          createdBy: user.sub,
        });

        void adminAuditService.log({
          orgId,
          actorId: user.sub,
          targetId: dest.id,
          eventType: 'log_shipping_destination_created',
          metadata: { label: dest.label, platform: dest.platform },
        }).catch((err) => request.log.error(err, 'admin audit log failed'));

        return reply.code(201).send({ ...dest, config: maskConfig(dest.config) });
      },
    );

    // GET /api/orgs/:orgId/log-shipping/:id — get destination + recent errors
    app.get<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/log-shipping/:id',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const dest = await logShippingService.get(id);
        if (!dest || dest.orgId !== orgId) return reply.code(404).send({ error: 'Destination not found' });

        const recentErrors = await logShippingService.getRecentErrors(id);
        return reply.send({ ...dest, config: maskConfig(dest.config), recentErrors });
      },
    );

    // PATCH /api/orgs/:orgId/log-shipping/:id — update label / endpoint / config
    app.patch<{
      Params: { orgId: string; id: string };
      Body: { label?: string; endpointUrl?: string; config?: Record<string, string> };
    }>(
      '/api/orgs/:orgId/log-shipping/:id',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const dest = await logShippingService.get(id);
        if (!dest || dest.orgId !== orgId) return reply.code(404).send({ error: 'Destination not found' });

        const updated = await logShippingService.update(id, request.body);

        void adminAuditService.log({
          orgId,
          actorId: user.sub,
          targetId: id,
          eventType: 'log_shipping_destination_updated',
          metadata: { label: updated?.label },
        }).catch((err) => request.log.error(err, 'admin audit log failed'));

        return reply.send(updated ? { ...updated, config: maskConfig(updated.config) } : null);
      },
    );

    // DELETE /api/orgs/:orgId/log-shipping/:id — delete destination
    app.delete<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/log-shipping/:id',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const dest = await logShippingService.get(id);
        if (!dest || dest.orgId !== orgId) return reply.code(404).send({ error: 'Destination not found' });

        await logShippingService.delete(id);

        void adminAuditService.log({
          orgId,
          actorId: user.sub,
          targetId: id,
          eventType: 'log_shipping_destination_deleted',
          metadata: { label: dest.label, platform: dest.platform },
        }).catch((err) => request.log.error(err, 'admin audit log failed'));

        return reply.code(204).send();
      },
    );

    // POST /api/orgs/:orgId/log-shipping/:id/test — test connection
    app.post<{ Params: { orgId: string; id: string } }>(
      '/api/orgs/:orgId/log-shipping/:id/test',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const dest = await logShippingService.get(id);
        if (!dest || dest.orgId !== orgId) return reply.code(404).send({ error: 'Destination not found' });

        const adapter = adapters.get(dest.platform);
        if (!adapter) return reply.code(500).send({ error: 'No adapter for this platform' });

        try {
          await adapter.test(dest);
          return reply.send({ ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.code(422).send({ error: message });
        }
      },
    );

    // PATCH /api/orgs/:orgId/log-shipping/:id/enabled — toggle enabled
    app.patch<{ Params: { orgId: string; id: string }; Body: { enabled: boolean } }>(
      '/api/orgs/:orgId/log-shipping/:id/enabled',
      async (request, reply) => {
        const { orgId, id } = request.params;
        const user = await requireOrgAdmin(request, reply, orgService, orgId);
        if (!user) return;

        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) return reply.code(402).send({ error: 'Upgrade to Pro to use log shipping' });

        const dest = await logShippingService.get(id);
        if (!dest || dest.orgId !== orgId) return reply.code(404).send({ error: 'Destination not found' });

        const { enabled } = request.body;
        if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be a boolean' });

        const updated = await logShippingService.setEnabled(id, enabled);
        return reply.send(updated ? { ...updated, config: maskConfig(updated.config) } : null);
      },
    );
  };
}
