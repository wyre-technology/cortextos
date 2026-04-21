/**
 * Shared types for the reseller (MSP Admin Console) package.
 *
 * See PRD: .taskmaster/docs/prd-msp-admin.md
 * Migrations: 002_reseller_tenancy_expand.sql, 003_reseller_members.sql
 */

/**
 * Roles recorded in `reseller_members.role`. These are scoped to a
 * `type=reseller` organization and are disjoint from the customer-side
 * `OrgRole` union (`owner` | `admin` | `member`).
 */
export type ResellerRole =
  | 'reseller_owner'
  | 'reseller_admin'
  | 'reseller_billing_viewer'
  | 'reseller_support_agent';

/**
 * Numeric rank for `ResellerRole`, used for "at-least" permission checks
 * (mirrors `ROLE_LEVEL` in org-service.ts).
 */
export const RESELLER_ROLE_LEVEL: Record<ResellerRole, number> = {
  reseller_owner: 4,
  reseller_admin: 3,
  reseller_billing_viewer: 2,
  reseller_support_agent: 1,
};

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
