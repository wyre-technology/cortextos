/**
 * ResellerInvoiceService.generateInvoice end-to-end (surface-2 integration).
 *
 * Exercises: DP-K gate, fail-fast on missing pricing-config (no partial
 * invoice), DP-J skip-zero-usage, single-rounding-point arithmetic,
 * cross-mode-in-single-invoice (Walter test-addition), UNIQUE
 * constraint on (msp_org_id, period_start), transaction atomicity on
 * the header → line-items → header-amount sequence.
 *
 * Wholesale model (Aaron 2026-05-15): header.amount_cents =
 * SUM(base_rate_cents); markup_applied + final stored on line items as
 * MSP-reference.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ResellerInvoiceService,
  type UsageSource,
  type BaseRateSource,
  type StripeInvoiceClient,
  type MspContactSource,
} from '../../billing/reseller-invoice-service.js';
import { ResellerPricingService } from '../../billing/reseller-pricing-service.js';
import type { BillingGate } from '../../billing/gate.js';
import type { OrgService, Organization } from '../../org/org-service.js';
import { enterTestContext } from '../../db/context.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

let container: StartedPostgreSqlContainer;
let sql: postgres.Sql;

const PERIOD_START = new Date('2026-05-01T00:00:00Z');
const PERIOD_END = new Date('2026-06-01T00:00:00Z');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => undefined });

  await bootstrapSchema();
  await applyMigrations();
  await seedFixtures();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // CASCADE on both: reseller_invoice_line_items has FKs to both.
  await sql`TRUNCATE reseller_invoices, reseller_pricing_config CASCADE`;
  // Services built in tests resolve getSql() to this testcontainer connection.
  enterTestContext(sql);
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

// ---------------------------------------------------------------------------
// Test fakes
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
    id,
    name: id,
    type: 'customer',
    plan: 'pro',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    parentOrgId: 'res-a',
    ownerId: 'rita',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as Organization));
  return {
    getCustomersOfReseller: vi.fn().mockResolvedValue(orgs),
  } as unknown as OrgService;
}

function makeUsageSource(perSubtenant: Record<string, number>): UsageSource {
  return {
    fetchUsageUnits: vi.fn(async (subtenantOrgId: string) => perSubtenant[subtenantOrgId] ?? 0),
  };
}

function makeBaseRateSource(perSubtenantCents: Record<string, number>): BaseRateSource {
  return {
    fetchBaseRatePerUnitCents: vi.fn(async (subtenantOrgId: string) => perSubtenantCents[subtenantOrgId] ?? 0),
  };
}

// As superuser — pricing-config is seeded directly to bypass RLS for fixture setup.
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

/**
 * Scriptable fake Stripe client. The returned `behavior` object is
 * MUTABLE — a test can flip `behavior.failAt` between calls to produce
 * an orphan state through the real write-path, then recover it on a
 * second call. `behavior.remoteStatus` drives retrieveInvoice so the
 * recovery branch's status-switch can be exercised.
 */
function makeStripeClient(initial: {
  failAt?: 'ensureCustomer' | 'createInvoice' | 'addInvoiceItem' | 'finalizeInvoice';
  retrieveReturnsNull?: boolean;
  remoteStatus?: string;
} = {}) {
  const behavior = { ...initial };
  const calls = {
    ensureCustomer: 0,
    createInvoice: 0,
    addInvoiceItem: 0,
    finalizeInvoice: 0,
    retrieveInvoice: 0,
    voidInvoice: 0,
    deleteDraftInvoice: 0,
  };
  const client: StripeInvoiceClient = {
    ensureCustomer: vi.fn(async () => {
      calls.ensureCustomer++;
      if (behavior.failAt === 'ensureCustomer') throw new Error('stripe ensureCustomer failed');
      return { customerId: 'cus_fake' };
    }),
    createInvoice: vi.fn(async () => {
      calls.createInvoice++;
      if (behavior.failAt === 'createInvoice') throw new Error('stripe createInvoice failed');
      return { stripeInvoiceId: 'in_fake' };
    }),
    addInvoiceItem: vi.fn(async () => {
      calls.addInvoiceItem++;
      if (behavior.failAt === 'addInvoiceItem') throw new Error('stripe addInvoiceItem failed');
    }),
    finalizeInvoice: vi.fn(async () => {
      calls.finalizeInvoice++;
      if (behavior.failAt === 'finalizeInvoice') throw new Error('stripe finalizeInvoice failed');
      return { status: 'open' };
    }),
    retrieveInvoice: vi.fn(async () => {
      calls.retrieveInvoice++;
      if (behavior.retrieveReturnsNull) return null;
      return { status: behavior.remoteStatus ?? 'draft' };
    }),
    voidInvoice: vi.fn(async () => { calls.voidInvoice++; }),
    deleteDraftInvoice: vi.fn(async () => { calls.deleteDraftInvoice++; }),
  };
  return { client, calls, behavior };
}

