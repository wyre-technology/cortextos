import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org-service.js';
import type { CredentialService } from '../../credentials/credential-service.js';
import type { BillingGate } from '../../billing/gate.js';
import type { ToolCache } from '../../proxy/tool-cache.js';
import { orgCrudRoutes } from './org-crud.js';
import { memberRoutes } from './members.js';
import { invitationRoutes } from './invitations.js';
import { credentialRoutes } from './credentials.js';
import { toolAccessRoutes } from './tool-access.js';

interface OrgRouteDeps {
  orgService: OrgService;
  credentialService: CredentialService;
  billingGate: BillingGate;
  toolCache: ToolCache;
}

export function orgRoutes(deps: OrgRouteDeps) {
  const { orgService, credentialService, billingGate, toolCache } = deps;

  return async function plugin(app: FastifyInstance): Promise<void> {
    await app.register(orgCrudRoutes({ orgService }));
    await app.register(memberRoutes({ orgService }));
    await app.register(invitationRoutes({ orgService, billingGate }));
    await app.register(credentialRoutes({ orgService, credentialService, billingGate }));
    await app.register(toolAccessRoutes({ orgService, credentialService, toolCache }));
  };
}
