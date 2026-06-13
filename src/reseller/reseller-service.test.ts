/**
 * Unit tests for ResellerService membership-gated lookups
 * (getResellerOr404, listCustomers, getCustomerOr404) and ResellerAccessError.
 *
 * The SQL layer is covered by integration tests / the reseller-member
 * service suite; here we mock `sql` with a fake tagged template that serves
 * just enough of `reseller_members` for `getMembership`, and we inject a
 * hand-rolled OrgService stub for the org-side lookups.
 */

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import type { OrgService, Organization } from '../org/org-service.js';
import {
  ResellerAccessError,
  ResellerService,
} from './reseller-service.js';
import type { ResellerRole } from './types.js';
import { runWithSql } from '../db/context.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string;
  reseller_org_id: string;
  user_id: string;
  role: ResellerRole;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
}

function createMockSql(members: Map<string, MemberRow>) {
  const handler = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (
      query.includes('FROM reseller_members') &&
      query.includes('reseller_org_id') &&
      query.includes('user_id')
    ) {
      const resellerOrgId = values[0] as string;
      const userId = values[1] as string;
      const row = [...members.values()].find(
        (m) => m.reseller_org_id === resellerOrgId && m.user_id === userId,
      );
      return Promise.resolve(row ? [row] : []);
    }
    throw new Error(`Unhandled mock SQL query: ${query}`);
  };
  return handler as unknown as postgres.Sql;
}