function makeMspContactSource(contact: { email: string; name: string } | null = {
  email: 'billing@reseller-a.example',
  name: 'Reseller A',
}): MspContactSource {
  return { fetchMspContact: vi.fn(async () => contact) };
}

function makeService(opts: {
  canAccess?: boolean;
  children: string[];
  usage?: Record<string, number>;
  baseRates?: Record<string, number>;
  stripe?: ReturnType<typeof makeStripeClient>;
  mspContact?: { email: string; name: string } | null;
}): ResellerInvoiceService {
  const stripe = opts.stripe ?? makeStripeClient();
  return new ResellerInvoiceService(
    new ResellerPricingService(),
    makeBillingGate(opts.canAccess ?? true),
    makeOrgService(opts.children),
    makeUsageSource(opts.usage ?? {}),
    makeBaseRateSource(opts.baseRates ?? {}),
    stripe.client,
    makeMspContactSource(opts.mspContact === undefined ? undefined : opts.mspContact),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResellerInvoiceService.generateInvoice — DP-K gate', () => {
  it('throws NOT_ELIGIBLE when MSP is not on a Pro plan', async () => {
    const svc = makeService({ canAccess: false, children: ['cust-a'] });
    await expect(
      svc.generateInvoice({
        id: 'inv-1', lineItemIdPrefix: 'li-1',
        mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
      }),
    ).rejects.toMatchObject({
      name: 'ResellerInvoiceError',
      code: 'NOT_ELIGIBLE',
    });

    // No invoice written.
    const [{ count }] = await sql<{ count: number }[]>`SELECT COUNT(*)::INT AS count FROM reseller_invoices`;
    expect(count).toBe(0);
  });
});

describe('ResellerInvoiceService.generateInvoice — fail-fast pricing-config-missing', () => {
  it('throws PRICING_NOT_CONFIGURED when ANY subtenant lacks pricing (no partial invoice)', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    // cust-b deliberately has NO pricing-config.

    const svc = makeService({
      children: ['cust-a', 'cust-b'],
      usage: { 'cust-a': 100, 'cust-b': 50 },
      baseRates: { 'cust-a': 10, 'cust-b': 10 },
    });

    await expect(
      svc.generateInvoice({
        id: 'inv-partial', lineItemIdPrefix: 'li-partial',
        mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
      }),
    ).rejects.toMatchObject({
      name: 'ResellerInvoiceError',
      code: 'PRICING_NOT_CONFIGURED',
      meta: expect.objectContaining({ subtenantOrgId: 'cust-b' }),
    });

    // Structurally impossible to have written anything — validation before BEGIN.
    const [{ count }] = await sql<{ count: number }[]>`SELECT COUNT(*)::INT AS count FROM reseller_invoices`;
    expect(count).toBe(0);
  });
});

describe('ResellerInvoiceService.generateInvoice — DP-J skip-zero-usage', () => {
  it('skips subtenants with zero usage; produces no line item for them', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    await seedPricing('cfg-b', 'cust-b', 'percentage', 500);
    // cust-b has zero usage; cust-a has 100 units.

    const svc = makeService({
      children: ['cust-a', 'cust-b'],
      usage: { 'cust-a': 100, 'cust-b': 0 },
      baseRates: { 'cust-a': 10, 'cust-b': 10 },
    });

    const { invoice, lineItems } = await svc.generateInvoice({
      id: 'inv-skip', lineItemIdPrefix: 'li-skip',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].subtenantOrgId).toBe('cust-a');
    expect(invoice.amountCents).toBe(1000); // base = 10 * 100
  });

  it('produces zero line items and zero amount when ALL subtenants have zero usage', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);

    const svc = makeService({
      children: ['cust-a'],
      usage: { 'cust-a': 0 },
      baseRates: { 'cust-a': 10 },
    });

    const { invoice, lineItems } = await svc.generateInvoice({
      id: 'inv-empty', lineItemIdPrefix: 'li-empty',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    expect(lineItems).toHaveLength(0);
    expect(invoice.amountCents).toBe(0);
    expect(invoice.status).toBe('draft');
  });
});

