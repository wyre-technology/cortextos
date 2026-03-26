import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org-service.js';
import type { CredentialService } from '../../credentials/credential-service.js';
import type { BillingGate } from '../../billing/gate.js';
import { getVendor } from '../../credentials/vendor-config.js';
import { requireOrgRole } from './helpers.js';

interface CredentialRouteDeps {
  orgService: OrgService;
  credentialService: CredentialService;
  billingGate: BillingGate;
}

export function credentialRoutes(deps: CredentialRouteDeps) {
  const { orgService, credentialService, billingGate } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // POST /api/orgs/:orgId/credentials/:vendor — store org credential
    app.post<{ Params: { orgId: string; vendor: string }; Body: Record<string, string> }>(
      '/api/orgs/:orgId/credentials/:vendor',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request, reply) => {
        const { orgId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        // Require pro plan
        const canTeam = await billingGate.canUseTeamFeatures(orgId);
        if (!canTeam) {
          return reply.code(402).send({ error: 'Upgrade to Pro to manage team credentials' });
        }

        const vendor = getVendor(vendorSlug);
        if (!vendor) {
          return reply.code(404).send({ error: 'Unknown vendor' });
        }

        // Validate required fields
        const body = request.body;
        const credData: Record<string, string> = {};
        for (const field of vendor.fields) {
          if (field.required && !body[field.key]?.trim()) {
            return reply.code(400).send({ error: `${field.label} is required` });
          }
          if (body[field.key]) {
            credData[field.key] = body[field.key].trim();
          }
        }

        // Validate against vendor API
        if (vendor.validate) {
          try {
            const result = await vendor.validate(credData);
            if (!result.valid) {
              return reply.code(422).send({ error: result.error || 'Invalid credentials' });
            }
          } catch {
            app.log.warn({ vendor: vendorSlug }, 'Org credential validation skipped: vendor API unreachable');
          }
        }

        const id = await credentialService.storeOrgCredential(orgId, vendorSlug, credData, user.sub);
        return reply.code(201).send({ id, vendor: vendorSlug });
      },
    );

    // GET /api/orgs/:orgId/credentials — list org vendor connections
    app.get<{ Params: { orgId: string } }>(
      '/api/orgs/:orgId/credentials',
      async (request, reply) => {
        const { orgId } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'member');
        if (!user) return;

        const vendors = await credentialService.listOrgVendors(orgId);
        return reply.send(vendors);
      },
    );

    // DELETE /api/orgs/:orgId/credentials/:vendor — remove org credential
    app.delete<{ Params: { orgId: string; vendor: string } }>(
      '/api/orgs/:orgId/credentials/:vendor',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        await credentialService.deleteOrgCredential(orgId, vendorSlug);
        return reply.code(204).send();
      },
    );
  };
}
