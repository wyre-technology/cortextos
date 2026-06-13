/**
 * BrandResolver — real-Postgres integration tests for RC2 PR-A.
 *
 * Mock-substrate-constraint-silence is the rot vector ruby promoted to N=3
 * (PR #291); this layer guards against the SAME class of silence for the
 * brand_profiles schema:
 *   - mig 045 ADD COLUMN template_overrides JSONB applied against real PG
 *   - mig 045 CHECK constraint (jsonb_typeof = 'object') exercised
 *   - XSS fixture: malicious brand_name lands in DB, flows through
 *     resolveBrand, asserts the ESCAPED form comes out — the end-to-end
 *     escape-boundary contract for dev's PR-B consumers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

let initPools: typeof import('../../db/context.js').initPools;
let closePools: typeof import('../../db/context.js').closePools;
let runAsSystem: typeof import('../../db/context.js').runAsSystem;
let BrandResolver: typeof import('../resolver.js').BrandResolver;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // Bootstrap minimum schema mig 008 references (users + organizations).
  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT REFERENCES users(id),
      parent_org_id TEXT REFERENCES organizations(id),
      plan TEXT NOT NULL DEFAULT 'conduit',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  // Apply mig 008 (brand_profiles base) + mig 045 (template_overrides).
  // Reading from disk catches DDL-syntax problems that hand-typed bootstrap
  // would miss (per the file-on-disk discipline from WYREAI-98 #306).
  //
  // Note on transaction wrappers: mig 008 wraps everything in BEGIN/COMMIT,
  // and postgres.js's .unsafe() rejects BEGIN/COMMIT inside its call.
  // Strip transaction-control statements before applying — the test
  // harness manages transactions at its own scope.
  const stripTx = (sql: string): string =>
    sql.replace(/^\s*BEGIN\s*;\s*$/gm, '').replace(/^\s*COMMIT\s*;\s*$/gm, '');
  const mig008 = stripTx(readFileSync(join(REPO_ROOT, 'migrations/008_brand_profiles.sql'), 'utf8'));
  await admin.unsafe(mig008);
  const mig045 = stripTx(readFileSync(join(REPO_ROOT, 'migrations/045_brand_template_overrides.sql'), 'utf8'));
  await admin.unsafe(mig045);

  ({ initPools, closePools, runAsSystem } = await import('../../db/context.js'));
  ({ BrandResolver } = await import('../resolver.js'));

  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // Clean slate — keep the wyre_default seed row (mig 008 seeds it).
  await admin`DELETE FROM brand_profiles WHERE is_wyre_default = FALSE`;
  await admin`DELETE FROM organizations`;
  await admin`DELETE FROM users`;
  await admin`INSERT INTO users (id, email) VALUES ('u-1', 'u1@acme.test')`;
  await admin`INSERT INTO organizations (id, name, owner_id, plan)
    VALUES ('org-acme', 'Acme', 'u-1', 'conduit')`;
});

describe('mig 045 — template_overrides column + CHECK constraint', () => {
  it('accepts NULL template_overrides (the ~95% default)', async () => {
    await admin`
      INSERT INTO brand_profiles (id, org_id, tier, name)
      VALUES ('b-acme', 'org-acme', 'reseller', 'Acme')
    `;
    const rows = await admin`SELECT template_overrides FROM brand_profiles WHERE id = 'b-acme'`;
    expect(rows[0].template_overrides).toBeNull();
  });

  it('accepts a JSON object for template_overrides', async () => {
    await admin`
      INSERT INTO brand_profiles (id, org_id, tier, name, template_overrides)
      VALUES (
        'b-acme', 'org-acme', 'reseller', 'Acme',
        ${admin.json({ 'trial-converted': 'trial-converted-acme' })}
      )
    `;
    const rows = await admin<{ template_overrides: Record<string, string> | null }[]>`
      SELECT template_overrides FROM brand_profiles WHERE id = 'b-acme'
    `;
    expect(rows[0].template_overrides).toEqual({ 'trial-converted': 'trial-converted-acme' });
  });

  it('REJECTS a JSON array (CHECK enforces jsonb_typeof = object)', async () => {
    await expect(admin`
      INSERT INTO brand_profiles (id, org_id, tier, name, template_overrides)
      VALUES (
        'b-bad', 'org-acme', 'reseller', 'Bad',
        ${admin.json(['not', 'an', 'object'])}
      )
    `).rejects.toThrow(/check constraint|violates check|brand_profiles_template_overrides_is_object/);
  });

  it('REJECTS a JSON scalar string (CHECK enforces jsonb_typeof = object)', async () => {
    await expect(admin`
      INSERT INTO brand_profiles (id, org_id, tier, name, template_overrides)
      VALUES (
        'b-bad', 'org-acme', 'reseller', 'Bad',
        ${admin.json('plain-string')}
      )
    `).rejects.toThrow(/check constraint|violates check|brand_profiles_template_overrides_is_object/);
  });
});

describe('BrandResolver — RC2 PR-A end-to-end against real DB', () => {
  it('round-trips template_overrides through resolveBrand → BrandConfig', async () => {
    const overrides = {
      'trial-converted': 'trial-converted-acme',
      'dunning-past-due': 'dunning-past-due-acme',
    };
    await admin`
      INSERT INTO brand_profiles (id, org_id, tier, name, template_overrides)
      VALUES (
        'b-acme', 'org-acme', 'reseller', 'Acme',
        ${admin.json(overrides)}
      )
    `;

    const resolver = new BrandResolver();
    const config = await runAsSystem(() => resolver.resolveBrand('org-acme'));

    expect(config.templateOverrides).toEqual(overrides);
  });

  it('XSS FIXTURE: malicious brand_name flows through DB → resolveBrand → ESCAPED in returned BrandConfig', async () => {
    // The load-bearing end-to-end test for the escape-at-seam discipline.
    // A reseller-controlled brand_name with HTML/JS injection lands in the
    // DB (DB is content-agnostic; XSS defense lives at the render-boundary
    // not the storage-boundary). resolveBrand must return the ESCAPED form
    // so all 15+ downstream consumers (dev's PR-B fire-sites) inherit the
    // defense by-construction. The escape happens at toBrandConfig per the
    // RC2 PR-A discipline; this test proves the contract at the seam
    // between source (DB) and sink (consumer-visible BrandConfig).
    const maliciousName = '<script>alert("XSS")</script>Evil&Co';
    await admin`
      INSERT INTO brand_profiles (id, org_id, tier, name)
      VALUES ('b-evil', 'org-acme', 'reseller', ${maliciousName})
    `;

    const resolver = new BrandResolver();
    const config = await runAsSystem(() => resolver.resolveBrand('org-acme'));

    // Stored verbatim in DB:
    const rawRow = await admin<{ name: string }[]>`SELECT name FROM brand_profiles WHERE id = 'b-evil'`;
    expect(rawRow[0].name).toBe(maliciousName);

    // Returned ESCAPED from resolveBrand — single defense point for all 15+ consumers:
    expect(config.name).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;Evil&amp;Co');
    expect(config.name).not.toContain('<script>');
    expect(config.name).not.toContain('"XSS"');
  });

  it('XSS FIXTURE: attribute-breakout in logoUrl is escaped (closes href/src injection vector)', async () => {
    const maliciousUrl = 'https://x.test/img.png"><script>alert(1)</script>';
    await admin`
      INSERT INTO brand_profiles (id, org_id, tier, name, logo_url)
      VALUES ('b-evil', 'org-acme', 'reseller', 'Evil', ${maliciousUrl})
    `;

    const resolver = new BrandResolver();
    const config = await runAsSystem(() => resolver.resolveBrand('org-acme'));

    expect(config.logoUrl).toBe('https://x.test/img.png&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(config.logoUrl).not.toContain('"><script>');
  });

  it('brand-inheritance: sub-customer org without own brand inherits reseller brand (escape preserved)', async () => {
    // Reseller has the brand (with a malicious name); customer is a sub-org
    // (parent_org_id = reseller). resolveBrand(customerOrgId) walks parent
    // and returns the reseller's brand — escape still applies at the seam.
    await admin`INSERT INTO users (id, email) VALUES ('u-2', 'u2@acme.test')`;
    await admin`
      INSERT INTO organizations (id, name, owner_id, parent_org_id, plan)
      VALUES ('org-sub', 'SubCust', 'u-2', 'org-acme', 'conduit')
    `;
    const maliciousName = '<img onerror=x()>Acme';
    await admin`
      INSERT INTO brand_profiles (id, org_id, tier, name)
      VALUES ('b-acme', 'org-acme', 'reseller', ${maliciousName})
    `;
    // No own brand for org-sub → walks parent → resolves to org-acme's brand.

    const resolver = new BrandResolver();
    const config = await runAsSystem(() => resolver.resolveBrand('org-sub'));

    expect(config.orgId).toBe('org-acme'); // resolved from parent
    expect(config.name).toBe('&lt;img onerror=x()&gt;Acme'); // escaped end-to-end
  });
});