describe('ResellerInvoiceService.generateInvoice — wholesale total + arithmetic', () => {
  it('header.amount_cents = SUM(base_rate_cents), NOT SUM(final_rate_cents) — wholesale model', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500); // 5%

    const svc = makeService({
      children: ['cust-a'],
      usage: { 'cust-a': 100 },
      baseRates: { 'cust-a': 10 },
    });

    const { invoice, lineItems } = await svc.generateInvoice({
      id: 'inv-wholesale', lineItemIdPrefix: 'li-w',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    // base = 10 * 100 = 1000; final = round(1000 * 1.05) = 1050; markup = 50
    expect(lineItems[0].baseRateCents).toBe(1000);
    expect(lineItems[0].finalRateCents).toBe(1050);
    expect(lineItems[0].markupAppliedCents).toBe(50);
    expect(invoice.amountCents).toBe(1000); // wholesale = base only
  });

  it('writes applied_pricing_config_id pointer on each line item (audit-trail)', async () => {
    await seedPricing('cfg-trace', 'cust-a', 'percentage', 500);

    const svc = makeService({
      children: ['cust-a'],
      usage: { 'cust-a': 100 },
      baseRates: { 'cust-a': 10 },
    });

    const { lineItems } = await svc.generateInvoice({
      id: 'inv-trace', lineItemIdPrefix: 'li-trace',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    expect(lineItems[0].appliedPricingConfigId).toBe('cfg-trace');
  });
});

describe('ResellerInvoiceService.generateInvoice — cross-mode in single invoice (Walter test-addition)', () => {
  it('handles mixed percentage + absolute_per_seat subtenants in one invoice', async () => {
    await seedPricing('cfg-pct', 'cust-a', 'percentage', 1000);     // 10%
    await seedPricing('cfg-abs', 'cust-b', 'absolute_per_seat', 200); // +$2.00 / unit basis

    const svc = makeService({
      children: ['cust-a', 'cust-b'],
      usage: { 'cust-a': 50, 'cust-b': 50 },
      baseRates: { 'cust-a': 20, 'cust-b': 20 },
    });

    const { invoice, lineItems } = await svc.generateInvoice({
      id: 'inv-mixed', lineItemIdPrefix: 'li-mix',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    expect(lineItems).toHaveLength(2);

    const byTenant = new Map(lineItems.map((li) => [li.subtenantOrgId, li]));
    const pctLi = byTenant.get('cust-a')!;
    const absLi = byTenant.get('cust-b')!;

    // cust-a: base = 20 * 50 = 1000; final = round(1000 * 1.10) = 1100; markup = 100
    expect(pctLi.baseRateCents).toBe(1000);
    expect(pctLi.finalRateCents).toBe(1100);
    expect(pctLi.markupAppliedCents).toBe(100);

    // cust-b: base = 20 * 50 = 1000; final = 1000 + 200 = 1200; markup = 200
    expect(absLi.baseRateCents).toBe(1000);
    expect(absLi.finalRateCents).toBe(1200);
    expect(absLi.markupAppliedCents).toBe(200);

    // Wholesale total = base-sum across both modes
    expect(invoice.amountCents).toBe(2000);
  });
});

describe('ResellerInvoiceService.generateInvoice — UNIQUE idempotency', () => {
  it('rejects a second invoice for the same (msp, period_start) — UNIQUE constraint', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);

    const svc = makeService({
      children: ['cust-a'],
      usage: { 'cust-a': 100 },
      baseRates: { 'cust-a': 10 },
    });

    await svc.generateInvoice({
      id: 'inv-uniq-1', lineItemIdPrefix: 'li-u1',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    await expect(
      svc.generateInvoice({
        id: 'inv-uniq-2', lineItemIdPrefix: 'li-u2',
        mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
      }),
    ).rejects.toThrow(/reseller_invoices_msp_period_unique/);

    // Only the first invoice exists.
    const [{ count }] = await sql<{ count: number }[]>`SELECT COUNT(*)::INT AS count FROM reseller_invoices`;
    expect(count).toBe(1);
  });
});

describe('ResellerInvoiceService — period validation', () => {
  it('throws INVALID_PERIOD when periodEnd <= periodStart', async () => {
    const svc = makeService({ children: ['cust-a'] });
    await expect(
      svc.generateInvoice({
        id: 'inv-bad-per', lineItemIdPrefix: 'li-bp',
        mspOrgId: 'res-a', periodStart: PERIOD_END, periodEnd: PERIOD_START,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PERIOD' });
  });
});

describe('ResellerInvoiceService — read paths', () => {
  it('getInvoice returns the persisted row; null when missing', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const svc = makeService({
      children: ['cust-a'],
      usage: { 'cust-a': 100 },
      baseRates: { 'cust-a': 10 },
    });

    await svc.generateInvoice({
      id: 'inv-read', lineItemIdPrefix: 'li-r',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    const got = await svc.getInvoice('inv-read');
    expect(got).not.toBeNull();
    expect(got!.id).toBe('inv-read');

    const missing = await svc.getInvoice('does-not-exist');
    expect(missing).toBeNull();
  });

  it('listInvoicesForMsp returns invoices ordered by period_start DESC', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const svc = makeService({
      children: ['cust-a'],
      usage: { 'cust-a': 100 },
      baseRates: { 'cust-a': 10 },
    });

    await svc.generateInvoice({
      id: 'inv-may', lineItemIdPrefix: 'li-may',
      mspOrgId: 'res-a',
      periodStart: new Date('2026-05-01T00:00:00Z'),
      periodEnd: new Date('2026-06-01T00:00:00Z'),
    });
    await svc.generateInvoice({
      id: 'inv-jun', lineItemIdPrefix: 'li-jun',
      mspOrgId: 'res-a',
      periodStart: new Date('2026-06-01T00:00:00Z'),
      periodEnd: new Date('2026-07-01T00:00:00Z'),
    });

    const list = await svc.listInvoicesForMsp('res-a');
    expect(list.map((i) => i.id)).toEqual(['inv-jun', 'inv-may']);
  });

  it('getLineItems returns line items for the given invoice', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    await seedPricing('cfg-b', 'cust-b', 'percentage', 1000);
    const svc = makeService({
      children: ['cust-a', 'cust-b'],
      usage: { 'cust-a': 100, 'cust-b': 50 },
      baseRates: { 'cust-a': 10, 'cust-b': 20 },
    });

    await svc.generateInvoice({
      id: 'inv-li', lineItemIdPrefix: 'li-grp',
      mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
    });

    const items = await svc.getLineItems('inv-li');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.subtenantOrgId).sort()).toEqual(['cust-a', 'cust-b']);
  });
});

// ---------------------------------------------------------------------------
// Surface-3 — finalizeInvoice (Stripe integration)
// ---------------------------------------------------------------------------

/** Generate a draft invoice and return its id, for finalize/void tests. */
async function seedDraftInvoice(svc: ResellerInvoiceService, id: string): Promise<void> {
  await svc.generateInvoice({
    id, lineItemIdPrefix: `${id}-li`,
    mspOrgId: 'res-a', periodStart: PERIOD_START, periodEnd: PERIOD_END,
  });
}

describe('ResellerInvoiceService.finalizeInvoice — happy path', () => {
  it('finalizes a draft: ensure→create→add-items→finalize, transitions draft→open', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient();
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-fin-1');

    const result = await svc.finalizeInvoice('inv-fin-1');

    expect(result.status).toBe('open');
    expect(result.stripeInvoiceId).toBe('in_fake');
    expect(stripe.calls.ensureCustomer).toBe(1);
    expect(stripe.calls.createInvoice).toBe(1);
    expect(stripe.calls.addInvoiceItem).toBe(1); // one line item
    expect(stripe.calls.finalizeInvoice).toBe(1);
  });

  it('is an idempotent no-op when the invoice is already open', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient();
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-fin-idem');
    await svc.finalizeInvoice('inv-fin-idem');

    const stripeCallsAfterFirst = { ...stripe.calls };
    const second = await svc.finalizeInvoice('inv-fin-idem');

    expect(second.status).toBe('open');
    // No additional Stripe calls on the second finalize.
    expect(stripe.calls).toEqual(stripeCallsAfterFirst);
  });

  it('throws INVALID_STATE when finalizing a non-existent invoice', async () => {
    const svc = makeService({ children: [] });
    await expect(svc.finalizeInvoice('does-not-exist')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('throws MSP_MISSING_EMAIL when the MSP has no billing contact', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 },
      mspContact: null,
    });
    await seedDraftInvoice(svc, 'inv-fin-noemail');
    await expect(svc.finalizeInvoice('inv-fin-noemail')).rejects.toMatchObject({
      code: 'MSP_MISSING_EMAIL',
    });
  });
});

describe('ResellerInvoiceService.finalizeInvoice — Stripe-failure leaves recoverable state', () => {
  it('outbox marker is written before failure: createInvoice ok → finalize throws → row keeps stripe_invoice_id, status draft', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient({ failAt: 'finalizeInvoice' });
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-fin-orphan');

    await expect(svc.finalizeInvoice('inv-fin-orphan')).rejects.toMatchObject({
      code: 'STRIPE_API_ERROR',
    });

    // No rollback-delete — the outbox marker makes this recoverable.
    expect(stripe.calls.deleteDraftInvoice).toBe(0);
    // The row carries the outbox marker: stripe_invoice_id SET, status DRAFT.
    // This is the production-reachable orphan state the recovery branch needs.
    const row = await svc.getInvoice('inv-fin-orphan');
    expect(row!.status).toBe('draft');
    expect(row!.stripeInvoiceId).toBe('in_fake');
  });

  it('failure before createInvoice leaves no marker: stripe_invoice_id stays NULL', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient({ failAt: 'ensureCustomer' });
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-fin-earlyfail');

    await expect(svc.finalizeInvoice('inv-fin-earlyfail')).rejects.toMatchObject({
      code: 'STRIPE_API_ERROR',
    });
    expect(stripe.calls.createInvoice).toBe(0);
    const row = await svc.getInvoice('inv-fin-earlyfail');
    expect(row!.status).toBe('draft');
    expect(row!.stripeInvoiceId).toBeNull();
  });
});

