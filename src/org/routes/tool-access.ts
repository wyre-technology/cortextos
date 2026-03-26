import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org-service.js';
import type { CredentialService } from '../../credentials/credential-service.js';
import type { ToolCache } from '../../proxy/tool-cache.js';
import { getVendor } from '../../credentials/vendor-config.js';
import { requireOrgRole } from './helpers.js';

interface ToolAccessRouteDeps {
  orgService: OrgService;
  credentialService: CredentialService;
  toolCache: ToolCache;
}

export function toolAccessRoutes(deps: ToolAccessRouteDeps) {
  const { orgService, credentialService, toolCache } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // GET /api/orgs/:orgId/tool-access/:vendor — get allowlists per role
    app.get<{ Params: { orgId: string; vendor: string } }>(
      '/api/orgs/:orgId/tool-access/:vendor',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        const allowlists = await orgService.getAllToolAllowlists(orgId, vendorSlug);
        return reply.send(allowlists);
      },
    );

    // PUT /api/orgs/:orgId/tool-access/:vendor/:role — set tool allowlist
    app.put<{
      Params: { orgId: string; vendor: string; role: string };
      Body: { tools: string[] };
    }>(
      '/api/orgs/:orgId/tool-access/:vendor/:role',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug, role } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        if (role !== 'admin' && role !== 'member') {
          return reply.code(400).send({ error: 'Role must be "admin" or "member"' });
        }

        const { tools } = request.body;
        if (!Array.isArray(tools)) {
          return reply.code(400).send({ error: 'tools must be an array of tool names' });
        }

        await orgService.setToolAllowlist(orgId, vendorSlug, role, tools, user.sub);
        return reply.send({ success: true });
      },
    );

    // DELETE /api/orgs/:orgId/tool-access/:vendor/:role — clear allowlist (revert to allow-all)
    app.delete<{ Params: { orgId: string; vendor: string; role: string } }>(
      '/api/orgs/:orgId/tool-access/:vendor/:role',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug, role } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'owner');
        if (!user) return;

        if (role !== 'admin' && role !== 'member') {
          return reply.code(400).send({ error: 'Role must be "admin" or "member"' });
        }

        await orgService.clearToolAllowlist(orgId, vendorSlug, role);
        return reply.code(204).send();
      },
    );

    // GET /api/orgs/:orgId/tool-access/:vendor/discover — discover available tools from vendor
    app.get<{ Params: { orgId: string; vendor: string } }>(
      '/api/orgs/:orgId/tool-access/:vendor/discover',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        const vendor = getVendor(vendorSlug);
        if (!vendor) {
          return reply.code(404).send({ error: 'Unknown vendor' });
        }

        // Get org credentials to authenticate with the vendor
        const orgCreds = await credentialService.getOrgCredential(orgId, vendorSlug);
        if (!orgCreds) {
          return reply.code(404).send({ error: 'No org credentials for this vendor' });
        }

        // Build headers the same way the proxy does
        let headers: Record<string, string>;
        if (vendor.buildHeaders) {
          headers = vendor.buildHeaders(orgCreds);
        } else {
          headers = {};
          for (const [fieldKey, headerName] of Object.entries(vendor.headerMapping)) {
            const value = orgCreds[fieldKey];
            if (value) headers[headerName] = value;
          }
        }

        let tools: Awaited<ReturnType<typeof toolCache.getTools>>;
        try {
          tools = await toolCache.getTools(vendorSlug, vendor.containerUrl, headers);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          request.log.warn({ vendor: vendorSlug, err: message }, 'tool discovery failed');
          return reply.code(502).send({ error: `Tool discovery failed: ${message}` });
        }
        request.log.info({ vendor: vendorSlug, toolCount: tools.length }, 'tool discovery result');
        return reply.send({ tools });
      },
    );
  };
}
