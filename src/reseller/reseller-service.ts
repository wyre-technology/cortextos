/**
 * ResellerService — read access to `reseller_members`.
 *
 * This is deliberately the minimum surface needed by the MSP Admin Console
 * scaffold (task msp-admin#1). It does NOT try to replicate the full
 * MemberService / InvitationService shape from `src/org/` — invitation,
 * creation, and role-change flows land in later tasks.
 */

import type postgres from 'postgres';
import type { ResellerMember, ResellerRole } from './types.js';
import { RESELLER_ROLE_LEVEL } from './types.js';

interface ResellerMemberRow {
  id: string;
  reseller_org_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  joined_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const RESELLER_ROLES: readonly ResellerRole[] = [
  'reseller_owner',
  'reseller_admin',
  'reseller_billing_viewer',
  'reseller_support_agent',
];

function isResellerRole(value: string): value is ResellerRole {
  return (RESELLER_ROLES as readonly string[]).includes(value);
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowToMember(row: ResellerMemberRow): ResellerMember | null {
  if (!isResellerRole(row.role)) return null;
  const createdAt = toIso(row.created_at);
  const updatedAt = toIso(row.updated_at);
  if (createdAt === null || updatedAt === null) return null;
  return {
    id: row.id,
    resellerOrgId: row.reseller_org_id,
    userId: row.user_id,
    role: row.role,
    invitedBy: row.invited_by,
    joinedAt: toIso(row.joined_at),
    createdAt,
    updatedAt,
  };
}

export class ResellerService {
  constructor(private readonly sql: postgres.Sql) {}

  /**
   * Return all reseller-org memberships for a given user (identified by
   * Auth0 `sub`, which matches `users.id`). Memberships with an unknown role
   * value are filtered out defensively.
   */
  async getMembershipsForUser(userId: string): Promise<ResellerMember[]> {
    const rows = await this.sql<ResellerMemberRow[]>`
      SELECT id, reseller_org_id, user_id, role, invited_by, joined_at, created_at, updated_at
        FROM reseller_members
       WHERE user_id = ${userId}
    `;
    const members: ResellerMember[] = [];
    for (const row of rows) {
      const m = rowToMember(row);
      if (m) members.push(m);
    }
    return members;
  }

  /**
   * Return the user's membership in a specific reseller org, if any.
   */
  async getMembership(resellerOrgId: string, userId: string): Promise<ResellerMember | null> {
    const rows = await this.sql<ResellerMemberRow[]>`
      SELECT id, reseller_org_id, user_id, role, invited_by, joined_at, created_at, updated_at
        FROM reseller_members
       WHERE reseller_org_id = ${resellerOrgId}
         AND user_id = ${userId}
       LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rowToMember(rows[0]);
  }

  /**
   * True if `role` meets or exceeds `minRole` in the reseller role hierarchy.
   */
  roleAtLeast(role: ResellerRole, minRole: ResellerRole): boolean {
    return RESELLER_ROLE_LEVEL[role] >= RESELLER_ROLE_LEVEL[minRole];
  }
}
