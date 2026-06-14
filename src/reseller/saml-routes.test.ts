// =============================================================================
// src/reseller/saml-routes.test.ts
//
// Tests for the reseller-self-service SAML wizard (Piece 3). The LOAD-
// BEARING security surface is the authorization gate
// (authorizeResellerAdminOnCustomer); these tests pin the gate behavior +
// the basic endpoint shapes. Full integration tests against real Auth0 +
// Postgres are out of scope for this scaffold PR.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { samlRoutes, type SamlRoutesDeps } from './saml-routes.js';
import { enterTestContext } from '../db/context.js';
import type postgres from 'postgres';

// Test-context shim: handlers wrap their service calls in runAsSystem,
// which requires the AsyncLocalStorage context to be set. enterTestContext
// installs a no-op sql so the runAsSystem wrapper resolves; the actual
// service calls are mocked in deps so no real DB access happens.
function setupTestContext(): void {
  const noopSql = vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;
  enterTestContext(noopSql);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface AuthorizeOutcome {
  allow: boolean;
  status?: number;
  body?: string;
}

function makeAuthorize(
  outcome: AuthorizeOutcome,
  opts?: { customerOrgAuth0OrgId?: string | null },
): SamlRoutesDeps['authorizeResellerAdminOnCustomer'] {
  return async (_request, reply, resellerId, customerOrgId) => {
    if (!outcome.allow) {
      reply.code(outcome.status ?? 403).send(outcome.body ?? 'forbidden');
      return null;
    }
    // If opts.customerOrgAuth0OrgId is the property KEY-present (including
    // explicit null), respect the override. Use `in` to distinguish
    // "explicitly null" from "not passed at all" since ?? treats null as
    // falsy and would substitute the default.
    const customerOrgAuth0OrgId =
      opts && 'customerOrgAuth0OrgId' in opts
        ? opts.customerOrgAuth0OrgId ?? null
        : 'auth0-org-customer-default';
    return {
      callerUserId: 'caller-u',
      resellerId,
      customerOrgId,
      customerOrgAuth0OrgId,
    };
  };
}

async function makeApp(overrides?: Partial<SamlRoutesDeps>): Promise<FastifyInstance> {
  setupTestContext();
  const app = Fastify();
  await app.register(formbody);
  await app.register(
    samlRoutes({
      authorizeResellerAdminOnCustomer:
        overrides?.authorizeResellerAdminOnCustomer ?? makeAuthorize({ allow: true }),
      orgIdpConnectionService: overrides?.orgIdpConnectionService,
      auth0ManagementClient: overrides?.auth0ManagementClient,
      adminAuditService:
        overrides?.adminAuditService ??
        ({ log: vi.fn().mockResolvedValue(undefined) } as never),
      onRollbackFailure: overrides?.onRollbackFailure,
      getOrSetCsrfToken: overrides?.getOrSetCsrfToken ?? (() => 'csrf-test-token'),
      parseSamlMetadata:
        overrides?.parseSamlMetadata ??
        ((xml) =>
          xml.includes('VALID')
            ? { entityId: 'https://idp.example/entity', signInEndpoint: 'https://idp.example/sso', x509Cert: 'CERT' }
            : { error: 'invalid metadata' }),
    }),
  );
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Authorization gate — LOAD-BEARING security surface
// ---------------------------------------------------------------------------

describe('authorizeResellerAdminOnCustomer — gate on all endpoints', () => {
  const endpoints = [
    { method: 'GET' as const, path: '/admin/reseller/r-1/customers/c-1/idp-connections' },
    { method: 'GET' as const, path: '/admin/reseller/r-1/customers/c-1/idp-connections/new' },
    { method: 'POST' as const, path: '/admin/reseller/r-1/customers/c-1/idp-connections' },
    { method: 'POST' as const, path: '/admin/reseller/r-1/customers/c-1/idp-connections/idp-99/delete' },
  ];

  for (const { method, path } of endpoints) {
    it(`${method} ${path} returns 403 when authorize denies`, async () => {
      const app = await makeApp({
        authorizeResellerAdminOnCustomer: makeAuthorize({ allow: false, status: 403, body: 'denied' }),
      });
      const res = await app.inject({
        method,
        url: path,
        payload: method === 'POST' ? 'display_name=x&metadata_xml=y' : undefined,
        headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
      });
      expect(res.statusCode).toBe(403);
    });

    it(`${method} ${path} runs authorize with the URL params`, async () => {
      const spy = vi.fn().mockImplementation(makeAuthorize({ allow: true }));
      const app = await makeApp({ authorizeResellerAdminOnCustomer: spy });
      await app.inject({
        method,
        url: path,
        payload: method === 'POST' ? 'display_name=x&metadata_xml=y' : undefined,
        headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
      });
      // Authorize was called with the resellerId + customerOrgId from URL params.
      // The 3rd + 4th args are resellerId + customerOrgId per the deps signature.
      expect(spy).toHaveBeenCalled();
      const callArgs = spy.mock.calls[0];
      expect(callArgs[2]).toBe('r-1');
      expect(callArgs[3]).toBe('c-1');
    });
  }
});

// ---------------------------------------------------------------------------
// Endpoint shapes
// ---------------------------------------------------------------------------

describe('GET .../idp-connections — list', () => {
  it('renders the list page with services-disabled notice when no services injected', async () => {
    const app = await makeApp({ orgIdpConnectionService: undefined, auth0ManagementClient: undefined });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Customer IdP Connections');
    expect(res.body).toContain('IdP wizard requires AUTH0_M2M_CLIENT_ID/SECRET');
  });

  it('renders the list page with connections when service is injected', async () => {
    const stubService = {
      listForOrg: vi.fn().mockResolvedValue([
        { id: 'idp-1', orgId: 'c-1', strategy: 'samlp', displayName: 'Okta', entityId: 'urn:okta', status: 'active', auth0ConnectionId: 'conn-okta' },
      ]),
      create: vi.fn(),
      getById: vi.fn(),
      hardDelete: vi.fn(),
    } as never;
    const auth0 = {} as never;
    const app = await makeApp({
      orgIdpConnectionService: stubService,
      auth0ManagementClient: auth0,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Okta');
    expect(res.body).toContain('urn:okta');
    expect((stubService as { listForOrg: ReturnType<typeof vi.fn> }).listForOrg)
      .toHaveBeenCalledWith('c-1');
  });
});

describe('GET .../idp-connections/new — wizard form', () => {
  it('renders the form with CSRF + display_name + metadata_xml inputs', async () => {
    const app = await makeApp({ getOrSetCsrfToken: () => 'csrf-fixture' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections/new',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Add SAML Connection');
    expect(res.body).toContain('name="_csrf"');
    expect(res.body).toContain('value="csrf-fixture"');
    expect(res.body).toContain('name="display_name"');
    expect(res.body).toContain('name="metadata_xml"');
  });
});

describe('POST .../idp-connections — BOTH-OR-NEITHER submit', () => {
  it('redirects with flash_err when services are not configured', async () => {
    const app = await makeApp({
      orgIdpConnectionService: undefined,
      auth0ManagementClient: undefined,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Test&metadata_xml=VALID',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_err');
  });

  it('redirects back to /new with parse error when metadata is invalid', async () => {
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: vi.fn(), getById: vi.fn(), hardDelete: vi.fn() } as never,
      auth0ManagementClient: {} as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Test&metadata_xml=INVALID_XML',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('/idp-connections/new');
    expect(location).toContain('flash_err');
  });

  it('happy path — Auth0 createConnection + enableConnection + DB INSERT all succeed → flash_ok + audit-emit fires', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'auth0-conn-123', name: 'reseller-r-1-c-1-saml' });
    const enable = vi.fn().mockResolvedValue(undefined);
    const dbCreate = vi.fn().mockResolvedValue({ id: 'idp-1', orgId: 'c-1' });
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: dbCreate, getById: vi.fn(), hardDelete: vi.fn() } as never,
      auth0ManagementClient: { createConnection: create, enableConnection: enable, deleteConnection: vi.fn() } as never,
      adminAuditService: { log: auditLog } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Okta&metadata_xml=VALID',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_ok');
    // RUBY HIGH MUST-FIX #1 closure: all 3 Auth0+DB steps fire in order.
    expect(create).toHaveBeenCalled();
    expect(enable).toHaveBeenCalledWith('auth0-org-customer-default', 'auth0-conn-123');
    expect(dbCreate).toHaveBeenCalled();
    // RUBY HIGH MUST-FIX #2 closure: audit-emit fires at POST.ok branch.
    // Fire-and-forget — use a small await to let microtasks run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'c-1',
        actorId: 'caller-u',
        eventType: 'idp_connection_created',
        metadata: expect.objectContaining({
          auth0_connection_id: 'auth0-conn-123',
          created_via: 'reseller_self_service',
          reseller_org_id: 'r-1',
        }),
      }),
    );
  });

  it('enableConnection failure → rollback fires → flash_err + audit-emit does NOT fire (BOTH-OR-NEITHER preserved)', async () => {
    // RUBY HIGH MUST-FIX #1 regression-guard: enableConnection failure
    // must trigger rollback + NOT persist anything in DB + NOT fire audit.
    const create = vi.fn().mockResolvedValue({ id: 'auth0-conn-456', name: 'reseller-r-1-c-1-saml' });
    const enable = vi.fn().mockRejectedValue(new Error('Auth0 enable failed'));
    const deleteConn = vi.fn().mockResolvedValue(undefined);
    const dbCreate = vi.fn();
    const auditLog = vi.fn();
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: dbCreate, getById: vi.fn(), hardDelete: vi.fn() } as never,
      auth0ManagementClient: { createConnection: create, enableConnection: enable, deleteConnection: deleteConn } as never,
      adminAuditService: { log: auditLog } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Okta&metadata_xml=VALID',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_err');
    expect(deleteConn).toHaveBeenCalledWith('auth0-conn-456');
    expect(dbCreate).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('rollback-of-rollback observability — onRollbackFailure hook fires when Auth0 deleteConnection fails (warden Finding 2)', async () => {
    // WARDEN Finding 2 closure: when rollback itself fails (orphan Auth0
    // connection), the onRollbackFailure hook fires with structured fields
    // so ops can detect + manual-cleanup without log-mining.
    const create = vi.fn().mockResolvedValue({ id: 'orphan-conn-789', name: 'reseller-r-1-c-1-saml' });
    const enable = vi.fn().mockResolvedValue(undefined);
    const dbCreate = vi.fn().mockRejectedValue(new Error('DB INSERT failed'));
    const deleteConn = vi.fn().mockRejectedValue(new Error('Auth0 503: cannot delete'));
    const onRollbackFailure = vi.fn();
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: dbCreate, getById: vi.fn(), hardDelete: vi.fn() } as never,
      auth0ManagementClient: { createConnection: create, enableConnection: enable, deleteConnection: deleteConn } as never,
      onRollbackFailure,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Okta&metadata_xml=VALID',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_err');
    // Hook fired with structured fields — the load-bearing observability
    // for the orphan-Auth0-connection case.
    expect(onRollbackFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        auth0ConnectionId: 'orphan-conn-789',
        customerOrgId: 'c-1',
        errClass: 'Error',
        errMessage: 'Auth0 503: cannot delete',
      }),
    );
  });

  it('customer-org not yet provisioned in Auth0 (null customerOrgAuth0OrgId) → flash_err, no Auth0 calls', async () => {
    // RUBY HIGH MUST-FIX #1 sub-case: mid-rollout customer-org has no
    // auth0_org_id yet. The handler MUST NOT call enableConnection (that
    // would fail with a confusing Auth0 error). Instead, surface a clear
    // missing-precondition flash_err.
    const create = vi.fn();
    const enable = vi.fn();
    const app = await makeApp({
      authorizeResellerAdminOnCustomer: makeAuthorize(
        { allow: true },
        { customerOrgAuth0OrgId: null },
      ),
      orgIdpConnectionService: { listForOrg: vi.fn(), create: vi.fn(), getById: vi.fn(), hardDelete: vi.fn() } as never,
      auth0ManagementClient: { createConnection: create, enableConnection: enable, deleteConnection: vi.fn() } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Okta&metadata_xml=VALID',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_err');
    expect(res.headers.location as string).toContain('not+yet+provisioned');
    // No Auth0 calls because precondition failed upfront.
    expect(create).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });

  it('rollback — Auth0 createConnection + enableConnection succeed + DB INSERT fails → deleteConnection called', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'auth0-conn-123', name: 'reseller-r-1-c-1-saml' });
    const enable = vi.fn().mockResolvedValue(undefined);
    const deleteConn = vi.fn().mockResolvedValue(undefined);
    const dbCreate = vi.fn().mockRejectedValue(new Error('db down'));
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: dbCreate, getById: vi.fn(), hardDelete: vi.fn() } as never,
      auth0ManagementClient: { createConnection: create, enableConnection: enable, deleteConnection: deleteConn } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections',
      payload: 'display_name=Okta&metadata_xml=VALID',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_err');
    // Rollback fired: Auth0 createConnection was deleted (after enable succeeded).
    expect(deleteConn).toHaveBeenCalledWith('auth0-conn-123');
  });
});

