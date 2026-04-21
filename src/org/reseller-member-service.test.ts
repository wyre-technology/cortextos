import { describe, it, expect, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
  ResellerMemberService,
  ResellerMemberError,
  type ResellerRole,
} from './reseller-member-service.js';

// ---------------------------------------------------------------------------
// Mock SQL
//
// Mimics postgres.js template-tag calls and sql.begin(async tx => ...) by
// storing rows in a Map. Each query branch matches a literal substring from
// the service's SQL.
// ---------------------------------------------------------------------------

interface MemberRecord {
  id: string;
  reseller_org_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
  email?: string | null;
  name?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

interface UserProfile {
  id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

function resultWithCount<T>(rows: T[], count: number): T[] & { count: number } {
  return Object.assign(rows, { count });
}

function createMockSql(
  members: Map<string, MemberRecord>,
  users: Map<string, UserProfile>,
) {
  const now = new Date().toISOString();

  const handler = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');

    // INSERT INTO reseller_members
    if (query.includes('INSERT INTO reseller_members')) {
      const id = values[0] as string;
      const resellerOrgId = values[1] as string;
      const userId = values[2] as string;
      const role = values[3] as string;
      const invitedBy = values[4] as string;
      const row: MemberRecord = {
        id,
        reseller_org_id: resellerOrgId,
        user_id: userId,
        role,
        invited_by: invitedBy,
        joined_at: now,
        created_at: now,
        updated_at: now,
      };
      members.set(id, row);
      return Promise.resolve([row]);
    }

    // SELECT with LEFT JOIN users (list)
    if (query.includes('LEFT JOIN users')) {
      const resellerOrgId = values[0] as string;
      const rows = [...members.values()]
        .filter((m) => m.reseller_org_id === resellerOrgId)
        .map((m) => {
          const u = users.get(m.user_id);
          return {
            ...m,
            email: u?.email ?? null,
            name: u?.name ?? null,
            display_name: u?.display_name ?? null,
            first_name: u?.first_name ?? null,
            last_name: u?.last_name ?? null,
          };
        });
      return Promise.resolve(rows);
    }

    // SELECT by id (both with and without FOR UPDATE)
    if (
      query.includes('SELECT * FROM reseller_members WHERE id =') &&
      !query.includes('reseller_org_id')
    ) {
      const id = values[0] as string;
      const row = members.get(id);
      return Promise.resolve(row ? [row] : []);
    }

    // SELECT by id AND reseller_org_id (actor lookup in tx)
    if (
      query.includes('WHERE id =') &&
      query.includes('AND reseller_org_id =')
    ) {
      const id = values[0] as string;
      const resellerOrgId = values[1] as string;
      const row = members.get(id);
      if (row && row.reseller_org_id === resellerOrgId) {
        return Promise.resolve([row]);
      }
      return Promise.resolve([]);
    }

    // SELECT by reseller_org_id AND user_id (getMembershipByUser)
    if (
      query.includes('WHERE reseller_org_id =') &&
      query.includes('AND user_id =')
    ) {
      const resellerOrgId = values[0] as string;
      const userId = values[1] as string;
      const row = [...members.values()].find(
        (m) => m.reseller_org_id === resellerOrgId && m.user_id === userId,
      );
      return Promise.resolve(row ? [row] : []);
    }

    // COUNT owners
    if (query.includes("COUNT(*)") && query.includes("'reseller_owner'")) {
      const resellerOrgId = values[0] as string;
      const count = [...members.values()].filter(
        (m) => m.reseller_org_id === resellerOrgId && m.role === 'reseller_owner',
      ).length;
      return Promise.resolve([{ count }]);
    }

    // UPDATE role
    if (query.includes('UPDATE reseller_members') && query.includes('SET role =')) {
      const newRole = values[0] as string;
      const id = values[1] as string;
      const existing = members.get(id);
      if (!existing) return Promise.resolve([]);
      const updated: MemberRecord = { ...existing, role: newRole, updated_at: now };
      members.set(id, updated);
      return Promise.resolve([updated]);
    }

    // DELETE
    if (query.includes('DELETE FROM reseller_members')) {
      const id = values[0] as string;
      const existed = members.delete(id);
      return Promise.resolve(resultWithCount<MemberRecord>([], existed ? 1 : 0));
    }

    throw new Error(`Unhandled mock SQL query: ${query}`);
  };

  // sql.begin: execute the transaction callback with `tx` === handler
  (handler as unknown as { begin: unknown }).begin = async <T>(
    fn: (tx: typeof handler) => Promise<T>,
  ): Promise<T> => fn(handler);

