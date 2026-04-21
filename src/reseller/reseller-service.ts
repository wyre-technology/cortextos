/**
 * ResellerService — read access to `reseller_members` and reseller-scoped
 * organization lookups for the MSP Admin Console.
 *
 * Membership-gated lookups (`getResellerOr404`, `listCustomers`,
 * `getCustomerOr404`) back the `/admin/reseller/*` console and deliberately
 * surface a single `NOT_FOUND` error code to external callers to avoid
 * disclosing whether a reseller org or customer exists when the caller
 * lacks access.
 */

import type postgres from 'postgres';
import type { OrgService, Organization } from '../org/org-service.js';
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

/**
 * A typed view of an `Organization` guaranteed to be `type='reseller'`.
 * Exposed separately from `Organization` so callers can encode the invariant
 * in their own signatures.
 */
export type ResellerOrg = Organization & { type: 'reseller' };

/**
 * Error codes for membership-gated reseller lookups.
 *
 * External callers (HTTP handlers) should translate any of these to a generic
 * `NOT_FOUND` / 404 response — distinguishing `NOT_A_MEMBER` from the org
 * simply not existing would let a caller probe for the existence of reseller
 * orgs and customers. The finer-grained codes are retained internally for
 * logging and debugging.
 */
export type ResellerAccessErrorCode = 'NOT_FOUND' | 'NOT_A_RESELLER' | 'NOT_A_MEMBER';

export class ResellerAccessError extends Error {
  public readonly code: ResellerAccessErrorCode;

  constructor(code: ResellerAccessErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ResellerAccessError';
    this.code = code;
  }
}

export class ResellerService {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly orgService: OrgService,
  ) {}

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

  /**
   * Resolve a reseller org by id, validating that the caller has a membership
   * row and that the org actually has `type='reseller'`.
   *
   * Throws `ResellerAccessError` for every failure mode. Callers converting
   * this to HTTP should always surface `404 NOT_FOUND` regardless of the
   * internal code, to avoid leaking membership existence.
   */
  async getResellerOr404(resellerId: string, userId: string): Promise<ResellerOrg> {
    const membership = await this.getMembership(resellerId, userId);
    if (!membership) {
      throw new ResellerAccessError('NOT_A_MEMBER');
    }
    const org = await this.orgService.getOrg(resellerId);
    if (!org) {
      throw new ResellerAccessError('NOT_FOUND');
    }
    if (org.type !== 'reseller') {
      throw new ResellerAccessError('NOT_A_RESELLER');
    }
    return org as ResellerOrg;
  }

  /**
   * List customer orgs directly parented to `resellerId`. Thin wrapper over
   * `OrgService.getCustomersOfReseller` to keep the reseller-service surface
   * self-contained for route handlers.
   *
   * Does NOT validate membership — callers should have already gone through
   * `getResellerOr404` (or equivalent middleware) before reaching here.
   */
  async listCustomers(resellerId: string): Promise<Organization[]> {
    return this.orgService.getCustomersOfReseller(resellerId);
  }

  /**
   * Resolve a customer org by id, validating that it exists, has
   * `type='customer'`, and is parented to `resellerId`. Throws
   * `ResellerAccessError('NOT_FOUND')` for every failure mode.
   */
  async getCustomerOr404(resellerId: string, customerId: string): Promise<Organization> {
    const org = await this.orgService.getOrg(customerId);
    if (!org) throw new ResellerAccessError('NOT_FOUND');
    if (org.type !== 'customer') throw new ResellerAccessError('NOT_FOUND');
    if (org.parentOrgId !== resellerId) throw new ResellerAccessError('NOT_FOUND');
    return org;
  }
}
