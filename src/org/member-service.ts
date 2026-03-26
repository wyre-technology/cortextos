import type postgres from 'postgres';
import type { OrgMember, OrgMemberWithProfile } from './org-service.js';

interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string | null;
  created_at: string;
}

function toMember(row: MemberRow): OrgMember {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role as 'owner' | 'member',
    joinedAt: row.joined_at,
    createdAt: row.created_at,
  };
}

export class MemberService {
  constructor(private sql: postgres.Sql) {}

  async getMembers(orgId: string): Promise<OrgMember[]> {
    const rows = await this.sql<MemberRow[]>`
      SELECT * FROM org_members WHERE org_id = ${orgId} ORDER BY created_at
    `;
    return rows.map((r) => toMember(r));
  }

  async getMembersWithProfiles(orgId: string): Promise<OrgMemberWithProfile[]> {
    const rows = await this.sql<(MemberRow & {
      email: string | null;
      name: string | null;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
    })[]>`
      SELECT m.*, u.email, u.name, u.display_name, u.first_name, u.last_name
      FROM org_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId}
      ORDER BY m.created_at
    `;
    return rows.map((r) => {
      const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ') || null;
      const resolvedName = r.display_name || fullName || r.name;
      return {
        ...toMember(r),
        email: r.email,
        name: resolvedName,
        displayName: r.display_name,
        firstName: r.first_name,
        lastName: r.last_name,
      };
    });
  }

  async getMembership(orgId: string, userId: string): Promise<OrgMember | null> {
    const rows = await this.sql<MemberRow[]>`
      SELECT * FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    return rows[0] ? toMember(rows[0]) : null;
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    // Don't allow removing the owner
    const membership = await this.getMembership(orgId, userId);
    if (!membership || membership.role === 'owner') {
      return false;
    }

    const result = await this.sql`
      DELETE FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    return result.count > 0;
  }
}
