import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithSql, enterTestContext } from '../db/context.js';

// We test OrgService with a mock SQL that stores rows in Maps.
// This verifies the CRUD contracts for orgs, members, and invitations.

describe('OrgService', () => {
  let OrgService: typeof import('./org-service.js').OrgService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./org-service.js');
    OrgService = mod.OrgService;
  });

  /** Build a result array with a `.count` property, matching postgres.js behavior. */
  function resultWithCount(rows: unknown[], count: number) {
    return Object.assign(rows, { count });
  }

  function createMockSql() {
    const orgs = new Map<string, Record<string, unknown>>();
    const members = new Map<string, Record<string, unknown>>();
    const invitations = new Map<string, Record<string, unknown>>();

    const now = new Date().toISOString();

    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');

      // ----------------------------------------------------------------------
      // Schema DDL -- ignore
      // ----------------------------------------------------------------------
      if (query.includes('CREATE TABLE') || query.includes('CREATE INDEX')) {
        return Promise.resolve([]);
      }

      // ----------------------------------------------------------------------
      // Organizations
      // ----------------------------------------------------------------------
      if (query.includes('INSERT INTO organizations')) {
        const id = values[0] as string;
        const name = values[1] as string;
        const ownerId = values[2] as string;
        // plan is values[3]; type/parent_org_id are values[4]/[5] when the
        // reseller-aware INSERT shape is used.
        const plan = (values[3] as string | undefined) ?? 'free';
        const type = (values[4] as string | undefined) ?? 'standalone';
        const parentOrgId = (values[5] as string | null | undefined) ?? null;
        const row = {
          id,
          name,
          owner_id: ownerId,
          plan,
          stripe_customer_id: null,
          stripe_subscription_id: null,
          type,
          parent_org_id: parentOrgId,
          created_at: now,
          updated_at: now,
        };
        orgs.set(id, row);
        return Promise.resolve([row]);
      }

      // getResellerOfCustomer -- JOIN organizations on itself
      if (
        query.includes('SELECT') &&
        query.includes('FROM organizations child') &&
        query.includes('JOIN organizations parent')
      ) {
        const childId = values[0] as string;
        const child = orgs.get(childId);
        if (!child || !child.parent_org_id) return Promise.resolve([]);
        const parent = orgs.get(child.parent_org_id as string);
        return Promise.resolve(parent ? [parent] : []);
      }

      // getCustomersOfReseller -- WHERE parent_org_id = ? AND type = 'customer'
      if (
        query.includes('SELECT') &&
        query.includes('FROM organizations') &&
        query.includes('parent_org_id =') &&
        query.includes("type = 'customer'")
      ) {
        const parentId = values[0] as string;
        const rows = [...orgs.values()].filter(
          (o) => o.parent_org_id === parentId && o.type === 'customer',
        );
        return Promise.resolve(rows);
      }

      // isReseller -- SELECT type FROM organizations WHERE id = ?
      if (
        query.includes('SELECT type FROM organizations') &&
        query.includes('WHERE id =')
      ) {
        const orgId = values[0] as string;
        const row = orgs.get(orgId);
        return Promise.resolve(row ? [{ type: row.type }] : []);
      }

      if (query.includes('SELECT') && query.includes('FROM organizations') && !query.includes('JOIN')) {
        const orgId = values[0] as string;
        const row = orgs.get(orgId);
        return Promise.resolve(row ? [row] : []);
      }

      // getUserOrgs -- JOIN org_members
      if (query.includes('SELECT') && query.includes('JOIN org_members')) {
        const userId = values[0] as string;
        const userOrgIds = [...members.values()]
          .filter((m) => m.user_id === userId)
          .map((m) => m.org_id as string);
        const rows = userOrgIds
          .map((oid) => orgs.get(oid))
          .filter(Boolean);
        return Promise.resolve(rows);
      }

      if (query.includes('UPDATE organizations SET name')) {
        const name = values[0] as string;
        const orgId = values[1] as string;
        const existing = orgs.get(orgId);
        if (!existing) return Promise.resolve([]);
        const updated = { ...existing, name, updated_at: now };
        orgs.set(orgId, updated);
        return Promise.resolve([updated]);
      }

      // Layer 1 createOrg: provisioner-attach UPDATE writes stripe IDs only.
      if (query.includes('UPDATE organizations') && query.includes('stripe_customer_id') && !query.includes('plan')) {
        const stripeCustomerId = values[0] as string | null;
        const stripeSubscriptionId = values[1] as string | null;
        const orgId = values[2] as string;
        const existing = orgs.get(orgId);
        if (existing) {
          orgs.set(orgId, {
            ...existing,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            updated_at: now,
          });
        }
        return Promise.resolve([]);
      }

      if (query.includes('UPDATE organizations SET') && query.includes('plan')) {
        const plan = values[0] as string;
        const stripeCustomerId = values[1] as string | null;
        const stripeSubscriptionId = values[2] as string | null;
        const orgId = values[3] as string;
        const existing = orgs.get(orgId);
        if (existing) {
          orgs.set(orgId, {
            ...existing,
            plan,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            updated_at: now,
          });
        }
        return Promise.resolve([]);
      }

      if (query.includes('DELETE FROM organizations')) {
        const orgId = values[0] as string;
        const existed = orgs.delete(orgId);
        return Promise.resolve(resultWithCount([], existed ? 1 : 0));
      }

      // ----------------------------------------------------------------------
      // Members
      // ----------------------------------------------------------------------

      // UPDATE org_members SET role = ? -- updateMemberRole
      if (query.includes('UPDATE org_members SET role')) {
        const newRole = values[0] as string;
        const orgId = values[1] as string;
        const userId = values[2] as string;
        const key = `${orgId}:${userId}`;
        const existing = members.get(key);
        if (!existing) return Promise.resolve([]);
        const updated = { ...existing, role: newRole };
        members.set(key, updated);
        return Promise.resolve([updated]);
      }

      // INSERT INTO org_members -- the role literal ('owner' or 'member') is
      // embedded in the SQL template, not interpolated. Detect it from the
      // query string.
      if (query.includes('INSERT INTO org_members')) {
        const id = values[0] as string;
        const orgId = values[1] as string;
        const userId = values[2] as string;
        const role = query.includes("'owner'") ? 'owner' : 'member';
        const row = {
          id,
          org_id: orgId,
          user_id: userId,
          role,
          joined_at: now,
          created_at: now,
        };
        const key = `${orgId}:${userId}`;
        // ON CONFLICT DO NOTHING
        if (!members.has(key)) {
          members.set(key, row);
        }
        const existing = members.get(key)!;
        return Promise.resolve([existing]);
      }

      // getMembership -- SELECT * FROM org_members WHERE org_id = ? AND user_id = ?
      // Must be checked BEFORE the getMembers branch (which lacks AND user_id).
      if (
        query.includes('SELECT') &&
        query.includes('org_members') &&
        query.includes('AND user_id')
      ) {
        const orgId = values[0] as string;
        const userId = values[1] as string;
        const key = `${orgId}:${userId}`;
        const row = members.get(key);
        return Promise.resolve(row ? [row] : []);
      }

      // getMembers -- SELECT * FROM org_members WHERE org_id = ?
      if (
        query.includes('SELECT') &&
        query.includes('org_members') &&
        !query.includes('AND user_id')
      ) {
        const orgId = values[0] as string;
        const rows = [...members.values()].filter((m) => m.org_id === orgId);
        return Promise.resolve(rows);
      }

      if (query.includes('DELETE FROM org_members')) {
        const orgId = values[0] as string;
        const userId = values[1] as string;
        const key = `${orgId}:${userId}`;
        const existed = members.delete(key);
        return Promise.resolve(resultWithCount([], existed ? 1 : 0));
      }

      // ----------------------------------------------------------------------
      // Invitations
      // ----------------------------------------------------------------------
      if (query.includes('INSERT INTO org_invitations')) {
        // Post-015 contract: only the hash persists. Columns:
        //   (id, org_id, invited_by, token_hash, expires_at, max_uses, use_count)
        const id = values[0] as string;
        const orgId = values[1] as string;
        const invitedBy = values[2] as string;
        const tokenHash = values[3] as string;
        const expiresAt = values[4] as string;
        const maxUses = values[5] as number | null;
        const useCount = values[6] as number;
        const row = {
          id,
          org_id: orgId,
          invited_by: invitedBy,
          token_hash: tokenHash,
          expires_at: expiresAt,
          accepted_by: null,
          accepted_at: null,
          max_uses: maxUses,
          use_count: useCount,
          created_at: now,
        };
        invitations.set(id, row);
        return Promise.resolve([row]);
      }

      // getInvitationByToken -- SELECT ... WHERE token_hash = ?
      // Post-015 contract: hash-only lookup, no OR-NULL fallback.
      if (
        query.includes('SELECT') &&
        query.includes('org_invitations') &&
        query.includes('token_hash')
      ) {
        const tokenHash = values[0] as string;
        const row = [...invitations.values()].find(
          (inv) =>
            inv.token_hash === tokenHash &&
            (inv.max_uses === null || (inv.use_count as number) < (inv.max_uses as number)) &&
            new Date(inv.expires_at as string) > new Date(),
        );
        return Promise.resolve(row ? [row] : []);
      }

      // listInvitations -- SELECT ... WHERE org_id = ?
      if (
        query.includes('SELECT') &&
        query.includes('org_invitations') &&
        query.includes('org_id')
      ) {
        const orgId = values[0] as string;
        const rows = [...invitations.values()].filter(
          (inv) =>
            inv.org_id === orgId &&
            (inv.max_uses === null || (inv.use_count as number) < (inv.max_uses as number)) &&
            new Date(inv.expires_at as string) > new Date(),
        );
        return Promise.resolve(rows);
      }

      // acceptInvitation -- UPDATE org_invitations SET use_count = use_count + 1 (with or without accepted_by)
      if (query.includes('UPDATE org_invitations')) {
        const invId = query.includes('accepted_by') ? values[1] as string : values[0] as string;
        const row = invitations.get(invId);
        if (row) {
          row.use_count = (row.use_count as number) + 1;
          if (query.includes('accepted_by')) {
            const userId = values[0] as string;
            row.accepted_by = userId;
            row.accepted_at = now;
          }
        }
        return Promise.resolve([]);
      }

      if (query.includes('DELETE FROM org_invitations')) {
        // Scoped DELETE: WHERE id = $1 AND org_id = $2 — a row matches only
        // when both the id and the org match, mirroring the SQL.
        const invId = values[0] as string;
        const orgId = values[1] as string;
        const row = invitations.get(invId);
        const matched = row !== undefined && row.org_id === orgId;
        if (matched) invitations.delete(invId);
        return Promise.resolve(resultWithCount([], matched ? 1 : 0));
      }

      // Fallback
      return Promise.resolve([]);
    };

    return sql as unknown as import('postgres').Sql;
  }

  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------

  it('createOrg creates org and owner membership', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Acme Corp', 'user_owner'));

    expect(org.name).toBe('Acme Corp');
    expect(org.ownerId).toBe('user_owner');
    // Layer 1: getDefaultPlan() returns 'conduit' (DOR §9.1 — paid-with-trial,
    // not free). The legacy 'free' default is gone.
    expect(org.plan).toBe('conduit');
    expect(org.id).toBeDefined();

    // Owner should be a member
    const membership = await runWithSql(sql, () => service.getMembership(org.id, 'user_owner'));
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('owner');
  });

  describe('createOrg — Layer 1 billing-provisioner attach', () => {
    it('standalone org with a provisioner: provisioner is called and Stripe IDs land on the org row', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const provisioner = vi.fn().mockResolvedValue({
        stripeCustomerId: 'cus_test_xyz',
        stripeSubscriptionId: 'sub_test_xyz',
      });
      const service = new OrgService({ billingProvisioner: provisioner });

      const org = await runWithSql(sql, () =>
        service.createOrg('Acme Co', 'user_owner', undefined, {
          ownerEmail: 'owner@acme.example',
        }),
      );

      expect(provisioner).toHaveBeenCalledWith({
        orgId: org.id,
        orgName: 'Acme Co',
        ownerEmail: 'owner@acme.example',
      });
      expect(org.stripeCustomerId).toBe('cus_test_xyz');
      expect(org.stripeSubscriptionId).toBe('sub_test_xyz');

      // The row in the DB also reflects the IDs (UPDATE actually ran).
      const reread = await runWithSql(sql, () => service.getOrg(org.id));
      expect(reread!.stripeCustomerId).toBe('cus_test_xyz');
      expect(reread!.stripeSubscriptionId).toBe('sub_test_xyz');
    });

    it('standalone org WITHOUT a provisioner: createOrg is a clean no-op past the inserts', async () => {
      // The provisioner-absent path is the dev / CI / pre-forge-cred shape.
      // The org gets created with the conduit plan but no Stripe attach;
      // downstream consumers already handle the null-customer case (F3).
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const org = await runWithSql(sql, () =>
        service.createOrg('Acme Co', 'user_owner'),
      );

      expect(org.plan).toBe('conduit');
      expect(org.stripeCustomerId).toBeNull();
      expect(org.stripeSubscriptionId).toBeNull();
    });

    it('provisioner returning null skips the UPDATE — controlled refusal signal', async () => {
      // Used by createConduitBillingProvisioner when price IDs are unset:
      // refuse to mint a half-created Stripe customer with empty price.
      const sql = createMockSql();
      enterTestContext(sql);
      const provisioner = vi.fn().mockResolvedValue(null);
      const service = new OrgService({ billingProvisioner: provisioner });

      const org = await runWithSql(sql, () => service.createOrg('Acme Co', 'user_owner'));

      expect(provisioner).toHaveBeenCalledTimes(1);
      expect(org.stripeCustomerId).toBeNull();
      expect(org.stripeSubscriptionId).toBeNull();
    });

    it('customer org skips the provisioner — billed via reseller path, not Stripe directly', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const provisioner = vi.fn().mockResolvedValue({
        stripeCustomerId: 'should-not-be-used',
        stripeSubscriptionId: 'should-not-be-used',
      });
      const service = new OrgService({ billingProvisioner: provisioner });

      // Seed a reseller to parent the customer under.
      const reseller = await runWithSql(sql, () =>
        service.createOrg('MSP Co', 'user_msp', undefined, { type: 'reseller' }),
      );

      const customer = await runWithSql(sql, () =>
        service.createOrg('Customer Co', 'user_cust', undefined, {
          type: 'customer',
          parentOrgId: reseller.id,
        }),
      );

      // Provisioner WAS called for the reseller (also standalone-like in
      // the sense that it could attach), but explicitly NOT called for the
      // customer. Asserting on the customer-specific call shape.
      const customerCalls = provisioner.mock.calls.filter(
        ([arg]) => (arg as { orgId: string }).orgId === customer.id,
      );
      expect(customerCalls).toHaveLength(0);
    });

    it('reseller org skips the provisioner — also billed outside Layer 1', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const provisioner = vi.fn().mockResolvedValue({
        stripeCustomerId: 'cus_should_not_be_used',
        stripeSubscriptionId: 'sub_should_not_be_used',
      });
      const service = new OrgService({ billingProvisioner: provisioner });

      const reseller = await runWithSql(sql, () =>
        service.createOrg('MSP Co', 'user_msp', undefined, { type: 'reseller' }),
      );

      expect(provisioner).not.toHaveBeenCalled();
      expect(reseller.stripeCustomerId).toBeNull();
      expect(reseller.stripeSubscriptionId).toBeNull();
    });
  });

  it('getOrg returns org or null', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Test Org', 'user_1'));
    const fetched = await runWithSql(sql, () => service.getOrg(org.id));
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Org');

    const missing = await runWithSql(sql, () => service.getOrg('nonexistent'));
    expect(missing).toBeNull();
  });

  it('getUserOrgs returns orgs for a user', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    await runWithSql(sql, () => service.createOrg('Org A', 'user_1'));
    await runWithSql(sql, () => service.createOrg('Org B', 'user_1'));
    await runWithSql(sql, () => service.createOrg('Org C', 'user_2'));

    const userOrgs = await runWithSql(sql, () => service.getUserOrgs('user_1'));
    expect(userOrgs).toHaveLength(2);
    expect(userOrgs.map((o) => o.name).sort()).toEqual(['Org A', 'Org B']);

    const user2Orgs = await runWithSql(sql, () => service.getUserOrgs('user_2'));
    expect(user2Orgs).toHaveLength(1);
    expect(user2Orgs[0].name).toBe('Org C');
  });

  it('updateOrg updates the name', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Old Name', 'user_1'));
    const updated = await runWithSql(sql, () => service.updateOrg(org.id, 'New Name'));
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('New Name');

    const notFound = await runWithSql(sql, () => service.updateOrg('nonexistent', 'Nope'));
    expect(notFound).toBeNull();
  });

  it('deleteOrg removes the org', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Doomed Org', 'user_1'));
    const deleted = await runWithSql(sql, () => service.deleteOrg(org.id));
    expect(deleted).toBe(true);

    const gone = await runWithSql(sql, () => service.getOrg(org.id));
    expect(gone).toBeNull();

    const again = await runWithSql(sql, () => service.deleteOrg(org.id));
    expect(again).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  it('getMembers returns members', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Team Org', 'user_owner'));

    const memberList = await runWithSql(sql, () => service.getMembers(org.id));
    expect(memberList).toHaveLength(1);
    expect(memberList[0].userId).toBe('user_owner');
    expect(memberList[0].role).toBe('owner');
  });

  it('getMembership returns membership or null', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Membership Org', 'user_owner'));

    const found = await runWithSql(sql, () => service.getMembership(org.id, 'user_owner'));
    expect(found).not.toBeNull();
    expect(found!.role).toBe('owner');

    const missing = await runWithSql(sql, () => service.getMembership(org.id, 'user_stranger'));
    expect(missing).toBeNull();
  });

  it('removeMember removes member but not owner', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Remove Org', 'user_owner'));

    // Cannot remove the owner
    const ownerRemoved = await runWithSql(sql, () => service.removeMember(org.id, 'user_owner'));
    expect(ownerRemoved).toBe(false);

    // Owner should still be there
    const ownerStillThere = await runWithSql(sql, () => service.getMembership(org.id, 'user_owner'));
    expect(ownerStillThere).not.toBeNull();

    // Accept an invitation to add a regular member, then remove them
    const { plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));
    await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_member'));

    const memberExists = await runWithSql(sql, () => service.getMembership(org.id, 'user_member'));
    expect(memberExists).not.toBeNull();
    expect(memberExists!.role).toBe('member');

    const memberRemoved = await runWithSql(sql, () => service.removeMember(org.id, 'user_member'));
    expect(memberRemoved).toBe(true);

    const memberGone = await runWithSql(sql, () => service.getMembership(org.id, 'user_member'));
    expect(memberGone).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  it('createInvitation generates token with default single-use and 7-day expiry', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Invite Org', 'user_owner'));
    const { invitation, plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));

    expect(invitation.id).toBeDefined();
    expect(invitation.orgId).toBe(org.id);
    expect(invitation.invitedBy).toBe('user_owner');
    expect(plainToken).toBeDefined();
    expect(plainToken.length).toBeGreaterThanOrEqual(20);
    expect(invitation.acceptedBy).toBeNull();
    expect(invitation.acceptedAt).toBeNull();
    expect(invitation.maxUses).toBe(1);
    expect(invitation.useCount).toBe(0);
    expect(invitation.expiresAt).toBeDefined();

    // Default expiry should be ~7 days from now
    const expiresMs = new Date(invitation.expiresAt).getTime() - Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThan(sevenDaysMs - 5000);
    expect(expiresMs).toBeLessThanOrEqual(sevenDaysMs);
  });

  it('createInvitation stores SHA-256 hash, returns plaintext token (PRD §7.1, §8.4)', async () => {
    const { createHash } = await import('node:crypto');
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Hash Org', 'user_owner'));
    const { invitation, plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));

    // Callers must receive the raw token once (for the email link).
    expect(plainToken).toMatch(/^[A-Za-z0-9_-]+$/);

    // Lookup by the raw token must resolve (hash-first path).
    const byToken = await runWithSql(sql, () => service.getInvitationByToken(plainToken));
    expect(byToken).not.toBeNull();
    expect(byToken!.id).toBe(invitation.id);

    // Lookup by the *hash* of the token must NOT resolve — the hash is
    // what the DB stores, but callers must present the plaintext.
    const hash = createHash('sha256').update(plainToken).digest('hex');
    const byHash = await runWithSql(sql, () => service.getInvitationByToken(hash));
    expect(byHash).toBeNull();
  });

  it('acceptInvitation creates membership', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Accept Org', 'user_owner'));
    const { plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));

    const member = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_joiner'));
    expect(member).not.toBeNull();
    expect(member!.orgId).toBe(org.id);
    expect(member!.userId).toBe('user_joiner');
    expect(member!.role).toBe('member');

    // Verify membership persists
    const membership = await runWithSql(sql, () => service.getMembership(org.id, 'user_joiner'));
    expect(membership).not.toBeNull();

    // Using the same token again should return null (already accepted)
    const again = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_other'));
    expect(again).toBeNull();
  });

  it('listInvitations returns pending invites', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('List Org', 'user_owner'));
    await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));
    await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));

    const pending = await runWithSql(sql, () => service.listInvitations(org.id));
    expect(pending).toHaveLength(2);
    expect(pending[0].orgId).toBe(org.id);
    expect(pending[0].acceptedBy).toBeNull();
  });

  it('revokeInvitation deletes invitation', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Revoke Org', 'user_owner'));
    const { invitation } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));

    const revoked = await runWithSql(sql, () => service.revokeInvitation(invitation.id, org.id));
    expect(revoked).toBe(true);

    // Should no longer appear in pending list
    const pending = await runWithSql(sql, () => service.listInvitations(org.id));
    expect(pending).toHaveLength(0);

    // Revoking again returns false
    const again = await runWithSql(sql, () => service.revokeInvitation(invitation.id, org.id));
    expect(again).toBe(false);
  });

  it('revokeInvitation is a no-op for an invitation owned by another org', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const orgA = await runWithSql(sql, () => service.createOrg('Org A', 'user_a'));
    const orgB = await runWithSql(sql, () => service.createOrg('Org B', 'user_b'));
    const { invitation } = await runWithSql(sql, () => service.createInvitation(orgB.id, 'user_b'));

    // Org A passing org B's invitation id — the DELETE is scoped by org_id,
    // so it matches zero rows: cross-tenant revoke cannot succeed.
    const revoked = await runWithSql(sql, () => service.revokeInvitation(invitation.id, orgA.id));
    expect(revoked).toBe(false);

    // Org B's invitation is untouched — still pending.
    const pendingB = await runWithSql(sql, () => service.listInvitations(orgB.id));
    expect(pendingB).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // RBAC — Admin role
  // -------------------------------------------------------------------------

  /** Helper: create an org with an owner and add a member, then promote to admin. */
  async function setupWithAdmin(
    service: InstanceType<typeof OrgService>,
    sql: ReturnType<typeof createMockSql>,
  ) {
    const org = await runWithSql(sql, () => service.createOrg('Admin Org', 'user_owner'));
    const { plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));
    await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_admin'));
    await runWithSql(sql, () => service.updateMemberRole(org.id, 'user_admin', 'admin'));
    return org;
  }

  it('updateMemberRole promotes member to admin', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Role Org', 'user_owner'));
    const { plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));
    await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_member'));

    const updated = await runWithSql(sql, () => service.updateMemberRole(org.id, 'user_member', 'admin'));
    expect(updated).not.toBeNull();
    expect(updated!.role).toBe('admin');

    const membership = await runWithSql(sql, () => service.getMembership(org.id, 'user_member'));
    expect(membership!.role).toBe('admin');
  });

  it('updateMemberRole demotes admin to member', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await setupWithAdmin(service, sql);

    const updated = await runWithSql(sql, () => service.updateMemberRole(org.id, 'user_admin', 'member'));
    expect(updated).not.toBeNull();
    expect(updated!.role).toBe('member');
  });

  it('updateMemberRole cannot change owner role', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Owner Protected Org', 'user_owner'));
    const result = await runWithSql(sql, () => service.updateMemberRole(org.id, 'user_owner', 'admin'));
    expect(result).toBeNull();
  });

  it('updateMemberRole cannot promote to owner', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('No Promote Org', 'user_owner'));
    const { plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));
    await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_member'));

    const result = await runWithSql(sql, () => service.updateMemberRole(org.id, 'user_member', 'owner'));
    expect(result).toBeNull();
  });

  it('admin membership is correctly returned', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await setupWithAdmin(service, sql);

    const membership = await runWithSql(sql, () => service.getMembership(org.id, 'user_admin'));
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('admin');
  });

  // -------------------------------------------------------------------------
  // Multi-use & custom expiry invitations
  // -------------------------------------------------------------------------

  it('single-use invite rejects second accept', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Single Use Org', 'user_owner'));
    const { plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner'));

    const member1 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_a'));
    expect(member1).not.toBeNull();

    const member2 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_b'));
    expect(member2).toBeNull();
  });

  it('multi-use invite allows up to maxUses accepts', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Multi Use Org', 'user_owner'));
    const { invitation, plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner', { maxUses: 3 }));

    expect(invitation.maxUses).toBe(3);
    expect(invitation.useCount).toBe(0);

    const m1 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_a'));
    expect(m1).not.toBeNull();

    const m2 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_b'));
    expect(m2).not.toBeNull();

    const m3 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_c'));
    expect(m3).not.toBeNull();

    // 4th user should be rejected
    const m4 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_d'));
    expect(m4).toBeNull();
  });

  it('unlimited invite (maxUses: null) allows multiple accepts', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Unlimited Org', 'user_owner'));
    const { invitation, plainToken } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner', { maxUses: null }));

    expect(invitation.maxUses).toBeNull();

    const m1 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_a'));
    expect(m1).not.toBeNull();

    const m2 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_b'));
    expect(m2).not.toBeNull();

    const m3 = await runWithSql(sql, () => service.acceptInvitation(plainToken, 'user_c'));
    expect(m3).not.toBeNull();

    // Should still appear in pending list
    const pending = await runWithSql(sql, () => service.listInvitations(org.id));
    expect(pending).toHaveLength(1);
  });

  it('custom expiresInHours sets correct expiration', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await runWithSql(sql, () => service.createOrg('Custom Expiry Org', 'user_owner'));
    const { invitation } = await runWithSql(sql, () => service.createInvitation(org.id, 'user_owner', { expiresInHours: 24 }));

    const expiresMs = new Date(invitation.expiresAt).getTime() - Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThan(oneDayMs - 5000);
    expect(expiresMs).toBeLessThanOrEqual(oneDayMs);
  });

  it('removeMember removes admin but not owner', async () => {
    const sql = createMockSql();
    enterTestContext(sql);
    const service = new OrgService();

    const org = await setupWithAdmin(service, sql);

    // Can remove admin
    const removed = await runWithSql(sql, () => service.removeMember(org.id, 'user_admin'));
    expect(removed).toBe(true);

    const gone = await runWithSql(sql, () => service.getMembership(org.id, 'user_admin'));
    expect(gone).toBeNull();

    // Still cannot remove owner
    const ownerRemoved = await runWithSql(sql, () => service.removeMember(org.id, 'user_owner'));
    expect(ownerRemoved).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Reseller hierarchy (PRD §5.1)
  // -------------------------------------------------------------------------

  describe('reseller hierarchy helpers', () => {
    it('isReseller returns true for reseller orgs', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP Inc', 'user_owner', 'free', {
        type: 'reseller',
      }));
      expect(reseller.type).toBe('reseller');
      expect(reseller.parentOrgId).toBeNull();

      expect(await service.isReseller(reseller.id)).toBe(true);
    });

    it('isReseller returns false for standalone orgs', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const standalone = await runWithSql(sql, () => service.createOrg('Solo Co', 'user_owner'));
      expect(standalone.type).toBe('standalone');
      expect(await service.isReseller(standalone.id)).toBe(false);
    });

    it('isReseller returns false for customer orgs', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP Inc', 'user_owner', 'free', {
        type: 'reseller',
      }));
      const customer = await runWithSql(sql, () => service.createOrg('Client Corp', 'user_owner', 'free', {
        type: 'customer',
        parentOrgId: reseller.id,
      }));
      expect(await service.isReseller(customer.id)).toBe(false);
    });

    it('getCustomersOfReseller returns customers and excludes standalone / nested', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP Inc', 'user_owner', 'free', {
        type: 'reseller',
      }));
      const c1 = await runWithSql(sql, () => service.createOrg('Client A', 'user_owner', 'free', {
        type: 'customer',
        parentOrgId: reseller.id,
      }));
      const c2 = await runWithSql(sql, () => service.createOrg('Client B', 'user_owner', 'free', {
        type: 'customer',
        parentOrgId: reseller.id,
      }));
      // Unrelated standalone (should NOT appear)
      await runWithSql(sql, () => service.createOrg('Unrelated Solo', 'user_owner'));
      // A second reseller with its own customer (should NOT appear under reseller #1)
      const otherReseller = await runWithSql(sql, () => service.createOrg('Other MSP', 'user_owner', 'free', {
        type: 'reseller',
      }));
      await runWithSql(sql, () => service.createOrg('Other Client', 'user_owner', 'free', {
        type: 'customer',
        parentOrgId: otherReseller.id,
      }));

      const customers = await runWithSql(sql, () => service.getCustomersOfReseller(reseller.id));
      expect(customers).toHaveLength(2);
      const ids = customers.map((c) => c.id).sort();
      expect(ids).toEqual([c1.id, c2.id].sort());
      for (const c of customers) {
        expect(c.type).toBe('customer');
        expect(c.parentOrgId).toBe(reseller.id);
      }
    });

    it('getResellerOfCustomer returns the parent for a customer', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP Inc', 'user_owner', 'free', {
        type: 'reseller',
      }));
      const customer = await runWithSql(sql, () => service.createOrg('Client', 'user_owner', 'free', {
        type: 'customer',
        parentOrgId: reseller.id,
      }));

      const parent = await runWithSql(sql, () => service.getResellerOfCustomer(customer.id));
      expect(parent).not.toBeNull();
      expect(parent!.id).toBe(reseller.id);
      expect(parent!.type).toBe('reseller');
    });

    it('getResellerOfCustomer returns null for a standalone org', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const solo = await runWithSql(sql, () => service.createOrg('Solo', 'user_owner'));
      expect(await service.getResellerOfCustomer(solo.id)).toBeNull();
    });

    it('getResellerOfCustomer returns null for a reseller org', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP', 'user_owner', 'free', {
        type: 'reseller',
      }));
      expect(await service.getResellerOfCustomer(reseller.id)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Reseller-aware createOrg validation
  // -------------------------------------------------------------------------

  describe('createOrg with hierarchy options', () => {
    it('creates a reseller with type=reseller and null parent', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP', 'user_owner', 'free', {
        type: 'reseller',
        parentOrgId: null,
      }));
      expect(reseller.type).toBe('reseller');
      expect(reseller.parentOrgId).toBeNull();
    });

    it('creates a customer with valid reseller parent', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const service = new OrgService();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP', 'user_owner', 'free', {
        type: 'reseller',
      }));
      const customer = await runWithSql(sql, () => service.createOrg('Client', 'user_owner', 'free', {
        type: 'customer',
        parentOrgId: reseller.id,
      }));
      expect(customer.type).toBe('customer');
      expect(customer.parentOrgId).toBe(reseller.id);
    });

    it('rejects customer with null parent at the service layer (before DB trigger)', async () => {
      const { OrgService: Svc, OrgHierarchyError } = await import('./org-service.js');
      const service = new Svc();

      await expect(
        service.createOrg('Client', 'user_owner', 'free', {
          type: 'customer',
          parentOrgId: null,
        }),
      ).rejects.toBeInstanceOf(OrgHierarchyError);
    });

    it('rejects customer whose parent is not a reseller', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const { OrgService: Svc, OrgHierarchyError } = await import('./org-service.js');
      const service = new Svc();

      const solo = await runWithSql(sql, () => service.createOrg('Solo', 'user_owner'));
      await expect(
        service.createOrg('Client', 'user_owner', 'free', {
          type: 'customer',
          parentOrgId: solo.id,
        }),
      ).rejects.toBeInstanceOf(OrgHierarchyError);
    });

    it('rejects standalone with a parent at the service layer', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const { OrgService: Svc, OrgHierarchyError } = await import('./org-service.js');
      const service = new Svc();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP', 'user_owner', 'free', {
        type: 'reseller',
      }));
      await expect(
        service.createOrg('Bad Solo', 'user_owner', 'free', {
          type: 'standalone',
          parentOrgId: reseller.id,
        }),
      ).rejects.toBeInstanceOf(OrgHierarchyError);
    });

    it('rejects reseller with a parent at the service layer', async () => {
      const sql = createMockSql();
      enterTestContext(sql);
      const { OrgService: Svc, OrgHierarchyError } = await import('./org-service.js');
      const service = new Svc();

      const reseller = await runWithSql(sql, () => service.createOrg('MSP', 'user_owner', 'free', {
        type: 'reseller',
      }));
      await expect(
        service.createOrg('Nested MSP', 'user_owner', 'free', {
          type: 'reseller',
          parentOrgId: reseller.id,
        }),
      ).rejects.toBeInstanceOf(OrgHierarchyError);
    });
  });
});
