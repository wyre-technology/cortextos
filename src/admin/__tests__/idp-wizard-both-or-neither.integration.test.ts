/**
 * SAML wizard BOTH-OR-NEITHER integration test — slice 6+7 PR-B
 * load-bearing assertion (June 29 launch directive 2026-06-13).
 *
 * Why this exists (boss msg 1781371711406): the 4-step BOTH-OR-NEITHER
 * pipeline has more failure modes than slice-3's 2-step (3 distinct
 * rollback paths + rollback-failure-swallow at all). Unit tests pin
 * cheap-detector signatures; this file is the load-bearing assertion
 * against REAL Postgres semantics + mocked Auth0ManagementClient with
 * controllable throw points. Sibling-pattern to slice-3 #384
 * (org-auth0-provisioner.integration.test.ts).
 *
 * The pipeline:
 *   Step 1: parse SAML XML via samlify (errors -> flash_err)
 *   Step 2: Auth0 createConnection (errors -> no DB write, no rollback)
 *   Step 3: Auth0 enableConnection (errors -> rollback Step 2 via
 *           deleteConnection)
 *   Step 4: DB INSERT (errors -> rollback Steps 2+3 via deleteConnection
 *           cascade)
 *   On any rollback failure: log error + swallow, original-error
 *   propagates as the load-bearing signal.
 *
 * Each scenario asserts the COMPLETE post-state at both DB-layer (orgs +
 * org_idp_connections + admin_audit_log) AND Auth0-layer (mocked client
 * call-counts) so a regression in either substrate surfaces here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

// requireAdmin / requireAdminMutation gate on (a) Bearer ADMIN_API_KEY or
// (b) session.email in adminEmails Set + emailVerified=true. The test
// harness picks BOTH paths — Bearer for POST mutations (skips CSRF),
// session for GET (defensive preHandler stub below).
//
// CLOSURE-CAPTURE GOTCHA — DO NOT MOVE THIS BELOW THE IMPORTS:
//   src/lib/admin-auth.ts captures `config.adminEmails` + `config.adminApiKey`
//   inside its module-level closures at IMPORT time. The vi.mock call
//   below MUST run BEFORE any import that transitively pulls in
//   admin-auth.ts (i.e. before adminOrgRoutes), otherwise the closures
//   capture the REAL config and the mock is silently ignored — every
//   request 401s with no obvious explanation. Vitest hoists vi.mock to
//   the top of the file regardless of source position, but keeping the
//   call physically above the imports preserves readability + signals
//   the constraint to future contributors who might be tempted to
//   reshuffle.
vi.mock('../../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config.js')>();
  return {
    ...original,
    config: {
      ...original.config,
      adminEmails: new Set(['admin@wyre.test']),
      adminApiKey: 'test-admin-api-key',
    },
  };
});

import { adminOrgRoutes } from '../org-routes.js';
import { OrgService } from '../../org/org-service.js';
import { OrgIdpConnectionService } from '../../org/org-idp-connection-service.js';
import { AdminAuditService } from '../../audit/admin-audit-service.js';
import { CreditService } from '../../billing/credit-service.js';
import { DefaultBillingGate } from '../../billing/gate.js';
import { DefaultSeatService } from '../../billing/seat-service.js';
import type { Auth0ManagementClient } from '../../auth/auth0-management.js';
import { enterTestContext } from '../../db/context.js';

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

async function bootstrap(): Promise<void> {
  // Schema mirrors the migrated state (post-mig 046+047) without running
  // the full migration runner — same posture as slice-3 #384.
  await sql`
    CREATE TABLE users (
      id    TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    )
  `;
  await sql`
    CREATE TABLE organizations (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      owner_id               TEXT NOT NULL REFERENCES users(id),
      plan                   TEXT NOT NULL DEFAULT 'free',
      default_server_access  TEXT NOT NULL DEFAULT 'none',
      prompt_capture_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      type                   TEXT,
      parent_org_id          TEXT,
      auth0_org_id           TEXT UNIQUE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE org_members (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member',
      joined_at  TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, user_id)
    )
  `;
  // Mig 047 schema — load-bearing for the BOTH-OR-NEITHER persistence
  // step + UNIQUE catch + FK CASCADE.
  await sql`
    CREATE TABLE org_idp_connections (
      id                    TEXT PRIMARY KEY,
      org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      auth0_connection_id   TEXT NOT NULL UNIQUE,
      entity_id             TEXT NOT NULL,
      strategy              TEXT NOT NULL CHECK (strategy IN ('samlp', 'oidc')),
      display_name          TEXT,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','errored')),
      created_by_user_id    TEXT NOT NULL REFERENCES users(id),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE admin_audit_log (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      actor_id    TEXT NOT NULL,
      target_id   TEXT,
      event_type  TEXT NOT NULL,
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function reset(): Promise<void> {
  await sql`TRUNCATE org_idp_connections, org_members, organizations, users, admin_audit_log CASCADE`;
}

async function insertUser(userId: string, email: string): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
}

async function insertOrg(orgId: string, ownerId: string, auth0OrgId: string | null): Promise<void> {
  await sql`
    INSERT INTO organizations (id, name, owner_id, plan, auth0_org_id)
    VALUES (${orgId}, ${'Test Org'}, ${ownerId}, 'conduit', ${auth0OrgId})
  `;
}

async function countConnections(orgId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM org_idp_connections WHERE org_id = ${orgId}
  `;
  return Number(rows[0]?.count ?? '0');
}

async function countAuditEvents(eventType: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM admin_audit_log WHERE event_type = ${eventType}
  `;
  return Number(rows[0]?.count ?? '0');
}

function makeMockAuth0Client(overrides: Partial<Auth0ManagementClient> = {}): {
  client: Auth0ManagementClient;
  spies: {
    createConnection: ReturnType<typeof vi.fn>;
    enableConnection: ReturnType<typeof vi.fn>;
    deleteConnection: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    createConnection: vi.fn().mockResolvedValue({
      id: 'con_mock_xyz',
      name: 'mock',
      strategy: 'samlp',
    }),
    enableConnection: vi.fn().mockResolvedValue(undefined),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    createConnection: spies.createConnection,
    enableConnection: spies.enableConnection,
    deleteConnection: spies.deleteConnection,
    createOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    ...overrides,
  } as unknown as Auth0ManagementClient;
  return { client, spies };
}

// Minimum viable SAML 2.0 IdP metadata XML — same fixture shape as the
// parser unit test so we know it parses cleanly.
const VALID_METADATA_XML = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/integration-test">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>MIIDXTCCAkWgAwIBAgI</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post" />
  </IDPSSODescriptor>
</EntityDescriptor>`;

async function buildApp(opts: {
  auth0Client: Auth0ManagementClient;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'test-secret-32-bytes-min-blahblahbl' });
  // Stub the requireAdmin / requireAdminMutation gates by attaching a
  // fake auth0User to every request before the route handler reads it.
  // Stub auth0User with the admin email + emailVerified=true so
  // requireAdmin's isAdminSessionUser path returns true. POST requests
  // additionally pass `Authorization: Bearer test-admin-api-key` to
  // skip the CSRF check (CSRF only gates the session-cookie path; the
  // Bearer path is explicitly designed for scripts/CI per the
  // requireAdminMutation docstring).
  app.addHook('preHandler', async (request) => {
    (request as unknown as {
      auth0User: { sub: string; email: string; name: string; emailVerified: boolean };
    }).auth0User = {
      sub: 'user_admin',
      email: 'admin@wyre.test',
      name: 'Admin',
      emailVerified: true,
    };
  });

  const orgService = new OrgService();
  const seatService = new DefaultSeatService(orgService);
  const billingGate = new DefaultBillingGate(orgService, seatService);
  const creditService = new CreditService();
  const adminAuditService = new AdminAuditService();
  const orgIdpConnectionService = new OrgIdpConnectionService();

  await app.register(
    adminOrgRoutes({
      orgService,
      billingGate,
      creditService,
      adminAuditService,
      orgIdpConnectionService,
      auth0ManagementClient: opts.auth0Client,
    }),
  );

  return app;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  sql = postgres(container.getConnectionUri());
  enterTestContext(sql);
  await bootstrap();
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

beforeEach(async () => {
  await reset();
  await insertUser('user_admin', 'admin@wyre.test');
  await insertOrg('org_target', 'user_admin', 'org_auth0_target');
});

describe('SAML wizard BOTH-OR-NEITHER — integration (real Postgres + mocked Auth0)', () => {
  it('happy path: parse + createConnection + enableConnection + DB INSERT + audit_log all fire; redirect with flash_ok', async () => {
    const { client, spies } = makeMockAuth0Client();
    const app = await buildApp({ auth0Client: client });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orgs/org_target/idp-connections',
      headers: { authorization: 'Bearer test-admin-api-key' },
      payload: { metadata: VALID_METADATA_XML, display_name: 'Acme Okta' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_ok');
    expect(spies.createConnection).toHaveBeenCalledOnce();
    expect(spies.enableConnection).toHaveBeenCalledOnce();
    expect(spies.deleteConnection).not.toHaveBeenCalled();

    expect(await countConnections('org_target')).toBe(1);
    expect(await countAuditEvents('idp_connection_created')).toBe(1);

    await app.close();
  });

  it('STEP-1-PARSE-ERROR: invalid XML -> flash_err, no Auth0 calls, no DB writes, no audit', async () => {
    const { client, spies } = makeMockAuth0Client();
    const app = await buildApp({ auth0Client: client });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orgs/org_target/idp-connections',
      headers: { authorization: 'Bearer test-admin-api-key' },
      payload: { metadata: '<not-xml' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_err');
    expect(res.headers.location).toContain('INVALID_XML');
    expect(spies.createConnection).not.toHaveBeenCalled();
    expect(spies.enableConnection).not.toHaveBeenCalled();
    expect(spies.deleteConnection).not.toHaveBeenCalled();
    expect(await countConnections('org_target')).toBe(0);
    expect(await countAuditEvents('idp_connection_created')).toBe(0);

    await app.close();
  });

  it('STEP-2-CREATECONNECTION-FAILURE: throws BEFORE DB writes -> no rollback, no DB writes, no audit', async () => {
    const { client, spies } = makeMockAuth0Client({
      createConnection: vi.fn().mockRejectedValue(new Error('Auth0 503')) as never,
    });
    const app = await buildApp({ auth0Client: client });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orgs/org_target/idp-connections',
      headers: { authorization: 'Bearer test-admin-api-key' },
      payload: { metadata: VALID_METADATA_XML },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_err');
    // No rollback needed — createConnection didn't succeed, no peer to delete.
    expect(spies.deleteConnection).not.toHaveBeenCalled();
    expect(spies.enableConnection).not.toHaveBeenCalled();
    expect(await countConnections('org_target')).toBe(0);
    expect(await countAuditEvents('idp_connection_created')).toBe(0);

    await app.close();
  });

  it('STEP-3-ENABLECONNECTION-FAILURE: rollback deleteConnection fires with the right connection id', async () => {
    const { client, spies } = makeMockAuth0Client({
      enableConnection: vi.fn().mockRejectedValue(new Error('Auth0 500')) as never,
    });
    const app = await buildApp({ auth0Client: client });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orgs/org_target/idp-connections',
      headers: { authorization: 'Bearer test-admin-api-key' },
      payload: { metadata: VALID_METADATA_XML },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_err');
    expect(spies.deleteConnection).toHaveBeenCalledOnce();
    expect(spies.deleteConnection).toHaveBeenCalledWith('con_mock_xyz');
    expect(await countConnections('org_target')).toBe(0);
    expect(await countAuditEvents('idp_connection_created')).toBe(0);

    await app.close();
  });

  it('STEP-4-DB-INSERT-FAILURE: rollback deleteConnection fires for the connection from Step 2', async () => {
    // Force DB INSERT failure by collision on auth0_connection_id UNIQUE
    // constraint — insert a pre-existing row with the SAME id Auth0
    // mock returns.
    await sql`
      INSERT INTO org_idp_connections (id, org_id, auth0_connection_id, entity_id, strategy, created_by_user_id)
      VALUES ('idpc_pre_existing', 'org_target', 'con_mock_xyz', 'https://prior.example.com', 'samlp', 'user_admin')
    `;
    const { client, spies } = makeMockAuth0Client();
    const app = await buildApp({ auth0Client: client });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orgs/org_target/idp-connections',
      headers: { authorization: 'Bearer test-admin-api-key' },
      payload: { metadata: VALID_METADATA_XML },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_err');
    // Rollback fires for the connection from Step 2 (createConnection returned con_mock_xyz).
    expect(spies.deleteConnection).toHaveBeenCalledOnce();
    expect(spies.deleteConnection).toHaveBeenCalledWith('con_mock_xyz');
    // Only the pre-existing row survives; no new INSERT committed.
    expect(await countConnections('org_target')).toBe(1);
    expect(await countAuditEvents('idp_connection_created')).toBe(0);

    await app.close();
  });

  it('ROLLBACK-FAILURE-SWALLOWED: Step 3 fails + rollback ALSO fails -> request still 302 flash_err (no muddling)', async () => {
    // Step 3 throws + the rollback deleteConnection ALSO throws.
    // Per the handler docstring, the rollback-failure is logged + swallowed
    // — the original Step 3 error is the load-bearing signal the admin
    // gets via flash_err. No exception propagates out of the route.
    //
    // ASSERTION SHAPE (boss msg-1781373236320 option B): the 302 +
    // flash_err response shape IS the load-bearing claim — if swallow
    // didn't work, the request would 500 / throw uncaught. Locking the
    // response-shape proves the swallow contract end-to-end without the
    // brittleness of spy-on-rollback-was-attempted (scenario 4 already
    // locks that claim via the non-throwing rollback path).
    const { client } = makeMockAuth0Client({
      enableConnection: vi.fn().mockRejectedValue(new Error('Auth0 500 enable')) as never,
      deleteConnection: vi.fn().mockRejectedValue(new Error('Auth0 500 delete')) as never,
    });
    const app = await buildApp({ auth0Client: client });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/orgs/org_target/idp-connections',
      headers: { authorization: 'Bearer test-admin-api-key' },
      payload: { metadata: VALID_METADATA_XML },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash_err');
    // DB state: no row committed; rollback's persistence-side claim is
    // structural (the route never reached the INSERT), so countConnections
    // is the right substrate-actual assertion.
    expect(await countConnections('org_target')).toBe(0);

    await app.close();
  });
});
