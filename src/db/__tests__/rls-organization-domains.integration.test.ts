/**
 * Migration 031 — organization_domains RLS (the NET-NEW security surface).
 *
 * The mcp-gateway organization_domains table has no RLS. conduit runs RLS on
 * the NOBYPASSRLS request path, so migration 031 adds member-scoped policies.
 * This is the regression guard for that surface — it is NOT mocked: it runs
 * the REAL migration 031 against a Postgres container, exercises
 * OrgDomainService on the request-path RLS connection AS each user, and
 * asserts what they actually see:
 *
 *   - a member of the owning org SEES that org's domain rows
 *   - a member of a DIFFERENT org sees ZERO of them (member-scoped RLS holds;
 *     tenant isolation is intact)
 *   - a non-member sees zero
 *   - the CLAIM path still works: findVerifiedByDomain resolves a verified
 *     domain for a user who is NOT a member of the owning org, because that
 *     lookup runs system-path (runAsSystem) by design — member-scoped RLS
 *     would otherwise hide exactly the row the claim flow must find.
 *
 * That last case is the load-bearing interaction: RLS scopes the management
 * surface to members, the claim surface is deliberately outside it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPools, runInRequestContext, closePools } from '../context.js';
import { requestContextPlugin } from '../request-context-plugin.js';
import { OrgDomainService } from '../../org/domain-service.js';
import { OrgService } from '../../org/org-service.js';
import { domainRoutes } from '../../org/domain-routes.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const REQUEST_ROLE = 'conduit_request_test';
const REQUEST_ROLE_PW = 'testpw';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
const domains = new OrgDomainService();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // --- schema: organizations / org_members carry the columns OrgService
  // queries (getOrg SELECT *, getUserOrgs ORDER BY created_at) so the real
  // service runs against this harness in the (B) route test.
  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT, stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, joined_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, user_id)
    )`;

  // conduit_is_member_of_org — migration 018's shared helper. Mig 031's RLS
  // policies call it; define it before applying 031.
  await admin`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, public
    AS $$
      SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = p_user_id);
    $$`;

  // --- apply the REAL migration 031 ----------------------------------------
  const mig031 = readFileSync(
    join(REPO_ROOT, 'migrations', '031_organization_domains.sql'),
    'utf8',
  )
    .replace(/^\s*BEGIN\s*;\s*$/gim, '')
    .replace(/^\s*COMMIT\s*;\s*$/gim, '');
  await admin.begin((tx) => tx.unsafe(mig031));

  // --- organizations RLS — the member-scoped essence of migration 007's
  // organizations_select. The claim-eligibility regression (5-area blocking
  // bug) is precisely this policy hiding an org row from the non-member the
  // endpoint serves; the table must carry it for the (B) route test to be a
  // real guard. Simplified to the org_members EXISTS clause (mig 007 also
  // OR-s a reseller_members clause — not modelled here).
  await admin`ALTER TABLE organizations ENABLE ROW LEVEL SECURITY`;
  await admin`ALTER TABLE organizations FORCE ROW LEVEL SECURITY`;
  await admin`
    CREATE POLICY organizations_select ON organizations
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM org_members m
           WHERE m.org_id = organizations.id
             AND m.user_id = current_setting('conduit.current_user_id', true)
        )
      )`;

  // --- request-path role: NOBYPASSRLS so RLS genuinely enforces ------------
  await admin.unsafe(
    `CREATE ROLE ${REQUEST_ROLE} LOGIN PASSWORD '${REQUEST_ROLE_PW}' NOBYPASSRLS`,
  );
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${REQUEST_ROLE}`);
  await admin.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${REQUEST_ROLE}`,
  );

  // --- seed: org-A owns acme.com (verified); org-B is unrelated ------------
  await admin`INSERT INTO users (id, email) VALUES
    ('alice', 'alice@acme.com'), ('bob', 'bob@other.com'), ('carol', 'carol@acme.com')`;
  await admin`INSERT INTO organizations (id, name) VALUES
    ('org-a', 'Acme'), ('org-b', 'Other Co')`;
  await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-alice', 'org-a', 'alice', 'admin'),
    ('m-bob',   'org-b', 'bob',   'admin')`;
  // A verified domain claim owned by org-A, plus an UNVERIFIED one — the
  // unverified row must stay invisible to the claim path (verified-only).
  await admin`INSERT INTO organization_domains
      (id, org_id, domain, verification_token, verified_at, auto_join_role, created_by)
    VALUES
      ('d-acme',    'org-a', 'acme.com',    'conduit-verify=tok',  NOW(), 'member', 'alice'),
      ('d-pending', 'org-a', 'pending.com', 'conduit-verify=tok2', NULL,  'member', 'alice')`;

  initPools({ systemUrl: superuserUri, requestUrl: requestUri(superuserUri) });
}, 120_000);

afterAll(async () => {
  await closePools();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

function requestUri(superuserUri: string): string {
  const u = new URL(superuserUri);
  u.username = REQUEST_ROLE;
  u.password = REQUEST_ROLE_PW;
  return u.toString();
}

describe('migration 031 — organization_domains RLS', () => {
  it('a member of the owning org sees its domain rows', async () => {
    const rows = await runInRequestContext('alice', () => domains.list('org-a'));
    // org-A owns two rows — the verified acme.com and the unverified pending.com.
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.domain).sort()).toEqual(['acme.com', 'pending.com']);
    expect(rows.every((r) => r.orgId === 'org-a')).toBe(true);
  });

  it('a member of a DIFFERENT org sees zero — member-scoped RLS holds', async () => {
    const rows = await runInRequestContext('bob', () => domains.list('org-a'));
    expect(rows.length).toBe(0);
  });

  it('a non-member sees zero', async () => {
    const rows = await runInRequestContext('carol', () => domains.list('org-a'));
    expect(rows.length).toBe(0);
  });

  it('the claim path resolves a verified domain for a non-member — system-path read', async () => {
    // bob is not a member of org-A. findVerifiedByDomain runs runAsSystem, so
    // the claim flow can still find the verified domain it must match — the
    // member-scoped RLS above does not block the deliberate cross-org read.
    const claim = await runInRequestContext('bob', () =>
      domains.findVerifiedByDomain('acme.com'),
    );
    expect(claim).not.toBeNull();
    expect(claim).toMatchObject({ orgId: 'org-a', domain: 'acme.com' });
  });

  it('the system-path read is tightly keyed — exposes ONLY the matching verified domain', async () => {
    // The runAsSystem path is the riskiest decision in the port. These prove
    // it cannot be leveraged into a broader cross-org leak:
    //  - it is keyed on an exact domain string (no list, no wildcard);
    //  - it returns ONLY verified rows — an unverified claim stays hidden;
    //  - a domain nobody claimed returns nothing.
    // The routes additionally never let a caller pass an arbitrary domain —
    // it is derived server-side from the caller's own verified email.
    const unverified = await runInRequestContext('bob', () =>
      domains.findVerifiedByDomain('pending.com'),
    );
    expect(unverified).toBeNull();

    const unclaimed = await runInRequestContext('bob', () =>
      domains.findVerifiedByDomain('nobody-claimed-this.com'),
    );
    expect(unclaimed).toBeNull();
  });
});

/**
 * (B) ROUTE — the regression guard for the 5-area blocking bug.
 *
 * GET /api/me/claim-eligibility resolves the claiming org via
 * orgService.getOrg(claim.orgId). The caller is a NON-MEMBER by definition,
 * and organizations carries member-scoped RLS — so a request-path getOrg
 * returns null and the endpoint answers eligible:false for everyone it
 * exists to serve. The fix wraps that getOrg in runAsSystem.
 *
 * This boots the REAL domainRoutes behind the request-context plugin and
 * injects the endpoint as carol — carol@acme.com, no membership, matching
 * org-A's verified acme.com claim. It FAILS on the pre-fix code (request-path
 * getOrg → RLS → null → eligible:false) and PASSES with the runAsSystem wrap.
 * A mocked route test cannot catch this — only real RLS can.
 */
