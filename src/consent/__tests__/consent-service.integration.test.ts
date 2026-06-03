/**
 * ConsentService — real-Postgres integration tests for the SQL-touching
 * methods (WYREAI-98 binding-record + acknowledgment layer).
 *
 * Why this layer exists: ruby's PR #291 catch surfaced that mock-SQL
 * substrates silence schema constraints (NOT NULL, CHECK, UNIQUE, FK
 * cascade). The mock-substrate-constraint-silence pin landed at N=3
 * cross-domain. This test executes the REAL SQL against a real Postgres
 * with mig 040's DDL applied — so the schema-side invariants
 * (consent_type CHECK, document_version 64-char CHECK, FK cascade on
 * org-delete, UNIQUE(user_id, consent_id) ack constraint) are exercised
 * against the production-shape, not the unit-test mock shape.
 *
 * Scope: SQL-correctness only. The cryptographic foundation
 * (fetchDocumentFingerprint) lives in src/consent/consent-service.test.ts
 * since it has no SQL surface.
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
let ConsentService: typeof import('../consent-service.js').ConsentService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // Bootstrap: the minimum schema mig 040 references (users + organizations
  // + signup_intents). Mig 040's ALTER TABLE signup_intents requires the
  // table to exist; signup_intents is created at plugin-init time in the
  // app but here we create the bare minimum so the migration can land.
  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
      plan TEXT NOT NULL DEFAULT 'conduit',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE signup_intents (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      funnel      TEXT NOT NULL DEFAULT 'reseller',
      ip          TEXT,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consumed_at TIMESTAMPTZ
    )`;

  // Apply mig 040 verbatim. The migration is what production runs; testing
  // its exact text against a real Postgres catches DDL-syntax problems that
  // a hand-typed bootstrap would miss (e.g., the cheap-detector contract on
  // BIGINT NOT NULL CHECK — would a hand-typed test get the CHECK shape
  // wrong? Reading from disk eliminates that drift).
  const migPath = join(REPO_ROOT, 'migrations/040_ai_msa_consent.sql');
  const migSql = readFileSync(migPath, 'utf8');
  await admin.unsafe(migSql);

  ({ initPools, closePools, runAsSystem } = await import('../../db/context.js'));
  ({ ConsentService } = await import('../consent-service.js'));

  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // Clean slate per test — order matters for FK cascade integrity.
  await admin`DELETE FROM user_consent_acknowledgments`;
  await admin`DELETE FROM org_consents`;
  await admin`DELETE FROM organizations`;
  await admin`DELETE FROM users`;
  await admin`INSERT INTO users (id, email) VALUES ('user-owner', 'owner@acme.test')`;
  await admin`INSERT INTO users (id, email) VALUES ('user-admin', 'admin@acme.test')`;
  await admin`INSERT INTO organizations (id, name, owner_id, plan)
    VALUES ('org-acme', 'Acme', 'user-owner', 'conduit')`;
});

const VALID_SHA = 'a'.repeat(64);
const ANOTHER_SHA = 'b'.repeat(64);

describe('ConsentService — recordOrgConsent (binding record)', () => {
  it('inserts a row + returns the OrgConsentRow shape with all fields populated', async () => {
    const svc = new ConsentService();
    const row = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 12345,
      acceptedByUserId: 'user-owner',
      acceptedIp: '1.2.3.4',
      userAgent: 'TestAgent/1.0',
    }));

    expect(row.id).toMatch(/^[A-Za-z0-9_-]+$/); // nanoid
    expect(row.orgId).toBe('org-acme');
    expect(row.consentType).toBe('ai_msa');
    expect(row.documentVersion).toBe(VALID_SHA);
    expect(row.documentSizeBytes).toBe(12345);
    expect(row.acceptedByUserId).toBe('user-owner');
    expect(row.acceptedIp).toBe('1.2.3.4');
    expect(row.userAgent).toBe('TestAgent/1.0');
    expect(row.acceptedAt).toBeTruthy();
  });

  it('re-accept INSERTS a new row preserving history (newest-row-authoritative semantics)', async () => {
    const svc = new ConsentService();
    const first = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 100,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }));
    // Tiny sleep so accepted_at differs deterministically (postgres NOW()
    // can return identical values within the same statement; pg_sleep
    // forces a fresh now()).
    await admin`SELECT pg_sleep(0.05)`;
    const second = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: ANOTHER_SHA,
      documentSizeBytes: 200,
      acceptedByUserId: 'user-admin',
      acceptedIp: null,
      userAgent: null,
    }));

    expect(second.id).not.toBe(first.id);
    const rows = await admin`SELECT id FROM org_consents WHERE org_id = 'org-acme' ORDER BY accepted_at ASC`;
    expect(rows).toHaveLength(2);
    const current = await runAsSystem(() => svc.getCurrentOrgConsent('org-acme', 'ai_msa'));
    expect(current?.id).toBe(second.id); // newest wins
    expect(current?.documentVersion).toBe(ANOTHER_SHA);
  });

  it('REJECTS invalid SHA256 length (CHECK constraint on document_version)', async () => {
    const svc = new ConsentService();
    await expect(runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: 'too-short',
      documentSizeBytes: 1,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }))).rejects.toThrow(/check constraint|violates check/);
  });

  it('REJECTS negative document_size_bytes (CHECK constraint on cheap-detector)', async () => {
    const svc = new ConsentService();
    await expect(runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: -1,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }))).rejects.toThrow(/check constraint|violates check/);
  });

  it('REJECTS unknown consent_type (CHECK constraint on enum-style discriminator)', async () => {
    const svc = new ConsentService();
    await expect(runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      // @ts-expect-error — testing schema constraint with a forced bad value
      consentType: 'not_a_real_type',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 1,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }))).rejects.toThrow(/check constraint|violates check/);
  });

  it('FK CASCADE: deleting the org removes its org_consents rows', async () => {
    const svc = new ConsentService();
    await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 1,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }));
    const before = await admin`SELECT COUNT(*)::int AS n FROM org_consents WHERE org_id = 'org-acme'`;
    expect(before[0].n).toBe(1);
    await admin`DELETE FROM organizations WHERE id = 'org-acme'`;
    const after = await admin`SELECT COUNT(*)::int AS n FROM org_consents WHERE org_id = 'org-acme'`;
    expect(after[0].n).toBe(0);
  });

  it('SET NULL: deleting the signatory user preserves the consent row with NULL accepted_by_user_id', async () => {
    // Important: deleting the user shouldn't destroy the legal record;
    // the audit-trail in admin_audit_log preserves who-signed-when
    // independently, but the consent row itself stays so the org's
    // binding-record is intact even if the original signatory is gone.
    // The SET NULL behavior matches the mig 040 DDL.
    const svc = new ConsentService();
    const row = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 1,
      acceptedByUserId: 'user-admin',
      acceptedIp: null,
      userAgent: null,
    }));
    await admin`DELETE FROM users WHERE id = 'user-admin'`;
    const after = await admin`SELECT accepted_by_user_id FROM org_consents WHERE id = ${row.id}`;
    expect(after).toHaveLength(1);
    expect(after[0].accepted_by_user_id).toBeNull();
  });
});

describe('ConsentService — getCurrentOrgConsent', () => {
  it('returns null when no consent exists for the org', async () => {
    const svc = new ConsentService();
    const current = await runAsSystem(() => svc.getCurrentOrgConsent('org-acme', 'ai_msa'));
    expect(current).toBeNull();
  });
});

describe('ConsentService — recordUserAcknowledgment (informational layer)', () => {
  it('inserts an acknowledgment + returns true on first insert', async () => {
    const svc = new ConsentService();
    const consent = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 1,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }));
    const inserted = await runAsSystem(() => svc.recordUserAcknowledgment({
      userId: 'user-admin',
      orgId: 'org-acme',
      consentId: consent.id,
      acknowledgedIp: '5.6.7.8',
      userAgent: 'AckAgent/1.0',
    }));
    expect(inserted).toBe(true);
  });

  it('UNIQUE on (user_id, consent_id) — second call returns false (no-op via ON CONFLICT)', async () => {
    const svc = new ConsentService();
    const consent = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme',
      consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf',
      documentVersion: VALID_SHA,
      documentSizeBytes: 1,
      acceptedByUserId: 'user-owner',
      acceptedIp: null,
      userAgent: null,
    }));
    const first = await runAsSystem(() => svc.recordUserAcknowledgment({
      userId: 'user-admin', orgId: 'org-acme', consentId: consent.id,
      acknowledgedIp: null, userAgent: null,
    }));
    const second = await runAsSystem(() => svc.recordUserAcknowledgment({
      userId: 'user-admin', orgId: 'org-acme', consentId: consent.id,
      acknowledgedIp: null, userAgent: null,
    }));
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await admin`SELECT COUNT(*)::int AS n FROM user_consent_acknowledgments WHERE user_id = 'user-admin' AND consent_id = ${consent.id}`;
    expect(rows[0].n).toBe(1);
  });

  it('FK CASCADE: deleting the binding consent removes acknowledgments', async () => {
    const svc = new ConsentService();
    const consent = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme', consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf', documentVersion: VALID_SHA,
      documentSizeBytes: 1, acceptedByUserId: 'user-owner',
      acceptedIp: null, userAgent: null,
    }));
    await runAsSystem(() => svc.recordUserAcknowledgment({
      userId: 'user-admin', orgId: 'org-acme', consentId: consent.id,
      acknowledgedIp: null, userAgent: null,
    }));
    await admin`DELETE FROM org_consents WHERE id = ${consent.id}`;
    const rows = await admin`SELECT COUNT(*)::int AS n FROM user_consent_acknowledgments WHERE user_id = 'user-admin'`;
    expect(rows[0].n).toBe(0);
  });
});

describe('ConsentService — userHasAcknowledgedCurrent', () => {
  it('false when no current binding consent exists', async () => {
    const svc = new ConsentService();
    expect(await runAsSystem(() => svc.userHasAcknowledgedCurrent('user-admin', 'org-acme', 'ai_msa'))).toBe(false);
  });

  it('false after binding but before acknowledgment', async () => {
    const svc = new ConsentService();
    await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme', consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf', documentVersion: VALID_SHA,
      documentSizeBytes: 1, acceptedByUserId: 'user-owner',
      acceptedIp: null, userAgent: null,
    }));
    expect(await runAsSystem(() => svc.userHasAcknowledgedCurrent('user-admin', 'org-acme', 'ai_msa'))).toBe(false);
  });

  it('true after acknowledgment of the current binding', async () => {
    const svc = new ConsentService();
    const consent = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme', consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf', documentVersion: VALID_SHA,
      documentSizeBytes: 1, acceptedByUserId: 'user-owner',
      acceptedIp: null, userAgent: null,
    }));
    await runAsSystem(() => svc.recordUserAcknowledgment({
      userId: 'user-admin', orgId: 'org-acme', consentId: consent.id,
      acknowledgedIp: null, userAgent: null,
    }));
    expect(await runAsSystem(() => svc.userHasAcknowledgedCurrent('user-admin', 'org-acme', 'ai_msa'))).toBe(true);
  });

  it('false again after re-accept lands a NEW binding the user has not yet acknowledged', async () => {
    // Material-change re-accept lands a new org_consents row. The OLD
    // acknowledgment FK'd to the OLD consent_id is no longer "current."
    // userHasAcknowledgedCurrent should return false until the user
    // acknowledges the NEW binding. Closes the rot-vector "user
    // acknowledged v1, MSA updated to v2, user still gates as
    // acknowledged" — the per-binding acknowledgment is the construction-
    // side fix for that.
    const svc = new ConsentService();
    const v1 = await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme', consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf', documentVersion: VALID_SHA,
      documentSizeBytes: 1, acceptedByUserId: 'user-owner',
      acceptedIp: null, userAgent: null,
    }));
    await runAsSystem(() => svc.recordUserAcknowledgment({
      userId: 'user-admin', orgId: 'org-acme', consentId: v1.id,
      acknowledgedIp: null, userAgent: null,
    }));
    expect(await runAsSystem(() => svc.userHasAcknowledgedCurrent('user-admin', 'org-acme', 'ai_msa'))).toBe(true);

    await admin`SELECT pg_sleep(0.05)`;
    await runAsSystem(() => svc.recordOrgConsent({
      orgId: 'org-acme', consentType: 'ai_msa',
      documentUrl: 'https://docs.example/msa.pdf', documentVersion: ANOTHER_SHA,
      documentSizeBytes: 200, acceptedByUserId: 'user-owner',
      acceptedIp: null, userAgent: null,
    }));
    expect(await runAsSystem(() => svc.userHasAcknowledgedCurrent('user-admin', 'org-acme', 'ai_msa'))).toBe(false);
  });
});
