/**
 * Track C PR-B surface-5 — reseller-invoice end-to-end integration.
 *
 * Surfaces 1-4 each tested in isolation with FAKE injectables (fake
 * UsageSource, fake BaseRateSource, fake StripeInvoiceClient). Surface-5
 * exercises the REAL composition the unit-fakes hid:
 *   - the real CreditLedgerUsageSource reading SUM(credits_used) from a
 *     real credit_ledger table — the one production code-path never run
 *     end-to-end (surfaces 2-3 stubbed usage)
 *   - the full surface-1→2→3→4 chain in one flow: generateInvoice →
 *     finalizeInvoice → webhook state-transition, proving the seams
 *     compose (column names, types, status enum line up across surfaces)
 *
 * Actor-posture (pre-aligned to the RLS-remediation target-state,
 * memory/2026-05-15-rls-remediation-plan.md):
 *   - generateInvoice / finalizeInvoice run via the superuser `sql`
 *     connection = SYSTEM-path / BYPASSRLS-equivalent. This is the
 *     faithful posture: invoice-generation reads credit_ledger across
 *     ALL subtenant orgs, and a reseller-admin is NOT an org_member of
 *     its subtenants — credit_ledger's FORCE-RLS SELECT policy (mig 017)
 *     would reject a request-path read. Invoice-generation is therefore
 *     a system-path entry point (Walter RLS-remediation spec item 3:
 *     "cron invoice-generation" is system-path). See the FINDING note
 *     below — surface-5 surfacing this is the E2E surface doing its job.
 *   - the webhook handler runs system-path too (BYPASSRLS — reseller_-
 *     invoices is FORCE RLS, no user session behind a Stripe webhook).
 *   - the reseller-admin invoice read-back runs via the non-bypass
 *     rls_test_user with a per-user GUC = the REQUEST-path posture,
 *     retroactively validating mig 027's SELECT policy against a real
 *     generated invoice rather than a hand-seeded fixture row.
 *
 * FINDING (for boss / Walter — surfaced, not silently resolved): the
 * surface-5 plan said generateInvoice/finalizeInvoice would run under
 * rls_test_user (request-path). credit_ledger's mig-017 SELECT policy
 * requires the GUC user to be an org_member of the row's org; a
 * reseller-admin is not a member of its subtenant orgs, so a request-
 * path CreditLedgerUsageSource read structurally cannot satisfy that
 * policy. Invoice-generation must run system-path. This test runs it
 * that way and exercises the request-path posture on the read-back
 * instead. No code change implied — it pins the entry-point class.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ResellerInvoiceService,
  CreditLedgerUsageSource,
  type BaseRateSource,
  type StripeInvoiceClient,
  type MspContactSource,
} from '../../billing/reseller-invoice-service.js';
import {
  handleResellerInvoicePaymentSucceeded,
  handleResellerInvoicePaymentFailed,
} from '../../billing/stripe-webhook.js';
import { ResellerPricingService } from '../../billing/reseller-pricing-service.js';
import type { BillingGate } from '../../billing/gate.js';
import type { OrgService, Organization } from '../../org/org-service.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

// May billing period — [start, end). recorded_at >= start AND < end.
const PERIOD_START = new Date('2026-05-01T00:00:00Z');
const PERIOD_END = new Date('2026-06-01T00:00:00Z');
const JUN_START = new Date('2026-06-01T00:00:00Z');
const JUN_END = new Date('2026-07-01T00:00:00Z');
const JUL_START = new Date('2026-07-01T00:00:00Z');
const JUL_END = new Date('2026-08-01T00:00:00Z');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => undefined });

  await bootstrapSchema();
  await applyMigrations();
  await seedFixtures();
  await provisionTestRole();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  await sql`TRUNCATE reseller_invoices, reseller_pricing_config CASCADE`;
  await sql`TRUNCATE credit_ledger`;
});

async function bootstrapSchema(): Promise<void> {
  await sql`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)`;
  await sql`CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'standalone',
    parent_org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE org_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    UNIQUE (org_id, user_id)
  )`;
  await sql`CREATE TABLE reseller_members (
    id TEXT PRIMARY KEY,
    reseller_org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    UNIQUE (reseller_org_id, user_id)
  )`;
  await sql`CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'pro',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  // credit_ledger — mig 017 shape, reproduced here (mig 017 itself is not
  // applied in this harness). FORCE RLS is retained so the production
  // posture is faithful: the superuser `sql` connection bypasses it,
  // modelling the system-path invoice-generation connection.
  await sql`CREATE TABLE credit_ledger (
    id           BIGSERIAL PRIMARY KEY,
    org_id       TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    vendor_slug  TEXT NOT NULL,
    credits_used INT NOT NULL DEFAULT 1,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE credit_ledger FORCE ROW LEVEL SECURITY`;
  await sql`CREATE POLICY credit_ledger_select ON credit_ledger
    FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM org_members m
         WHERE m.org_id = credit_ledger.org_id
           AND m.user_id = current_setting('conduit.current_user_id', true)
      )
    )`;

  await sql`
    CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
      RETURNS boolean LANGUAGE sql STABLE
    AS $$
      SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = p_user_id)
    $$
  `;
}

async function applyMigrations(): Promise<void> {
  for (const filename of [
    '023_reseller_admin_of_ancestor_helper.sql',
    '025_reseller_pricing_config.sql',
    '026_reseller_pricing_config_dp_e_and_created_by_strip.sql',
    '027_reseller_invoices.sql',
  ]) {
    const raw = readFileSync(join(REPO_ROOT, 'migrations', filename), 'utf8');
    const body = raw.replace(/^\s*BEGIN\s*;\s*$/gim, '').replace(/^\s*COMMIT\s*;\s*$/gim, '');
    await sql.unsafe(body);
  }
}

async function seedFixtures(): Promise<void> {
  await sql`INSERT INTO users (id, email) VALUES ('rita', 'rita@reseller-a.example')`;
  await sql`INSERT INTO organizations (id, name, type) VALUES ('res-a', 'Reseller A', 'reseller')`;
  await sql`INSERT INTO organizations (id, name, type, parent_org_id) VALUES
    ('cust-a', 'Customer A', 'customer', 'res-a'),
    ('cust-b', 'Customer B', 'customer', 'res-a'),
    ('cust-c', 'Customer C', 'customer', 'res-a')`;
  await sql`INSERT INTO reseller_members (id, reseller_org_id, user_id, role)
    VALUES ('rm-rita', 'res-a', 'rita', 'reseller_admin')`;
}

async function provisionTestRole(): Promise<void> {
  await sql.unsafe(`CREATE ROLE rls_test_user`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user`);
  await sql.unsafe(`GRANT SELECT ON reseller_pricing_config_view TO rls_test_user`);
}

/**
 * Request-path posture: a reserved non-bypass connection with the
 * per-user GUC set, mirroring the RLS-remediation request-path. Used
 * here for the reseller-admin invoice read-back only.
 */