describe('ResellerInvoiceService.finalizeInvoice — orphan-recovery via real write-path', () => {
  // These tests produce the orphan state through the ACTUAL production
  // write-path (a scripted Stripe failure after the outbox marker is
  // written), NOT via direct DB injection. The earlier shape injected
  // stripe_invoice_id by raw UPDATE — a path production lacks — so it
  // verified a synthetic state (Walter AREA 5 / test-precondition-
  // reachability). The marker-write is now mid-flight, so the orphan is
  // production-reachable.

  it('recovers a draft-orphan: first finalize fails post-marker, second finalize resumes + completes', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient({ failAt: 'finalizeInvoice' });
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-orphan');

    // Attempt 1: real write-path fails at finalize → orphan marker written.
    await expect(svc.finalizeInvoice('inv-orphan')).rejects.toMatchObject({
      code: 'STRIPE_API_ERROR',
    });
    const orphan = await svc.getInvoice('inv-orphan');
    expect(orphan!.status).toBe('draft');
    expect(orphan!.stripeInvoiceId).toBe('in_fake'); // marker present

    // Attempt 2: Stripe now healthy + the orphaned invoice is still draft
    // on Stripe's side. Recovery branch resumes add-items + finalize.
    stripe.behavior.failAt = undefined;
    stripe.behavior.remoteStatus = 'draft';
    const result = await svc.finalizeInvoice('inv-orphan');

    expect(result.status).toBe('open');
    expect(result.stripeInvoiceId).toBe('in_fake');
    // Recovery branch: retrieveInvoice consulted; createInvoice NOT
    // re-called (the marker's id is reused).
    expect(stripe.calls.retrieveInvoice).toBe(1);
    expect(stripe.calls.createInvoice).toBe(1); // only the attempt-1 create
  });

  it('catch-up recovery: orphaned invoice already finalized on Stripe → DB just catches up', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient({ failAt: 'finalizeInvoice' });
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-orphan-caughtup');
    await expect(svc.finalizeInvoice('inv-orphan-caughtup')).rejects.toMatchObject({
      code: 'STRIPE_API_ERROR',
    });

    // Attempt 2: this time the Stripe invoice IS finalized (status open) —
    // e.g. the attempt-1 finalize actually landed on Stripe's side but the
    // error surfaced after. Recovery just catches the DB up, no re-finalize.
    stripe.behavior.failAt = undefined;
    stripe.behavior.remoteStatus = 'open';
    const finalizeCallsBefore = stripe.calls.finalizeInvoice;
    const result = await svc.finalizeInvoice('inv-orphan-caughtup');

    expect(result.status).toBe('open');
    expect(stripe.calls.retrieveInvoice).toBe(1);
    // remote already open → no second finalize call.
    expect(stripe.calls.finalizeInvoice).toBe(finalizeCallsBefore);
  });

  it('falls through to fresh-create when the orphaned stripe id no longer resolves', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient({ failAt: 'finalizeInvoice' });
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-orphan-stale');
    await expect(svc.finalizeInvoice('inv-orphan-stale')).rejects.toMatchObject({
      code: 'STRIPE_API_ERROR',
    });

    // Attempt 2: the orphaned Stripe invoice no longer resolves (deleted /
    // expired). Recovery clears the stale marker + falls to fresh-create.
    stripe.behavior.failAt = undefined;
    stripe.behavior.retrieveReturnsNull = true;
    const result = await svc.finalizeInvoice('inv-orphan-stale');

    expect(result.status).toBe('open');
    expect(stripe.calls.retrieveInvoice).toBe(1);
    expect(stripe.calls.createInvoice).toBe(2); // attempt-1 + fresh re-create
  });

  it('rejects recovery when the orphaned Stripe invoice is in a terminal state', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient({ failAt: 'finalizeInvoice' });
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-orphan-void');
    await expect(svc.finalizeInvoice('inv-orphan-void')).rejects.toMatchObject({
      code: 'STRIPE_API_ERROR',
    });

    // Attempt 2: the orphaned Stripe invoice was voided out-of-band.
    // Recovery refuses to reopen a terminal remote.
    stripe.behavior.failAt = undefined;
    stripe.behavior.remoteStatus = 'void';
    await expect(svc.finalizeInvoice('inv-orphan-void')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('ResellerInvoiceService.voidInvoice', () => {
  it('voids a draft invoice (no Stripe id yet) → status void', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient();
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-void-draft');

    const result = await svc.voidInvoice('inv-void-draft', 'test void');
    expect(result.status).toBe('void');
    // No Stripe invoice existed → no Stripe void call.
    expect(stripe.calls.voidInvoice).toBe(0);
  });

  it('voids a finalized (open) invoice → Stripe void + status void; line items preserved', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient();
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-void-open');
    await svc.finalizeInvoice('inv-void-open');

    const result = await svc.voidInvoice('inv-void-open', 'customer dispute');
    expect(result.status).toBe('void');
    expect(stripe.calls.voidInvoice).toBe(1);

    // Line items preserved as audit-of-truth.
    const items = await svc.getLineItems('inv-void-open');
    expect(items).toHaveLength(1);
  });

  it('is an idempotent no-op when the invoice is already void', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const stripe = makeStripeClient();
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 }, stripe,
    });
    await seedDraftInvoice(svc, 'inv-void-idem');
    await svc.voidInvoice('inv-void-idem', 'first');
    const second = await svc.voidInvoice('inv-void-idem', 'second');
    expect(second.status).toBe('void');
  });

  it('rejects voiding a paid invoice', async () => {
    await seedPricing('cfg-a', 'cust-a', 'percentage', 500);
    const svc = makeService({
      children: ['cust-a'], usage: { 'cust-a': 100 }, baseRates: { 'cust-a': 10 },
    });
    await seedDraftInvoice(svc, 'inv-void-paid');
    // Force the row to 'paid' directly (paid transition arrives via webhook
    // in surface-4; here we just need the state to test the guard).
    await sql`UPDATE reseller_invoices SET status = 'paid' WHERE id = 'inv-void-paid'`;

    await expect(svc.voidInvoice('inv-void-paid', 'too late')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
