import type { FastifyInstance } from 'fastify';
import type { OrgService } from './org-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { ToolCache } from '../proxy/tool-cache.js';
import { getVendor } from '../credentials/vendor-config.js';
import { requireOrgRole } from './org-route-helpers.js';

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
    // Admin-tier (was 'owner', flipped 2026-05-31 per parity with gateway #107):
    // tool-allowlist writes are an org-config concern, not an ownership-tier
    // concern. The sibling GET / discover handlers on this resource were already
    // admin — there was never a coherent reason for read/write to differ. Reserve
    // 'owner' for billing / subscription / ownership-transfer / org-deletion.
    app.put<{
      Params: { orgId: string; vendor: string; role: string };
      Body: { tools: string[] };
    }>(
      '/api/orgs/:orgId/tool-access/:vendor/:role',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug, role } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
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
    // Admin-tier — same rationale as the PUT above; admin owns tool-allowlist writes.
    app.delete<{ Params: { orgId: string; vendor: string; role: string } }>(
      '/api/orgs/:orgId/tool-access/:vendor/:role',
      async (request, reply) => {
        const { orgId, vendor: vendorSlug, role } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
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
          tools = await toolCache.getTools(vendorSlug, vendor.containerUrl, headers, vendor.mcpPath ?? '/mcp');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          request.log.warn({ vendor: vendorSlug, err: message }, 'tool discovery failed');
          return reply.code(502).send({ error: `Tool discovery failed: ${message}` });
        }
        request.log.info({ vendor: vendorSlug, toolCount: tools.length }, 'tool discovery result');
        return reply.send({ tools });
      },
    );

    // -----------------------------------------------------------------------
    // Team-scoped tool-access routes (WYREAI-62, parity port of gateway #200).
    //
    // GET returns `{ tools, grantedBy?, grantedAt? }` — audit metadata at the
    // response shape per gateway #200. PUT + DELETE mirror the role-scoped
    // routes' replace-set semantics; admin-tier authz throughout (admin-read +
    // admin-write parity per WYREAI-58, "audit reads should not differ in tier
    // from writes on the same resource").
    //
    // Authz baseline: `requireOrgRole(... 'admin')`. The team membership of
    // the caller is NOT additionally checked here — admin owns team-tool-access
    // for their org per the v1 baseline. The finer-grain team-membership
    // restriction is a tracked v2 hardening item (sibling WYREAI-66).
    // -----------------------------------------------------------------------

    // GET /api/orgs/:orgId/teams/:teamId/tool-access/:vendor — team allowlist + audit
    app.get<{ Params: { orgId: string; teamId: string; vendor: string } }>(
      '/api/orgs/:orgId/teams/:teamId/tool-access/:vendor',
      async (request, reply) => {
        const { orgId, teamId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        const result = await orgService.getTeamToolAllowlistWithAudit(orgId, teamId, vendorSlug);
        if (!result) {
          // No team-scoped rows → "inherit org defaults" per gateway #200 UX rule.
          return reply.send({ tools: null });
        }
        return reply.send(result);
      },
    );

    // PUT /api/orgs/:orgId/teams/:teamId/tool-access/:vendor — set team allowlist
    app.put<{
      Params: { orgId: string; teamId: string; vendor: string };
      Body: { tools: string[] };
    }>(
      '/api/orgs/:orgId/teams/:teamId/tool-access/:vendor',
      async (request, reply) => {
        const { orgId, teamId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        const { tools } = request.body;
        if (!Array.isArray(tools)) {
          return reply.code(400).send({ error: 'tools must be an array of tool names' });
        }

        await orgService.setTeamToolAllowlist(orgId, teamId, vendorSlug, tools, user.sub);
        return reply.send({ success: true });
      },
    );

    // DELETE /api/orgs/:orgId/teams/:teamId/tool-access/:vendor — clear team allowlist
    app.delete<{ Params: { orgId: string; teamId: string; vendor: string } }>(
      '/api/orgs/:orgId/teams/:teamId/tool-access/:vendor',
      async (request, reply) => {
        const { orgId, teamId, vendor: vendorSlug } = request.params;
        const user = await requireOrgRole(request, reply, orgService, orgId, 'admin');
        if (!user) return;

        await orgService.clearTeamToolAllowlist(orgId, teamId, vendorSlug);
        return reply.code(204).send();
      },
    );
  };
}
