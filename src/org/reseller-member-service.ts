import type postgres from 'postgres';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reseller-scoped roles from migrations/003_reseller_members.sql and PRD §5.2.
 * DISJOINT from org_members roles (owner/admin/member).
 */
export type ResellerRole =
  | 'reseller_owner'
  | 'reseller_admin'
  | 'reseller_billing_viewer'
  | 'reseller_support_agent';

export const RESELLER_ROLES: readonly ResellerRole[] = [
  'reseller_owner',
  'reseller_admin',
  'reseller_billing_viewer',
  'reseller_support_agent',
] as const;

export interface ResellerMember {
  id: string;
  resellerOrgId: string;
  userId: string;
  role: ResellerRole;
  invitedBy: string | null;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResellerMemberWithProfile extends ResellerMember {
  email: string | null;
  name: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}

interface ResellerMemberRow {
  id: string;
  reseller_org_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ResellerMemberJoinedRow extends ResellerMemberRow {
  email: string | null;
  name: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ResellerMemberErrorCode =
  | 'INSUFFICIENT_PERMISSION'
  | 'INVALID_ROLE'
  | 'LAST_OWNER_PROTECTION'
  | 'ACTOR_NOT_FOUND'
  | 'MEMBER_NOT_FOUND';

export class ResellerMemberError extends Error {
  public readonly code: ResellerMemberErrorCode;

  constructor(code: ResellerMemberErrorCode, message: string) {
    super(message);
    this.name = 'ResellerMemberError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Permission rules (§5.2 — "Manage reseller_members" row)
// ---------------------------------------------------------------------------

/**
 * Per §5.2 permission matrix:
 *   - reseller_owner:           manage ALL reseller member roles (including owner)
 *   - reseller_admin:           manage reseller_admin / _billing_viewer / _support_agent;
 *                               CANNOT touch reseller_owner rows, CANNOT elevate to owner
 *   - reseller_billing_viewer:  read-only
 *   - reseller_support_agent:   read-only (can only act on their own customer assignments)
 *
 * Returns true if `actorRole` is allowed to create/update/delete a member whose
 * role is `targetRole`. For updates, this must be called for BOTH the old role
 * and the new role (an admin cannot touch a current owner OR elevate to owner).
 */
function canActOnRole(actorRole: ResellerRole, targetRole: ResellerRole): boolean {
  if (actorRole === 'reseller_owner') return true;
  if (actorRole === 'reseller_admin') return targetRole !== 'reseller_owner';
  // billing_viewer and support_agent are read-only for member management
  return false;
}

function isValidRole(role: string): role is ResellerRole {
  return (RESELLER_ROLES as readonly string[]).includes(role);
}

function toMember(row: ResellerMemberRow): ResellerMember {
  return {
    id: row.id,
    resellerOrgId: row.reseller_org_id,
    userId: row.user_id,
    role: row.role as ResellerRole,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemberWithProfile(row: ResellerMemberJoinedRow): ResellerMemberWithProfile {
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
  const resolvedName = row.display_name || fullName || row.name;
  return {
    ...toMember(row),
    email: row.email,
    name: resolvedName,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ResellerMemberService {
  constructor(private sql: postgres.Sql) {}

  /**
   * Create a new reseller member.
   * @param resellerOrgId reseller organization id
   * @param userId user to add
   * @param role reseller role to assign
   * @param createdBy user id of the actor performing the creation
   * @throws ResellerMemberError(INVALID_ROLE) if role not in allowed set
   * @throws ResellerMemberError(ACTOR_NOT_FOUND) if createdBy has no membership in this reseller
   * @throws ResellerMemberError(INSUFFICIENT_PERMISSION) if actor lacks permission per §5.2
   */
  async create(
    resellerOrgId: string,
    userId: string,
    role: ResellerRole,
    createdBy: string,
  ): Promise<ResellerMember> {
    if (!isValidRole(role)) {
      throw new ResellerMemberError('INVALID_ROLE', `invalid reseller role: ${String(role)}`);
    }

    const actor = await this.getMembershipByUser(resellerOrgId, createdBy);
    if (!actor) {
      throw new ResellerMemberError(
        'ACTOR_NOT_FOUND',
        `actor ${createdBy} is not a member of reseller ${resellerOrgId}`,
      );
    }

    if (!canActOnRole(actor.role, role)) {
      throw new ResellerMemberError(
        'INSUFFICIENT_PERMISSION',
        `role ${actor.role} cannot create a member with role ${role}`,
      );
    }

    const id = nanoid();
    const rows = await this.sql<ResellerMemberRow[]>`
      INSERT INTO reseller_members (id, reseller_org_id, user_id, role, invited_by, joined_at)
      VALUES (${id}, ${resellerOrgId}, ${userId}, ${role}, ${createdBy}, NOW())
      RETURNING *
    `;
    return toMember(rows[0]);
  }

  /**
   * List all members of a reseller org, with user profile info joined where available.
   */
  async list(resellerOrgId: string): Promise<ResellerMemberWithProfile[]> {
    const rows = await this.sql<ResellerMemberJoinedRow[]>`
      SELECT m.*, u.email, u.name, u.display_name, u.first_name, u.last_name
      FROM reseller_members m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.reseller_org_id = ${resellerOrgId}
      ORDER BY m.created_at
    `;
    return rows.map((r) => toMemberWithProfile(r));
  }

  /**
   * Fetch a single reseller_member row by its id.
   */
  async getById(memberId: string): Promise<ResellerMember | null> {
    const rows = await this.sql<ResellerMemberRow[]>`
      SELECT * FROM reseller_members WHERE id = ${memberId}
    `;
    return rows[0] ? toMember(rows[0]) : null;
  }

  /**
   * Fetch a membership by user_id within a reseller org (used for actor lookup).
   */
  async getMembershipByUser(resellerOrgId: string, userId: string): Promise<ResellerMember | null> {
    const rows = await this.sql<ResellerMemberRow[]>`
      SELECT * FROM reseller_members
      WHERE reseller_org_id = ${resellerOrgId} AND user_id = ${userId}
    `;
    return rows[0] ? toMember(rows[0]) : null;
  }

  /**
   * Change a member's role.
   * Uses a transaction so the actor-authorization read and the UPDATE are atomic.
   *
   * Rules (§5.2):
   *   - Only reseller_owner may promote anyone to reseller_owner
   *   - Only reseller_owner may demote an existing reseller_owner
   *   - reseller_admin may shuffle admin/billing_viewer/support_agent roles
   *   - billing_viewer and support_agent cannot update anyone
   */
  async updateRole(
    memberId: string,
    newRole: ResellerRole,
    actorMemberId: string,
  ): Promise<ResellerMember> {
    if (!isValidRole(newRole)) {
      throw new ResellerMemberError('INVALID_ROLE', `invalid reseller role: ${String(newRole)}`);
    }

    return this.sql.begin(async (txAny) => {
      const tx = txAny as unknown as postgres.Sql<Record<string, unknown>>;
      const targetRows = await tx<ResellerMemberRow[]>`
        SELECT * FROM reseller_members WHERE id = ${memberId} FOR UPDATE
      `;
      if (!targetRows[0]) {
        throw new ResellerMemberError('MEMBER_NOT_FOUND', `member ${memberId} not found`);
      }
      const target = toMember(targetRows[0]);

      const actorRows = await tx<ResellerMemberRow[]>`
        SELECT * FROM reseller_members
        WHERE id = ${actorMemberId} AND reseller_org_id = ${target.resellerOrgId}
      `;
      if (!actorRows[0]) {
        throw new ResellerMemberError(
          'ACTOR_NOT_FOUND',
          `actor ${actorMemberId} not found in reseller ${target.resellerOrgId}`,
        );
      }
      const actor = toMember(actorRows[0]);

      if (!canActOnRole(actor.role, target.role) || !canActOnRole(actor.role, newRole)) {
        throw new ResellerMemberError(
          'INSUFFICIENT_PERMISSION',
          `role ${actor.role} cannot change a ${target.role} member to ${newRole}`,
        );
      }

      if (target.role === 'reseller_owner' && newRole !== 'reseller_owner') {
        const ownerCountRows = await tx<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM reseller_members
          WHERE reseller_org_id = ${target.resellerOrgId} AND role = 'reseller_owner'
        `;
        if ((ownerCountRows[0]?.count ?? 0) <= 1) {
          throw new ResellerMemberError(
            'LAST_OWNER_PROTECTION',
            'cannot demote the last reseller_owner',
          );
        }
      }

      const updated = await tx<ResellerMemberRow[]>`
        UPDATE reseller_members
        SET role = ${newRole}, updated_at = NOW()
        WHERE id = ${memberId}
        RETURNING *
      `;
      return toMember(updated[0]);
    }) as unknown as Promise<ResellerMember>;
  }

  /**
   * Delete a reseller member.
   * Uses a transaction so the last-owner check runs under the same snapshot as the delete.
   */
  async delete(memberId: string, actorMemberId: string): Promise<boolean> {
    return this.sql.begin(async (txAny) => {
      const tx = txAny as unknown as postgres.Sql<Record<string, unknown>>;
      const targetRows = await tx<ResellerMemberRow[]>`
        SELECT * FROM reseller_members WHERE id = ${memberId} FOR UPDATE
      `;
      if (!targetRows[0]) {
        throw new ResellerMemberError('MEMBER_NOT_FOUND', `member ${memberId} not found`);
      }
      const target = toMember(targetRows[0]);

      const actorRows = await tx<ResellerMemberRow[]>`
        SELECT * FROM reseller_members
        WHERE id = ${actorMemberId} AND reseller_org_id = ${target.resellerOrgId}
      `;
      if (!actorRows[0]) {
        throw new ResellerMemberError(
          'ACTOR_NOT_FOUND',
          `actor ${actorMemberId} not found in reseller ${target.resellerOrgId}`,
        );
      }
      const actor = toMember(actorRows[0]);

      if (!canActOnRole(actor.role, target.role)) {
        throw new ResellerMemberError(
          'INSUFFICIENT_PERMISSION',
          `role ${actor.role} cannot delete a ${target.role} member`,
        );
      }

      if (target.role === 'reseller_owner') {
        const ownerCountRows = await tx<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM reseller_members
          WHERE reseller_org_id = ${target.resellerOrgId} AND role = 'reseller_owner'
        `;
        if ((ownerCountRows[0]?.count ?? 0) <= 1) {
          throw new ResellerMemberError(
            'LAST_OWNER_PROTECTION',
            'cannot delete the last reseller_owner',
          );
        }
      }

      const result = await tx`
        DELETE FROM reseller_members WHERE id = ${memberId}
      `;
      return result.count > 0;
    }) as unknown as Promise<boolean>;
  }
}