  return handler as unknown as postgres.Sql;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RESELLER_ID = 'reseller_1';
const ALL_ROLES: ResellerRole[] = [
  'reseller_owner',
  'reseller_admin',
  'reseller_billing_viewer',
  'reseller_support_agent',
];

function makeRow(
  id: string,
  userId: string,
  role: ResellerRole,
  resellerOrgId: string = RESELLER_ID,
): MemberRecord {
  const now = new Date().toISOString();
  return {
    id,
    reseller_org_id: resellerOrgId,
    user_id: userId,
    role,
    invited_by: null,
    joined_at: now,
    created_at: now,
    updated_at: now,
  };
}

interface Ctx {
  service: ResellerMemberService;
  members: Map<string, MemberRecord>;
  users: Map<string, UserProfile>;
  actorIds: Record<ResellerRole, string>;
}

function setup(): Ctx {
  const members = new Map<string, MemberRecord>();
  const users = new Map<string, UserProfile>();

  // Pre-seed one member per role plus a second owner (so last-owner logic
  // doesn't fire on every test).
  const actorIds: Record<ResellerRole, string> = {
    reseller_owner: 'm_owner',
    reseller_admin: 'm_admin',
    reseller_billing_viewer: 'm_billing',
    reseller_support_agent: 'm_support',
  };

  for (const role of ALL_ROLES) {
    const id = actorIds[role];
    members.set(id, makeRow(id, `u_${role}`, role));
  }
  // Second owner for tests that need > 1 owner
  members.set('m_owner2', makeRow('m_owner2', 'u_owner2', 'reseller_owner'));

  users.set('u_reseller_owner', {
    id: 'u_reseller_owner',
    email: 'owner@example.com',
    name: 'Owner',
    display_name: null,
    first_name: 'O',
    last_name: 'Wner',
  });

  const sql = createMockSql(members, users);
  const service = new ResellerMemberService(sql);
  return { service, members, users, actorIds };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResellerMemberService', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  // -------------------------------------------------------------------------
  // create() — 4 roles x allowed targets
  // -------------------------------------------------------------------------
  describe('create()', () => {
    it('rejects an invalid role string', async () => {
      await expect(
        ctx.service.create(
          RESELLER_ID,
          'new_user',
          'not_a_role' as unknown as ResellerRole,
          'u_reseller_owner',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    });

    it('rejects an actor that is not a member', async () => {
      await expect(
        ctx.service.create(RESELLER_ID, 'new_user', 'reseller_admin', 'stranger'),
      ).rejects.toMatchObject({ code: 'ACTOR_NOT_FOUND' });
    });

    it('reseller_owner can create every role (including owner)', async () => {
      for (const role of ALL_ROLES) {
        const m = await ctx.service.create(
          RESELLER_ID,
          `newbie_${role}`,
          role,
          'u_reseller_owner',
        );
        expect(m.role).toBe(role);
      }
    });

    it('reseller_admin can create admin/billing_viewer/support_agent', async () => {
      for (const role of ['reseller_admin', 'reseller_billing_viewer', 'reseller_support_agent'] as ResellerRole[]) {
        const m = await ctx.service.create(RESELLER_ID, `u_new_${role}`, role, 'u_reseller_admin');
        expect(m.role).toBe(role);
      }
    });

    it('reseller_admin cannot create a reseller_owner', async () => {
      await expect(
        ctx.service.create(RESELLER_ID, 'escalated', 'reseller_owner', 'u_reseller_admin'),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });

    it('reseller_billing_viewer cannot create any role', async () => {
      for (const role of ALL_ROLES) {
        await expect(
          ctx.service.create(RESELLER_ID, `x_${role}`, role, 'u_reseller_billing_viewer'),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
      }
    });

    it('reseller_support_agent cannot create any role', async () => {
      for (const role of ALL_ROLES) {
        await expect(
          ctx.service.create(RESELLER_ID, `y_${role}`, role, 'u_reseller_support_agent'),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
      }
    });
  });

  // -------------------------------------------------------------------------
  // list() — all roles can read
  // -------------------------------------------------------------------------
  describe('list()', () => {
    it('returns all members for the reseller with profile fields present', async () => {
      const rows = await ctx.service.list(RESELLER_ID);
      expect(rows).toHaveLength(5); // 4 seeded + 1 second owner
      const roles = rows.map((r) => r.role).sort();
      expect(roles).toEqual(
        [
          'reseller_admin',
          'reseller_billing_viewer',
          'reseller_owner',
          'reseller_owner',
          'reseller_support_agent',
        ].sort(),
      );
      for (const r of rows) {
        // Profile fields are always populated on the result (null-or-value)
        expect(r).toHaveProperty('email');
        expect(r).toHaveProperty('name');
      }
    });

    it('returns an empty array for an unknown reseller', async () => {
      const rows = await ctx.service.list('nope');
      expect(rows).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // updateRole() — permission matrix + last-owner protection
  // -------------------------------------------------------------------------
  describe('updateRole()', () => {
    it('rejects invalid new role', async () => {
      await expect(
        ctx.service.updateRole(
          ctx.actorIds.reseller_admin,
          'bogus' as unknown as ResellerRole,
          ctx.actorIds.reseller_owner,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    });

    it('rejects when member not found', async () => {
      await expect(
        ctx.service.updateRole('nope', 'reseller_admin', ctx.actorIds.reseller_owner),
      ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    });

    it('reseller_owner can promote an admin to owner', async () => {
      const updated = await ctx.service.updateRole(
        ctx.actorIds.reseller_admin,
        'reseller_owner',
        ctx.actorIds.reseller_owner,
      );
      expect(updated.role).toBe('reseller_owner');
    });

    it('reseller_owner can demote another owner when >1 owner exists', async () => {
      const updated = await ctx.service.updateRole(
        'm_owner2',
        'reseller_admin',
        ctx.actorIds.reseller_owner,
      );
      expect(updated.role).toBe('reseller_admin');
    });

    it('blocks demoting the LAST reseller_owner (LAST_OWNER_PROTECTION)', async () => {
      // Remove the secondary owner first, then try to demote the remaining one.
      ctx.members.delete('m_owner2');
      await expect(
        ctx.service.updateRole(
          ctx.actorIds.reseller_owner,
          'reseller_admin',
          ctx.actorIds.reseller_owner,
        ),
      ).rejects.toMatchObject({ code: 'LAST_OWNER_PROTECTION' });
    });

    it('reseller_admin cannot touch a reseller_owner', async () => {
      await expect(
        ctx.service.updateRole(
          ctx.actorIds.reseller_owner,
          'reseller_admin',
          ctx.actorIds.reseller_admin,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });

    it('reseller_admin cannot elevate anyone to reseller_owner', async () => {
      await expect(
        ctx.service.updateRole(
          ctx.actorIds.reseller_billing_viewer,
          'reseller_owner',
          ctx.actorIds.reseller_admin,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });

    it('reseller_admin can change billing_viewer -> support_agent', async () => {
      const updated = await ctx.service.updateRole(
        ctx.actorIds.reseller_billing_viewer,
        'reseller_support_agent',
        ctx.actorIds.reseller_admin,
      );
      expect(updated.role).toBe('reseller_support_agent');
    });

    it('reseller_billing_viewer cannot update anyone', async () => {
      await expect(
        ctx.service.updateRole(
          ctx.actorIds.reseller_support_agent,
          'reseller_admin',
          ctx.actorIds.reseller_billing_viewer,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });

    it('reseller_support_agent cannot update anyone', async () => {
      await expect(
        ctx.service.updateRole(
          ctx.actorIds.reseller_billing_viewer,
          'reseller_admin',
          ctx.actorIds.reseller_support_agent,
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });
  });

  // -------------------------------------------------------------------------
  // delete() — permission matrix + last-owner protection
  // -------------------------------------------------------------------------
  describe('delete()', () => {
    it('rejects when member not found', async () => {
      await expect(
        ctx.service.delete('nope', ctx.actorIds.reseller_owner),
      ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    });

    it('reseller_owner can delete another owner when >1 owner exists', async () => {
      const ok = await ctx.service.delete('m_owner2', ctx.actorIds.reseller_owner);
      expect(ok).toBe(true);
      expect(ctx.members.has('m_owner2')).toBe(false);
    });

    it('blocks deleting the LAST reseller_owner', async () => {
      ctx.members.delete('m_owner2');
      await expect(
        ctx.service.delete(ctx.actorIds.reseller_owner, ctx.actorIds.reseller_owner),
      ).rejects.toMatchObject({ code: 'LAST_OWNER_PROTECTION' });
    });

    it('reseller_admin cannot delete a reseller_owner', async () => {
      await expect(
        ctx.service.delete(ctx.actorIds.reseller_owner, ctx.actorIds.reseller_admin),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });

    it('reseller_admin can delete admin/billing_viewer/support_agent', async () => {
      for (const id of [
        ctx.actorIds.reseller_billing_viewer,
        ctx.actorIds.reseller_support_agent,
      ]) {
        const ok = await ctx.service.delete(id, ctx.actorIds.reseller_admin);
        expect(ok).toBe(true);
      }
    });

    it('reseller_billing_viewer cannot delete anyone', async () => {
      await expect(
        ctx.service.delete(ctx.actorIds.reseller_support_agent, ctx.actorIds.reseller_billing_viewer),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });

    it('reseller_support_agent cannot delete anyone', async () => {
      await expect(
        ctx.service.delete(ctx.actorIds.reseller_billing_viewer, ctx.actorIds.reseller_support_agent),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    });
  });

  // -------------------------------------------------------------------------
  // Error class shape
  // -------------------------------------------------------------------------
  describe('ResellerMemberError', () => {
    it('exposes name and code', () => {
      const e = new ResellerMemberError('INVALID_ROLE', 'x');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('ResellerMemberError');
      expect(e.code).toBe('INVALID_ROLE');
    });
  });
});
