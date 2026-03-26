import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        const row = {
          id,
          name,
          owner_id: ownerId,
          plan: 'free',
          stripe_customer_id: null,
          stripe_subscription_id: null,
          created_at: now,
          updated_at: now,
        };
        orgs.set(id, row);
        return Promise.resolve([row]);
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
        const id = values[0] as string;
        const orgId = values[1] as string;
        const invitedBy = values[2] as string;
        const token = values[3] as string;
        const expiresAt = values[4] as string;
        const maxUses = values[5] as number | null;
        const useCount = values[6] as number;
        const row = {
          id,
          org_id: orgId,
          invited_by: invitedBy,
          token,
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

      // getInvitationByToken -- SELECT ... WHERE token = ?
      if (
        query.includes('SELECT') &&
        query.includes('org_invitations') &&
        query.includes('token')
      ) {
        const token = values[0] as string;
        const row = [...invitations.values()].find(
          (inv) =>
            inv.token === token &&
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
        const invId = values[0] as string;
        const existed = invitations.delete(invId);
        return Promise.resolve(resultWithCount([], existed ? 1 : 0));
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
    const service = new OrgService(sql);

    const org = await service.createOrg('Acme Corp', 'user_owner');

    expect(org.name).toBe('Acme Corp');
    expect(org.ownerId).toBe('user_owner');
    expect(org.plan).toBe('free');
    expect(org.id).toBeDefined();

    // Owner should be a member
    const membership = await service.getMembership(org.id, 'user_owner');
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('owner');
  });

  it('getOrg returns org or null', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Test Org', 'user_1');
    const fetched = await service.getOrg(org.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Org');

    const missing = await service.getOrg('nonexistent');
    expect(missing).toBeNull();
  });

  it('getUserOrgs returns orgs for a user', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    await service.createOrg('Org A', 'user_1');
    await service.createOrg('Org B', 'user_1');
    await service.createOrg('Org C', 'user_2');

    const userOrgs = await service.getUserOrgs('user_1');
    expect(userOrgs).toHaveLength(2);
    expect(userOrgs.map((o) => o.name).sort()).toEqual(['Org A', 'Org B']);

    const user2Orgs = await service.getUserOrgs('user_2');
    expect(user2Orgs).toHaveLength(1);
    expect(user2Orgs[0].name).toBe('Org C');
  });

  it('updateOrg updates the name', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Old Name', 'user_1');
    const updated = await service.updateOrg(org.id, 'New Name');
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('New Name');

    const notFound = await service.updateOrg('nonexistent', 'Nope');
    expect(notFound).toBeNull();
  });

  it('deleteOrg removes the org', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Doomed Org', 'user_1');
    const deleted = await service.deleteOrg(org.id);
    expect(deleted).toBe(true);

    const gone = await service.getOrg(org.id);
    expect(gone).toBeNull();

    const again = await service.deleteOrg(org.id);
    expect(again).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  it('getMembers returns members', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Team Org', 'user_owner');

    const memberList = await service.getMembers(org.id);
    expect(memberList).toHaveLength(1);
    expect(memberList[0].userId).toBe('user_owner');
    expect(memberList[0].role).toBe('owner');
  });

  it('getMembership returns membership or null', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Membership Org', 'user_owner');

    const found = await service.getMembership(org.id, 'user_owner');
    expect(found).not.toBeNull();
    expect(found!.role).toBe('owner');

    const missing = await service.getMembership(org.id, 'user_stranger');
    expect(missing).toBeNull();
  });

  it('removeMember removes member but not owner', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Remove Org', 'user_owner');

    // Cannot remove the owner
    const ownerRemoved = await service.removeMember(org.id, 'user_owner');
    expect(ownerRemoved).toBe(false);

    // Owner should still be there
    const ownerStillThere = await service.getMembership(org.id, 'user_owner');
    expect(ownerStillThere).not.toBeNull();

    // Accept an invitation to add a regular member, then remove them
    const invitation = await service.createInvitation(org.id, 'user_owner');
    await service.acceptInvitation(invitation.token, 'user_member');

    const memberExists = await service.getMembership(org.id, 'user_member');
    expect(memberExists).not.toBeNull();
    expect(memberExists!.role).toBe('member');

    const memberRemoved = await service.removeMember(org.id, 'user_member');
    expect(memberRemoved).toBe(true);

    const memberGone = await service.getMembership(org.id, 'user_member');
    expect(memberGone).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  it('createInvitation generates token with default single-use and 7-day expiry', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Invite Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');

    expect(invitation.id).toBeDefined();
    expect(invitation.orgId).toBe(org.id);
    expect(invitation.invitedBy).toBe('user_owner');
    expect(invitation.token).toBeDefined();
    expect(invitation.token.length).toBeGreaterThanOrEqual(20);
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

  it('acceptInvitation creates membership', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Accept Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');

    const member = await service.acceptInvitation(invitation.token, 'user_joiner');
    expect(member).not.toBeNull();
    expect(member!.orgId).toBe(org.id);
    expect(member!.userId).toBe('user_joiner');
    expect(member!.role).toBe('member');

    // Verify membership persists
    const membership = await service.getMembership(org.id, 'user_joiner');
    expect(membership).not.toBeNull();

    // Using the same token again should return null (already accepted)
    const again = await service.acceptInvitation(invitation.token, 'user_other');
    expect(again).toBeNull();
  });

  it('listInvitations returns pending invites', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('List Org', 'user_owner');
    await service.createInvitation(org.id, 'user_owner');
    await service.createInvitation(org.id, 'user_owner');

    const pending = await service.listInvitations(org.id);
    expect(pending).toHaveLength(2);
    expect(pending[0].orgId).toBe(org.id);
    expect(pending[0].acceptedBy).toBeNull();
  });

  it('revokeInvitation deletes invitation', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Revoke Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');

    const revoked = await service.revokeInvitation(invitation.id);
    expect(revoked).toBe(true);

    // Should no longer appear in pending list
    const pending = await service.listInvitations(org.id);
    expect(pending).toHaveLength(0);

    // Revoking again returns false
    const again = await service.revokeInvitation(invitation.id);
    expect(again).toBe(false);
  });

  // -------------------------------------------------------------------------
  // RBAC — Admin role
  // -------------------------------------------------------------------------

  /** Helper: create an org with an owner and add a member, then promote to admin. */
  async function setupWithAdmin(service: InstanceType<typeof OrgService>) {
    const org = await service.createOrg('Admin Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');
    await service.acceptInvitation(invitation.token, 'user_admin');
    await service.updateMemberRole(org.id, 'user_admin', 'admin');
    return org;
  }

  it('updateMemberRole promotes member to admin', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Role Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');
    await service.acceptInvitation(invitation.token, 'user_member');

    const updated = await service.updateMemberRole(org.id, 'user_member', 'admin');
    expect(updated).not.toBeNull();
    expect(updated!.role).toBe('admin');

    const membership = await service.getMembership(org.id, 'user_member');
    expect(membership!.role).toBe('admin');
  });

  it('updateMemberRole demotes admin to member', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await setupWithAdmin(service);

    const updated = await service.updateMemberRole(org.id, 'user_admin', 'member');
    expect(updated).not.toBeNull();
    expect(updated!.role).toBe('member');
  });

  it('updateMemberRole cannot change owner role', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Owner Protected Org', 'user_owner');
    const result = await service.updateMemberRole(org.id, 'user_owner', 'admin');
    expect(result).toBeNull();
  });

  it('updateMemberRole cannot promote to owner', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('No Promote Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');
    await service.acceptInvitation(invitation.token, 'user_member');

    const result = await service.updateMemberRole(org.id, 'user_member', 'owner');
    expect(result).toBeNull();
  });

  it('admin membership is correctly returned', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await setupWithAdmin(service);

    const membership = await service.getMembership(org.id, 'user_admin');
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('admin');
  });

  // -------------------------------------------------------------------------
  // Multi-use & custom expiry invitations
  // -------------------------------------------------------------------------

  it('single-use invite rejects second accept', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Single Use Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner');

    const member1 = await service.acceptInvitation(invitation.token, 'user_a');
    expect(member1).not.toBeNull();

    const member2 = await service.acceptInvitation(invitation.token, 'user_b');
    expect(member2).toBeNull();
  });

  it('multi-use invite allows up to maxUses accepts', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Multi Use Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner', { maxUses: 3 });

    expect(invitation.maxUses).toBe(3);
    expect(invitation.useCount).toBe(0);

    const m1 = await service.acceptInvitation(invitation.token, 'user_a');
    expect(m1).not.toBeNull();

    const m2 = await service.acceptInvitation(invitation.token, 'user_b');
    expect(m2).not.toBeNull();

    const m3 = await service.acceptInvitation(invitation.token, 'user_c');
    expect(m3).not.toBeNull();

    // 4th user should be rejected
    const m4 = await service.acceptInvitation(invitation.token, 'user_d');
    expect(m4).toBeNull();
  });

  it('unlimited invite (maxUses: null) allows multiple accepts', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Unlimited Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner', { maxUses: null });

    expect(invitation.maxUses).toBeNull();

    const m1 = await service.acceptInvitation(invitation.token, 'user_a');
    expect(m1).not.toBeNull();

    const m2 = await service.acceptInvitation(invitation.token, 'user_b');
    expect(m2).not.toBeNull();

    const m3 = await service.acceptInvitation(invitation.token, 'user_c');
    expect(m3).not.toBeNull();

    // Should still appear in pending list
    const pending = await service.listInvitations(org.id);
    expect(pending).toHaveLength(1);
  });

  it('custom expiresInHours sets correct expiration', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await service.createOrg('Custom Expiry Org', 'user_owner');
    const invitation = await service.createInvitation(org.id, 'user_owner', { expiresInHours: 24 });

    const expiresMs = new Date(invitation.expiresAt).getTime() - Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThan(oneDayMs - 5000);
    expect(expiresMs).toBeLessThanOrEqual(oneDayMs);
  });

  it('removeMember removes admin but not owner', async () => {
    const sql = createMockSql();
    const service = new OrgService(sql);

    const org = await setupWithAdmin(service);

    // Can remove admin
    const removed = await service.removeMember(org.id, 'user_admin');
    expect(removed).toBe(true);

    const gone = await service.getMembership(org.id, 'user_admin');
    expect(gone).toBeNull();

    // Still cannot remove owner
    const ownerRemoved = await service.removeMember(org.id, 'user_owner');
    expect(ownerRemoved).toBe(false);
  });
});