describe('POST .../idp-connections/:id/delete — removal', () => {
  it('refuses to delete a connection that does not belong to the customerOrgId (cross-org defense)', async () => {
    const otherOrgConn = { id: 'idp-1', orgId: 'OTHER-CUSTOMER-ORG', auth0ConnectionId: 'conn-x' };
    const getById = vi.fn().mockResolvedValue(otherOrgConn);
    const deleteConn = vi.fn();
    const hardDelete = vi.fn();
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: vi.fn(), getById, hardDelete } as never,
      auth0ManagementClient: { createConnection: vi.fn(), deleteConnection: deleteConn } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections/idp-1/delete',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_err');
    // CRITICAL: neither Auth0 nor DB delete fired — cross-org isolation preserved.
    expect(deleteConn).not.toHaveBeenCalled();
    expect(hardDelete).not.toHaveBeenCalled();
  });

  it('deletes both Auth0 connection + DB row + fires audit-emit when ownership matches', async () => {
    const conn = { id: 'idp-1', orgId: 'c-1', strategy: 'samlp', entityId: 'urn:okta', auth0ConnectionId: 'conn-okta' };
    const getById = vi.fn().mockResolvedValue(conn);
    const deleteConn = vi.fn().mockResolvedValue(undefined);
    const hardDelete = vi.fn().mockResolvedValue(undefined);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const app = await makeApp({
      orgIdpConnectionService: { listForOrg: vi.fn(), create: vi.fn(), getById, hardDelete } as never,
      auth0ManagementClient: { createConnection: vi.fn(), enableConnection: vi.fn(), deleteConnection: deleteConn } as never,
      adminAuditService: { log: auditLog } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reseller/r-1/customers/c-1/idp-connections/idp-1/delete',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('flash_ok');
    expect(deleteConn).toHaveBeenCalledWith('conn-okta');
    expect(hardDelete).toHaveBeenCalledWith('idp-1');
    // RUBY HIGH MUST-FIX #2 closure: audit-emit fires at DELETE success branch.
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'c-1',
        actorId: 'caller-u',
        eventType: 'idp_connection_deleted',
        metadata: expect.objectContaining({
          auth0_connection_id: 'conn-okta',
          connection_id: 'idp-1',
          deleted_via: 'reseller_self_service',
          reseller_org_id: 'r-1',
        }),
      }),
    );
  });
});
