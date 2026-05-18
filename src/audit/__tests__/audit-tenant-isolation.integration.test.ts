/**
 * #78 H3 — audit-log cross-tenant isolation, the real-Postgres guard.
 *
 * The bug: both /api/audit and /api/audit/admin resolved the org for the
 * billing gate and the admin-role check as `orgs[0]` (the caller's first
 * org) while the QUERY ran against `request.query.org_id` — the
 * ?org_id= target. An admin of org A could therefore pass ?org_id=<orgB>
 * and read org B's audit log: role checked in A, rows pulled from B.
 *
 * A route-level test that mocks OrgService cannot catch this — a mock
 * getMembership() returns an admin membership for whatever org it's asked
 * about, so the handler passes regardless of which org it checks. The bug
 * only surfaces when getMembership runs against a REAL org_members table
 * where the caller genuinely has no row for org B. So this guard boots the
 * real auditRoutes + a real OrgService against a real Postgres.
 *
 * Verified fail-on-regression: revert routes.ts to check getMembership /
 * canAccessPaidFeatures against orgs[0] and the cross-tenant test goes red
 * (200 + auditService.query called with org-b); with the fix it is a clean
 * 403 and query is never reached.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AuditService } from '../audit-service.js';
import type { AdminAuditService } from '../admin-audit-service.js';
import type { BillingGate } from '../../billing/gate.js';
import type { Auth0User } from '../../auth/auth0.js';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

let initPools: typeof import('../../db/context.js').initPools;
let closePools: typeof import('../../db/context.js').closePools;
let requestContextPlugin: typeof import('../../db/request-context-plugin.js').requestContextPlugin;
let auditRoutes: typeof import('../routes.js').auditRoutes;
let OrgService: typeof import('../../org/org-service.js').OrgService;

/** Records every org_id the audit query is asked for, so a test can assert
 *  the leak path (query reached with the foreign org) never executes. */
const queriedOrgIds: string[] = [];

function billingGateStub(): BillingGate {
  // Permissive on purpose — billing is not the bug under test. Both methods
  // say "yes" so a leak, if present, is never masked by a billing 402.
  return {
    getUserPlan: async () => 'pro',
    canAccessPaidFeatures: async () => true,
  } as unknown as BillingGate;
}

function auditServiceStub(): AuditService {
  return {
    query: async (params: { orgId: string }) => {
      queriedOrgIds.push(params.orgId);
      return { entries: [], total: 0 };
    },
    exportCsv: async () => '',
  } as unknown as AuditService;
}

function adminAuditServiceStub(): AdminAuditService {
  return {
    query: async (params: { orgId: string }) => {
      queriedOrgIds.push(params.orgId);
      return { entries: [], total: 0 };
    },
    exportCsv: async () => '',
  } as unknown as AdminAuditService;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, user_id)
    )`;

  // user-a is an ADMIN of org-a only. org-b exists with its own owner;
  // user-a has NO org_members row for org-b — the property the leak relies
  // on the handler never actually checking.
  await admin`INSERT INTO users (id, email) VALUES
    ('user-a', 'a@acme.com'), ('user-b', 'b@beta.com')`;
  await admin`INSERT INTO organizations (id, name, owner_id, plan) VALUES
    ('org-a', 'Acme', 'user-a', 'pro'),
    ('org-b', 'Beta', 'user-b', 'pro')`;
  await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-a', 'org-a', 'user-a', 'admin'),
    ('m-b', 'org-b', 'user-b', 'owner')`;

  ({ initPools, closePools } = await import('../../db/context.js'));
  ({ requestContextPlugin } = await import('../../db/request-context-plugin.js'));
  ({ auditRoutes } = await import('../routes.js'));
  ({ OrgService } = await import('../../org/org-service.js'));

  // Single superuser pool for both paths — RLS is not the bug under test;
  // getMembership(org-b, user-a) returns null because no row exists, which
  // is exactly the real-DB property the guard needs.
  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(() => {
  queriedOrgIds.length = 0;
});

const USER_A: Auth0User = { sub: 'user-a', email: 'a@acme.com', name: 'A' } as Auth0User;

/** Fastify app with the request-context plugin + real auditRoutes, with
 *  user-a injected as the authenticated session user. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth0User', null);
  // Set the session user BEFORE requestContextPlugin's onRequest hook reads
  // it (hooks run in registration order).
  app.addHook('onRequest', async (request) => {
    request.auth0User = USER_A;
  });
  await app.register(requestContextPlugin());
  await app.register(
    auditRoutes({
      auditService: auditServiceStub(),
      adminAuditService: adminAuditServiceStub(),
      orgService: new OrgService(),
      billingGate: billingGateStub(),
    }),
  );
  await app.ready();
  return app;
}

describe('#78 H3 — audit-log cross-tenant isolation', () => {
  it('GET /api/audit?org_id=<foreign org> is 403 — query never reaches org-b', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/audit?org_id=org-b' });
      expect(res.statusCode).toBe(403);
      // The leak path: with the bug the handler checks user-a's membership in
      // org-a, passes, then queries org-b. The query must never be reached.
      expect(queriedOrgIds).not.toContain('org-b');
    } finally {
      await app.close();
    }
  });

  it('GET /api/audit/admin?org_id=<foreign org> is 403 — query never reaches org-b', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/audit/admin?org_id=org-b' });
      expect(res.statusCode).toBe(403);
      expect(queriedOrgIds).not.toContain('org-b');
    } finally {
      await app.close();
    }
  });

  it('GET /api/audit?org_id=<own org> still works — query runs against org-a', async () => {
    // Positive control: the fix must not break the legitimate path.
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/audit?org_id=org-a' });
      expect(res.statusCode).toBe(200);
      expect(queriedOrgIds).toContain('org-a');
    } finally {
      await app.close();
    }
  });

  it('GET /api/audit with no org_id defaults to the caller\'s own org', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/audit' });
      expect(res.statusCode).toBe(200);
      expect(queriedOrgIds).toContain('org-a');
    } finally {
      await app.close();
    }
  });
});