interface RlsConnection {
  query: postgres.Sql;
  release: () => Promise<void>;
}

async function asUser(userId: string): Promise<RlsConnection> {
  const reserved = await sql.reserve();
  await reserved.unsafe(`SET ROLE rls_test_user`);
  await reserved`SELECT set_config('conduit.current_user_id', ${userId}, false)`;
  return {
    query: reserved as unknown as postgres.Sql,
    release: async () => {
      try {
        await reserved.unsafe(`RESET ROLE`);
        await reserved`SELECT set_config('conduit.current_user_id', '', false)`;
      } finally {
        reserved.release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedPricing(
  id: string,
  subtenantOrgId: string,
  mode: 'percentage' | 'absolute_per_seat',
  value: number,
): Promise<void> {
  if (mode === 'percentage') {
    await sql`INSERT INTO reseller_pricing_config (
      id, reseller_org_id, subtenant_org_id, mode, rate_basis_points, currency, created_by
    ) VALUES (${id}, 'res-a', ${subtenantOrgId}, 'percentage', ${value}, 'USD', 'rita')`;
  } else {
    await sql`INSERT INTO reseller_pricing_config (
      id, reseller_org_id, subtenant_org_id, mode, amount_cents, currency, created_by
    ) VALUES (${id}, 'res-a', ${subtenantOrgId}, 'absolute_per_seat', ${value}, 'USD', 'rita')`;
  }
}

/** One credit_ledger consumption row. `recordedAt` drives the period-boundary check. */
async function seedUsage(orgId: string, creditsUsed: number, recordedAt: string): Promise<void> {
  await sql`INSERT INTO credit_ledger (org_id, user_id, vendor_slug, credits_used, recorded_at)
    VALUES (${orgId}, 'rita', 'anthropic', ${creditsUsed}, ${recordedAt})`;
}

// ---------------------------------------------------------------------------
// Test doubles — only the boundaries with no production code in PR-B are
// faked. UsageSource is REAL (CreditLedgerUsageSource).
// ---------------------------------------------------------------------------

function makeBillingGate(canAccess: boolean): BillingGate {
  return {
    getUserPlan: vi.fn().mockResolvedValue('pro'),
    getOrgPlan: vi.fn().mockResolvedValue('pro'),
    canAccessPaidFeatures: vi.fn().mockResolvedValue(canAccess),
  } as unknown as BillingGate;
}

function makeOrgService(children: string[]): OrgService {
  const orgs: Organization[] = children.map((id) => ({
    id, name: id, type: 'customer', plan: 'pro',
    stripeCustomerId: null, stripeSubscriptionId: null,
    parentOrgId: 'res-a', ownerId: 'rita',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as Organization));
  return {
    getCustomersOfReseller: vi.fn().mockResolvedValue(orgs),
  } as unknown as OrgService;
}

function makeBaseRateSource(perSubtenantCents: Record<string, number>): BaseRateSource {
  return {
    fetchBaseRatePerUnitCents: vi.fn(async (id: string) => perSubtenantCents[id] ?? 0),
  };
}

function makeMspContactSource(): MspContactSource {
  return {
    fetchMspContact: vi.fn(async () => ({
      email: 'billing@reseller-a.example',
      name: 'Reseller A',
    })),
  };
}

/** Fake Stripe client — real Stripe is unreachable from CI (see (τ) in plan). */
function makeStripeClient() {
  const client: StripeInvoiceClient = {
    ensureCustomer: vi.fn(async () => ({ customerId: 'cus_e2e' })),
    createInvoice: vi.fn(async () => ({ stripeInvoiceId: 'in_e2e' })),
    addInvoiceItem: vi.fn(async () => undefined),
    finalizeInvoice: vi.fn(async () => ({ status: 'open' })),
    retrieveInvoice: vi.fn(async () => ({ status: 'draft' })),
    voidInvoice: vi.fn(async () => undefined),
    deleteDraftInvoice: vi.fn(async () => undefined),
  };
  return client;
}

/** Minimal Fastify-logger stand-in for the webhook handlers. */
function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<
    typeof handleResellerInvoicePaymentSucceeded
  >[2];
}

function makeService(baseRates: Record<string, number>): ResellerInvoiceService {
  return new ResellerInvoiceService(
    sql,
    new ResellerPricingService(sql),
    makeBillingGate(true),
    makeOrgService(['cust-a', 'cust-b']),
    new CreditLedgerUsageSource(sql),
    makeBaseRateSource(baseRates),
    makeStripeClient(),
    makeMspContactSource(),
  );
}

// ===========================================================================
// Period-boundary semantics of the REAL CreditLedgerUsageSource.
//
// CreditLedgerUsageSource sums rows with recorded_at >= start AND < end:
// inclusive lower bound, exclusive upper bound. This is the first
// end-to-end run of that query — surfaces 2-3 stubbed it. Off-by-one in
// the boundary is a textbook risk; pin it explicitly.
// ===========================================================================

describe('surface-5 — CreditLedgerUsageSource period-boundary semantics', () => {
  it('inclusive lower / exclusive upper: counts rows in [start, end) only', async () => {
    const usage = new CreditLedgerUsageSource(sql);

    await seedUsage('cust-c', 13, '2026-04-30T23:59:59Z'); // just-before start → excluded
    await seedUsage('cust-c', 7, '2026-05-01T00:00:00Z');  // exactly AT start  → included
    await seedUsage('cust-c', 5, '2026-05-15T12:00:00Z');  // mid-period        → included
    await seedUsage('cust-c', 11, '2026-06-01T00:00:00Z'); // exactly AT end    → excluded
    await seedUsage('cust-c', 17, '2026-06-01T00:00:01Z'); // just-after end    → excluded

    const total = await usage.fetchUsageUnits('cust-c', PERIOD_START, PERIOD_END);

    // 7 (at start) + 5 (mid) = 12. The at-end row is excluded — that same
    // row IS the next period's at-start row, so exclusive-upper is what
    // prevents a unit being billed in two consecutive periods.
    expect(total).toBe(12);
  });

  it('a row exactly AT period_end belongs to the NEXT period, not this one', async () => {
    const usage = new CreditLedgerUsageSource(sql);
    await seedUsage('cust-c', 100, '2026-06-01T00:00:00Z');

    const may = await usage.fetchUsageUnits('cust-c', PERIOD_START, PERIOD_END);
    const jun = await usage.fetchUsageUnits('cust-c', JUN_START, JUN_END);

    expect(may).toBe(0);   // excluded from May (exclusive upper)
    expect(jun).toBe(100); // included in June (inclusive lower) — billed once
  });

  it('returns 0 (not null) when a subtenant has no usage in the period', async () => {
    const usage = new CreditLedgerUsageSource(sql);
    await seedUsage('cust-c', 50, '2026-04-15T00:00:00Z'); // out of period

    expect(await usage.fetchUsageUnits('cust-c', PERIOD_START, PERIOD_END)).toBe(0);
  });

  it('scopes the SUM to the requested org — does not bleed across subtenants', async () => {
    const usage = new CreditLedgerUsageSource(sql);
    await seedUsage('cust-a', 30, '2026-05-10T00:00:00Z');
    await seedUsage('cust-b', 70, '2026-05-10T00:00:00Z');

    expect(await usage.fetchUsageUnits('cust-a', PERIOD_START, PERIOD_END)).toBe(30);
    expect(await usage.fetchUsageUnits('cust-b', PERIOD_START, PERIOD_END)).toBe(70);
  });
});

// ===========================================================================
// The end-to-end success flow: real usage → generate → finalize → webhook
// payment_succeeded → paid. The one test that runs the whole composition.
// ===========================================================================

describe('surface-5 — end-to-end success flow (real CreditLedgerUsageSource)', () => {
  it('seed usage → generateInvoice → finalizeInvoice → payment_succeeded → paid', async () => {
    // Cross-mode pricing: cust-a percentage (10%), cust-b absolute (+250¢).
    await seedPricing('cfg-a', 'cust-a', 'percentage', 1000);
    await seedPricing('cfg-b', 'cust-b', 'absolute_per_seat', 250);

    // Real credit_ledger rows — multiple per subtenant, all mid-period, so
    // the service's per-subtenant SUM is genuinely exercised.
    await seedUsage('cust-a', 60, '2026-05-05T00:00:00Z');
    await seedUsage('cust-a', 40, '2026-05-20T00:00:00Z'); // cust-a SUM = 100
    await seedUsage('cust-b', 25, '2026-05-08T00:00:00Z');
    await seedUsage('cust-b', 15, '2026-05-22T00:00:00Z'); // cust-b SUM = 40

    const svc = makeService({ 'cust-a': 10, 'cust-b': 20 });

    // --- generate (system-path) -------------------------------------------
    const generated = await svc.generateInvoice({
      id: 'inv-e2e', lineItemIdPrefix: 'li-e2e',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    expect(generated.invoice.status).toBe('draft');
    // cust-a: base 10*100=1000, final round(1000*1.10)=1100, markup 100
    // cust-b: base 20*40=800,  final 800+250=1050,           markup 250
    // wholesale total = SUM(base) = 1000 + 800 = 1800
    expect(generated.invoice.amountCents).toBe(1800);
    expect(generated.lineItems).toHaveLength(2);

    const byTenant = new Map(generated.lineItems.map((li) => [li.subtenantOrgId, li]));
    expect(byTenant.get('cust-a')).toMatchObject({
      baseRateCents: 1000, finalRateCents: 1100, markupAppliedCents: 100,
    });
    expect(byTenant.get('cust-b')).toMatchObject({
      baseRateCents: 800, finalRateCents: 1050, markupAppliedCents: 250,
    });

    // --- finalize (system-path, fake Stripe) ------------------------------
    const finalized = await svc.finalizeInvoice('inv-e2e');
    expect(finalized.status).toBe('open');
    expect(finalized.stripeInvoiceId).toBe('in_e2e');

    // --- webhook: invoice.payment_succeeded (system-path) -----------------
    await handleResellerInvoicePaymentSucceeded('inv-e2e', sql, makeLog());

    // --- terminal state ---------------------------------------------------
    const terminal = await svc.getInvoice('inv-e2e');
    expect(terminal!.status).toBe('paid');
    expect(terminal!.amountCents).toBe(1800);
    expect(terminal!.stripeInvoiceId).toBe('in_e2e');

    // Line items survive the status chain unchanged (write-once).
    const lineItems = await svc.getLineItems('inv-e2e');
    expect(lineItems).toHaveLength(2);
    expect(lineItems.map((li) => li.appliedPricingConfigId).sort()).toEqual(['cfg-a', 'cfg-b']);
  });

  it('request-path posture: a reseller-admin reads back the real invoice under RLS', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 1000);
    await seedPricing('cfg-b', 'cust-b', 'absolute_per_seat', 250);
    await seedUsage('cust-a', 100, '2026-05-05T00:00:00Z');
    await seedUsage('cust-b', 40, '2026-05-08T00:00:00Z');

    const svc = makeService({ 'cust-a': 10, 'cust-b': 20 });
    await svc.generateInvoice({
      id: 'inv-readback', lineItemIdPrefix: 'li-rb',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });
    await svc.finalizeInvoice('inv-readback');
    await handleResellerInvoicePaymentSucceeded('inv-readback', sql, makeLog());

    // rita (reseller_admin of res-a) reads the invoice through mig 027's
    // SELECT policy under the non-bypass role — request-path posture.
    // This retroactively validates the RLS policy against a REAL service-
    // generated row, not a hand-seeded fixture.
    const conn = await asUser('rita');
    try {
      const rows = await conn.query<{ id: string; status: string; amount_cents: number }[]>`
        SELECT id, status, amount_cents FROM reseller_invoices WHERE msp_org_id = 'res-a'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'inv-readback', status: 'paid', amount_cents: 1800 });
    } finally {
      await conn.release();
    }
  });
});

// ===========================================================================
// The end-to-end failure paths: payment_failed → past_due, and void.
// ===========================================================================

describe('surface-5 — end-to-end failure paths', () => {
  it('payment_failed webhook transitions an open invoice to past_due', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 1000);
    await seedUsage('cust-a', 50, '2026-06-10T00:00:00Z');

    const svc = makeService({ 'cust-a': 10 });
    await svc.generateInvoice({
      id: 'inv-fail', lineItemIdPrefix: 'li-fail',
      mspOrgId: 'res-a', periodStart: JUN_START, periodEnd: JUN_END,
    });
    const finalized = await svc.finalizeInvoice('inv-fail');
    expect(finalized.status).toBe('open');

    await handleResellerInvoicePaymentFailed('inv-fail', sql, makeLog());

    const after = await svc.getInvoice('inv-fail');
    expect(after!.status).toBe('past_due');
  });

  it('voidInvoice transitions an open invoice to void; line items preserved', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 1000);
    await seedUsage('cust-a', 50, '2026-07-10T00:00:00Z');

    const svc = makeService({ 'cust-a': 10 });
    await svc.generateInvoice({
      id: 'inv-void', lineItemIdPrefix: 'li-void',
      mspOrgId: 'res-a', periodStart: JUL_START, periodEnd: JUL_END,
    });
    await svc.finalizeInvoice('inv-void');

    const voided = await svc.voidInvoice('inv-void', 'e2e void path');
    expect(voided.status).toBe('void');

    // Voiding is a status transition, not a delete — line-item history stays.
    const lineItems = await svc.getLineItems('inv-void');
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].subtenantOrgId).toBe('cust-a');
  });

  it('payment_succeeded on a past_due invoice recovers it to paid', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 1000);
    await seedUsage('cust-a', 50, '2026-06-10T00:00:00Z');

    const svc = makeService({ 'cust-a': 10 });
    await svc.generateInvoice({
      id: 'inv-recover', lineItemIdPrefix: 'li-rec',
      mspOrgId: 'res-a', periodStart: JUN_START, periodEnd: JUN_END,
    });
    await svc.finalizeInvoice('inv-recover');
    await handleResellerInvoicePaymentFailed('inv-recover', sql, makeLog());
    expect((await svc.getInvoice('inv-recover'))!.status).toBe('past_due');

    // A later successful retry — succeeded handler matches status IN
    // ('open','past_due'), so a recovered payment lands as paid.
    await handleResellerInvoicePaymentSucceeded('inv-recover', sql, makeLog());
    expect((await svc.getInvoice('inv-recover'))!.status).toBe('paid');
  });
});