let injectedUser: { sub: string; email: string; name: string; emailVerified: boolean } | null =
  null;

async function buildClaimApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth0User', null);
  // Stand in for the auth plugin: populate request.auth0User before the
  // request-context plugin's onRequest hook reads .sub for the RLS user.
  app.addHook('onRequest', async (request) => {
    (request as { auth0User: typeof injectedUser }).auth0User = injectedUser;
  });
  await app.register(requestContextPlugin());
  await app.register(domainRoutes({ orgService: new OrgService(), domainService: new OrgDomainService() }));
  await app.ready();
  return app;
}

describe('(B) route — GET /api/me/claim-eligibility as a non-member', () => {
  it('resolves the claiming org for a non-member — the runAsSystem regression guard', async () => {
    injectedUser = { sub: 'carol', email: 'carol@acme.com', name: 'Carol', emailVerified: true };
    const app = await buildClaimApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me/claim-eligibility' });
      expect(res.statusCode).toBe(200);
      // Pre-fix: organizations RLS hides org-A from non-member carol →
      // getOrg returns null → eligible:false. Post-fix (runAsSystem): resolved.
      expect(res.json()).toMatchObject({
        eligible: true,
        org: { id: 'org-a', name: 'Acme' },
        role: 'member',
        domain: 'acme.com',
      });
    } finally {
      injectedUser = null;
      await app.close();
    }
  });
});