function makeOrg(partial: Partial<Organization> & Pick<Organization, 'id' | 'type'>): Organization {
  const now = new Date().toISOString();
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    ownerId: partial.ownerId ?? 'owner',
    plan: partial.plan ?? 'free',
    defaultServerAccess: partial.defaultServerAccess ?? 'none',
    promptCaptureEnabled: partial.promptCaptureEnabled ?? false,
    stripeCustomerId: partial.stripeCustomerId ?? null,
    stripeSubscriptionId: partial.stripeSubscriptionId ?? null,
    type: partial.type,
    parentOrgId: partial.parentOrgId ?? null,
    auth0OrgId: null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

function makeOrgService(opts: {
  orgs?: Record<string, Organization>;
  customersByReseller?: Record<string, Organization[]>;
}): OrgService {
  const orgs = opts.orgs ?? {};
  const customers = opts.customersByReseller ?? {};
  const stub = {
    getOrg: async (id: string) => orgs[id] ?? null,
    getCustomersOfReseller: async (id: string) => customers[id] ?? [],
  };
  return stub as unknown as OrgService;
}

function seedMember(
  rows: Map<string, MemberRow>,
  id: string,
  resellerOrgId: string,
  userId: string,
  role: ResellerRole,
): void {
  const now = new Date().toISOString();
  rows.set(id, {
    id,
    reseller_org_id: resellerOrgId,
    user_id: userId,
    role,
    invited_by: null,
    joined_at: now,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RESELLER_ID = 'reseller_a';
const USER_ID = 'user_alice';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResellerAccessError', () => {
  it('exposes name and code', () => {
    const e = new ResellerAccessError('NOT_FOUND');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ResellerAccessError');
    expect(e.code).toBe('NOT_FOUND');
  });

  it('supports internal NOT_A_MEMBER and NOT_A_RESELLER codes', () => {
    expect(new ResellerAccessError('NOT_A_MEMBER').code).toBe('NOT_A_MEMBER');
    expect(new ResellerAccessError('NOT_A_RESELLER').code).toBe('NOT_A_RESELLER');
  });
});

describe('ResellerService.getResellerOr404', () => {
  it('returns the reseller org when the user is a member and type=reseller', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    seedMember(rows, 'm1', RESELLER_ID, USER_ID, 'reseller_admin');
    const org = makeOrg({ id: RESELLER_ID, type: 'reseller' });
    const service = new ResellerService(
      makeOrgService({ orgs: { [RESELLER_ID]: org } }),
    );
    const result = await runWithSql(sql, () => service.getResellerOr404(RESELLER_ID, USER_ID));
    expect(result.id).toBe(RESELLER_ID);
    expect(result.type).toBe('reseller');
  });

  it('throws NOT_A_MEMBER when user has no reseller membership', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const org = makeOrg({ id: RESELLER_ID, type: 'reseller' });
    const service = new ResellerService(
      makeOrgService({ orgs: { [RESELLER_ID]: org } }),
    );
    await expect(runWithSql(sql, () => service.getResellerOr404(RESELLER_ID, USER_ID))).rejects.toMatchObject({
      name: 'ResellerAccessError',
      code: 'NOT_A_MEMBER',
    });
  });

  it('throws NOT_FOUND when the org does not exist (even if ghost membership row exists)', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    seedMember(rows, 'm1', RESELLER_ID, USER_ID, 'reseller_owner');
    const service = new ResellerService(
      makeOrgService({ orgs: {} }),
    );
    await expect(runWithSql(sql, () => service.getResellerOr404(RESELLER_ID, USER_ID))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it("throws NOT_A_RESELLER when the org exists but type='customer'", async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    seedMember(rows, 'm1', RESELLER_ID, USER_ID, 'reseller_owner');
    const customerOrg = makeOrg({ id: RESELLER_ID, type: 'customer', parentOrgId: 'parent' });
    const service = new ResellerService(
      makeOrgService({ orgs: { [RESELLER_ID]: customerOrg } }),
    );
    await expect(runWithSql(sql, () => service.getResellerOr404(RESELLER_ID, USER_ID))).rejects.toMatchObject({
      code: 'NOT_A_RESELLER',
    });
  });
});

describe('ResellerService.listCustomers', () => {
  it('returns all customers parented to the reseller', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const c1 = makeOrg({ id: 'c1', type: 'customer', parentOrgId: RESELLER_ID });
    const c2 = makeOrg({ id: 'c2', type: 'customer', parentOrgId: RESELLER_ID });
    const service = new ResellerService(
      makeOrgService({ customersByReseller: { [RESELLER_ID]: [c1, c2] } }),
    );
    const result = await runWithSql(sql, () => service.listCustomers(RESELLER_ID));
    expect(result.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('excludes standalone and other resellers’ customers (delegated to OrgService)', async () => {
    // getCustomersOfReseller already filters by parent_org_id + type='customer';
    // we verify the service layer honours that contract by returning only what
    // the stub provides for THIS reseller id.
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const c1 = makeOrg({ id: 'c1', type: 'customer', parentOrgId: RESELLER_ID });
    const service = new ResellerService(
      makeOrgService({
        customersByReseller: {
          [RESELLER_ID]: [c1],
          other_reseller: [makeOrg({ id: 'c_other', type: 'customer', parentOrgId: 'other_reseller' })],
        },
      }),
    );
    const result = await runWithSql(sql, () => service.listCustomers(RESELLER_ID));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('returns [] when the reseller has no customers', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const service = new ResellerService(
      makeOrgService({ customersByReseller: {} }),
    );
    expect(await runWithSql(sql, () => service.listCustomers(RESELLER_ID))).toEqual([]);
  });
});

describe('ResellerService.getCustomerOr404', () => {
  const CUSTOMER_ID = 'customer_1';

  it('returns the customer when type=customer and parent_org_id=resellerId', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const customer = makeOrg({ id: CUSTOMER_ID, type: 'customer', parentOrgId: RESELLER_ID });
    const service = new ResellerService(
      makeOrgService({ orgs: { [CUSTOMER_ID]: customer } }),
    );
    const result = await runWithSql(sql, () => service.getCustomerOr404(RESELLER_ID, CUSTOMER_ID));
    expect(result.id).toBe(CUSTOMER_ID);
  });

  it('throws NOT_FOUND when the customer is under a different reseller', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const customer = makeOrg({ id: CUSTOMER_ID, type: 'customer', parentOrgId: 'other_reseller' });
    const service = new ResellerService(
      makeOrgService({ orgs: { [CUSTOMER_ID]: customer } }),
    );
    await expect(runWithSql(sql, () => service.getCustomerOr404(RESELLER_ID, CUSTOMER_ID))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws NOT_FOUND when the target is actually a reseller org', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const reseller = makeOrg({ id: CUSTOMER_ID, type: 'reseller' });
    const service = new ResellerService(
      makeOrgService({ orgs: { [CUSTOMER_ID]: reseller } }),
    );
    await expect(runWithSql(sql, () => service.getCustomerOr404(RESELLER_ID, CUSTOMER_ID))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws NOT_FOUND when no such org exists', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const service = new ResellerService(
      makeOrgService({ orgs: {} }),
    );
    await expect(runWithSql(sql, () => service.getCustomerOr404(RESELLER_ID, CUSTOMER_ID))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws NOT_FOUND when the target is a standalone org', async () => {
    const rows = new Map<string, MemberRow>();
    const sql = createMockSql(rows);
    const standalone = makeOrg({ id: CUSTOMER_ID, type: 'standalone' });
    const service = new ResellerService(
      makeOrgService({ orgs: { [CUSTOMER_ID]: standalone } }),
    );
    await expect(runWithSql(sql, () => service.getCustomerOr404(RESELLER_ID, CUSTOMER_ID))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
