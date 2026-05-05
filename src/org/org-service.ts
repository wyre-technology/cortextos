import type postgres from 'postgres';
import { nanoid } from 'nanoid';
import type { PlanSlug } from '../billing/plan-catalog.js';
import { MemberService } from './member-service.js';
import { InvitationService } from './invitation-service.js';
import { ToolAllowlistService } from './tool-allowlist-service.js';
import { TeamService } from './team-service.js';
import type { OrgTeam, OrgTeamMember, OrgTeamServerAccess, OrgTeamWithMembers } from './team-service.js';
export type { OrgTeam, OrgTeamMember, OrgTeamServerAccess, OrgTeamWithMembers };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrgType = 'standalone' | 'reseller' | 'customer';

export const ORG_TYPES: readonly OrgType[] = ['standalone', 'reseller', 'customer'] as const;

export interface Organization {
  id: string;
  name: string;
  ownerId: string;
  plan: PlanSlug;
  defaultServerAccess: 'none' | 'all';
  promptCaptureEnabled: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  type: OrgType;
  parentOrgId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgOptions {
  type?: OrgType;
  parentOrgId?: string | null;
}

export type OrgHierarchyErrorCode =
  | 'CUSTOMER_REQUIRES_PARENT'
  | 'STANDALONE_CANNOT_HAVE_PARENT'
  | 'RESELLER_CANNOT_HAVE_PARENT'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_NOT_RESELLER'
  | 'INVALID_ORG_TYPE';

export class OrgHierarchyError extends Error {
  public readonly code: OrgHierarchyErrorCode;

  constructor(code: OrgHierarchyErrorCode, message: string) {
    super(message);
    this.name = 'OrgHierarchyError';
    this.code = code;
  }
}

export interface OrgServerAccess {
  id: string;
  orgId: string;
  userId: string;
  vendorSlug: string;
  grantedBy: string;
  grantedAt: string;
}

export type OrgRole = 'owner' | 'admin' | 'member';

export const ROLE_LEVEL: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string | null;
  createdAt: string;
}

export interface OrgMemberWithProfile extends OrgMember {
  email: string | null;
  name: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface OrgInvitation {
  id: string;
  orgId: string;
  invitedBy: string;
  token: string;
  expiresAt: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
}

export interface ServiceClient {
  id: string;
  orgId: string;
  name: string;
  clientId: string;
  clientSecretHash: string;
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface ServiceClientRow {
  id: string;
  org_id: string;
  name: string;
  client_id: string;
  client_secret_hash: string;
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// Raw row shapes from PostgreSQL
interface OrgRow {
  id: string;
  name: string;
  owner_id: string;
  plan: string;
  default_server_access: string;
  prompt_capture_enabled: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  type: string | null;
  parent_org_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ServerAccessRow {
  id: string;
  org_id: string;
  user_id: string;
  vendor_slug: string;
  granted_by: string;
  granted_at: string;
}

interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string | null;
  created_at: string;
}



// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OrgService {
  private memberService: MemberService;
  private invitationService: InvitationService;
  private toolAllowlistService: ToolAllowlistService;
  private teamService: TeamService;

  constructor(private sql: postgres.Sql) {
    this.memberService = new MemberService(sql);
    this.invitationService = new InvitationService(sql, this.memberService);
    this.toolAllowlistService = new ToolAllowlistService(sql);
    this.teamService = new TeamService(sql);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async initTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS organizations (
        id                     TEXT PRIMARY KEY,
        name                   TEXT NOT NULL,
        owner_id               TEXT NOT NULL REFERENCES users(id),
        plan                   TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS org_members (
        id          TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id),
        role        TEXT NOT NULL DEFAULT 'member',
        joined_at   TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, user_id)
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id)
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS org_credentials (
        id              TEXT PRIMARY KEY,
        org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vendor_slug     TEXT NOT NULL,
        encrypted_data  TEXT NOT NULL,
        iv              TEXT NOT NULL,
        auth_tag        TEXT NOT NULL,
        salt            TEXT NOT NULL,
        created_by      TEXT NOT NULL REFERENCES users(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, vendor_slug)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS org_invitations (
        id          TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        invited_by  TEXT NOT NULL REFERENCES users(id),
        token       TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        accepted_by TEXT REFERENCES users(id),
        accepted_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token)
    `;

    // Migration: add max_uses and use_count columns to org_invitations
    await this.sql`
      ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS max_uses INTEGER DEFAULT 1
    `;
    await this.sql`
      ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0
    `;

    // Migration 011: SHA-256 hash-at-rest for invitation tokens (PRD §7.1, §8.4).
    // Dual-write phase — the plaintext `token` column is retained for rollback
    // safety. A follow-up migration drops it once all outstanding invitations
    // have aged out and lookups are hash-only.
    await this.sql`
      ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS token_hash TEXT
    `;
    await this.sql`
      ALTER TABLE org_invitations
        ADD COLUMN IF NOT EXISTS token_hash_algo TEXT NOT NULL DEFAULT 'sha256'
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_invitations_token_hash
        ON org_invitations (token_hash)
        WHERE token_hash IS NOT NULL
    `;

    // Migration: allow 'admin' role in org_members
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
        ALTER TABLE org_members ADD CONSTRAINT org_members_role_check CHECK (role IN ('owner', 'admin', 'member'));
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS request_log (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL,
        org_id           TEXT,
        vendor_slug      TEXT NOT NULL,
        tool_name        TEXT,
        status_code      INTEGER NOT NULL,
        response_time_ms INTEGER,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_request_log_user ON request_log(user_id, created_at)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_request_log_org ON request_log(org_id, created_at)
    `;

    // Migration: prompt capture columns on request_log
    await this.sql`ALTER TABLE request_log ADD COLUMN IF NOT EXISTS tool_arguments JSONB`;
    await this.sql`ALTER TABLE request_log ADD COLUMN IF NOT EXISTS prompt_context TEXT`;
    await this.sql`ALTER TABLE request_log ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'mcp'`;

    // Migration: prompt capture org setting
    await this.sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS prompt_capture_enabled BOOLEAN DEFAULT false`;

    await this.sql`
      CREATE TABLE IF NOT EXISTS org_tool_allowlist (
        id          TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        vendor_slug TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        tool_name   TEXT NOT NULL,
        granted_by  TEXT NOT NULL REFERENCES users(id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, vendor_slug, role, tool_name)
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_tool_allowlist_lookup
        ON org_tool_allowlist(org_id, vendor_slug, role)
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id         TEXT PRIMARY KEY,
        org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_id   TEXT NOT NULL,
        target_id  TEXT,
        event_type TEXT NOT NULL,
        metadata   JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_org ON admin_audit_log(org_id, created_at)
    `;

    // Server access control
    await this.sql`
      CREATE TABLE IF NOT EXISTS org_server_access (
        id          TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vendor_slug TEXT NOT NULL,
        granted_by  TEXT NOT NULL REFERENCES users(id),
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, user_id, vendor_slug)
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_server_access_lookup ON org_server_access(org_id, user_id)
    `;

    // Migration: add default_server_access column
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_server_access TEXT NOT NULL DEFAULT 'none';
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$
    `;

    // Service clients for M2M / AI agent access
    await this.sql`
      CREATE TABLE IF NOT EXISTS service_clients (
        id                 TEXT PRIMARY KEY,
        org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        client_id          TEXT NOT NULL UNIQUE,
        client_secret_hash TEXT NOT NULL,
        created_by         TEXT NOT NULL REFERENCES users(id),
        last_used_at       TIMESTAMPTZ,
        expires_at         TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_service_clients_org ON service_clients(org_id)
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_service_clients_client_id ON service_clients(client_id)
    `;

    // Team tables
    await this.teamService.initTables();
  }

  // -------------------------------------------------------------------------
  // Row mapping
  // -------------------------------------------------------------------------

  private toOrg(row: OrgRow): Organization {
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      plan: row.plan as PlanSlug,
      defaultServerAccess: (row.default_server_access as 'none' | 'all') || 'none',
      promptCaptureEnabled: row.prompt_capture_enabled ?? false,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      type: (row.type as OrgType | null) ?? 'standalone',
      parentOrgId: row.parent_org_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toServerAccess(row: ServerAccessRow): OrgServerAccess {
    return {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      vendorSlug: row.vendor_slug,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    };
  }

  private toMember(row: MemberRow): OrgMember {
    return {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      role: row.role as OrgRole,
      joinedAt: row.joined_at,
      createdAt: row.created_at,
    };
  }



  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------

  async createOrg(
    name: string,
    ownerId: string,
    plan?: PlanSlug,
    options?: CreateOrgOptions,
  ): Promise<Organization> {
    const orgId = nanoid();
    const memberId = nanoid();
    const orgPlan = plan ?? 'free';
    const orgType: OrgType = options?.type ?? 'standalone';
    const parentOrgId: string | null = options?.parentOrgId ?? null;

    // --- Service-layer hierarchy validation (runs BEFORE the DB trigger fires).
    //     Mirrors migrations/002_reseller_tenancy_expand.sql invariants so we
    //     surface a typed error with a clear message instead of a raw DB error.
    if (!(ORG_TYPES as readonly string[]).includes(orgType)) {
      throw new OrgHierarchyError(
        'INVALID_ORG_TYPE',
        `invalid organizations.type: ${String(orgType)}`,
      );
    }

    if (orgType === 'customer') {
      if (!parentOrgId) {
        throw new OrgHierarchyError(
          'CUSTOMER_REQUIRES_PARENT',
          'customer orgs must have parent_org_id pointing at a reseller',
        );
      }
      const parent = await this.getOrg(parentOrgId);
      if (!parent) {
        throw new OrgHierarchyError(
          'PARENT_NOT_FOUND',
          `parent_org_id ${parentOrgId} does not exist`,
        );
      }
      if (parent.type !== 'reseller') {
        throw new OrgHierarchyError(
          'PARENT_NOT_RESELLER',
          `customer parent must be a reseller (got ${parent.type})`,
        );
      }
    } else if (orgType === 'standalone') {
      if (parentOrgId !== null) {
        throw new OrgHierarchyError(
          'STANDALONE_CANNOT_HAVE_PARENT',
          'standalone orgs cannot have a parent_org_id',
        );
      }
    } else if (orgType === 'reseller') {
      if (parentOrgId !== null) {
        throw new OrgHierarchyError(
          'RESELLER_CANNOT_HAVE_PARENT',
          'reseller orgs cannot have a parent_org_id',
        );
      }
    }

    const rows = await this.sql<OrgRow[]>`
      INSERT INTO organizations (id, name, owner_id, plan, type, parent_org_id)
      VALUES (${orgId}, ${name}, ${ownerId}, ${orgPlan}, ${orgType}, ${parentOrgId})
      RETURNING *
    `;

    // Add owner as first member
    await this.sql`
      INSERT INTO org_members (id, org_id, user_id, role, joined_at)
      VALUES (${memberId}, ${orgId}, ${ownerId}, 'owner', NOW())
    `;

    return this.toOrg(rows[0]);
  }

  // -------------------------------------------------------------------------
  // Reseller hierarchy helpers (PRD §5.1)
  // -------------------------------------------------------------------------

  /**
   * Returns true if the organization exists and has type = 'reseller'.
   */
  async isReseller(orgId: string): Promise<boolean> {
    const rows = await this.sql<{ type: string }[]>`
      SELECT type FROM organizations WHERE id = ${orgId}
    `;
    return rows[0]?.type === 'reseller';
  }

  /**
   * List customer orgs directly parented to the given reseller org.
   * Excludes standalone orgs and any nested descendants (hierarchy is capped
   * at depth 2 by the trigger, so a single parent_org_id check is sufficient).
   */
  async getCustomersOfReseller(resellerOrgId: string): Promise<Organization[]> {
    const rows = await this.sql<OrgRow[]>`
      SELECT * FROM organizations
      WHERE parent_org_id = ${resellerOrgId}
        AND type = 'customer'
      ORDER BY created_at
    `;
    return rows.map((r) => this.toOrg(r));
  }

  /**
   * Fetch the parent reseller of a customer org. Returns null when the org
   * has no parent (standalone or reseller at the top of the tree).
   */
  async getResellerOfCustomer(customerOrgId: string): Promise<Organization | null> {
    const rows = await this.sql<OrgRow[]>`
      SELECT parent.*
      FROM organizations child
      JOIN organizations parent ON parent.id = child.parent_org_id
      WHERE child.id = ${customerOrgId}
    `;
    return rows[0] ? this.toOrg(rows[0]) : null;
  }

  async getOrg(orgId: string): Promise<Organization | null> {
    const rows = await this.sql<OrgRow[]>`
      SELECT * FROM organizations WHERE id = ${orgId}
    `;
    return rows[0] ? this.toOrg(rows[0]) : null;
  }

  async getUserOrgs(userId: string): Promise<Organization[]> {
    const rows = await this.sql<OrgRow[]>`
      SELECT o.* FROM organizations o
      JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = ${userId}
      ORDER BY o.created_at
    `;
    return rows.map((r) => this.toOrg(r));
  }

  async updateOrg(orgId: string, name: string): Promise<Organization | null> {
    const rows = await this.sql<OrgRow[]>`
      UPDATE organizations SET name = ${name}, updated_at = NOW()
      WHERE id = ${orgId}
      RETURNING *
    `;
    return rows[0] ? this.toOrg(rows[0]) : null;
  }

  async deleteOrg(orgId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM organizations WHERE id = ${orgId}
    `;
    return result.count > 0;
  }

  async updateOrgPlan(
    orgId: string,
    plan: PlanSlug,
    stripeCustomerId?: string,
    stripeSubscriptionId?: string,
  ): Promise<void> {
    await this.sql`
      UPDATE organizations SET
        plan = ${plan},
        stripe_customer_id = ${stripeCustomerId ?? null},
        stripe_subscription_id = ${stripeSubscriptionId ?? null},
        updated_at = NOW()
      WHERE id = ${orgId}
    `;
  }

  // -------------------------------------------------------------------------
  // Memberships (delegated to MemberService)
  // -------------------------------------------------------------------------

  getMembers(orgId: string) { return this.memberService.getMembers(orgId); }
  getMembersWithProfiles(orgId: string) { return this.memberService.getMembersWithProfiles(orgId); }
  getMembership(orgId: string, userId: string) { return this.memberService.getMembership(orgId, userId); }
  removeMember(orgId: string, userId: string) { return this.memberService.removeMember(orgId, userId); }

  async updateMemberRole(orgId: string, userId: string, newRole: OrgRole): Promise<OrgMember | null> {
    if (newRole === 'owner') {
      return null; // Cannot promote to owner
    }

    const membership = await this.getMembership(orgId, userId);
    if (!membership || membership.role === 'owner') {
      return null; // Cannot change owner's role
    }

    const rows = await this.sql<MemberRow[]>`
      UPDATE org_members SET role = ${newRole}
      WHERE org_id = ${orgId} AND user_id = ${userId}
      RETURNING *
    `;
    return rows[0] ? this.toMember(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // Invitations (delegated to InvitationService)
  // -------------------------------------------------------------------------

  createInvitation(orgId: string, invitedBy: string, options?: { maxUses?: number | null; expiresInHours?: number }) { return this.invitationService.createInvitation(orgId, invitedBy, options); }
  getInvitationByToken(token: string) { return this.invitationService.getInvitationByToken(token); }
  acceptInvitation(token: string, userId: string) { return this.invitationService.acceptInvitation(token, userId); }
  listInvitations(orgId: string) { return this.invitationService.listInvitations(orgId); }
  revokeInvitation(invitationId: string) { return this.invitationService.revokeInvitation(invitationId); }

  // -------------------------------------------------------------------------
  // Tool allowlist (delegated to ToolAllowlistService)
  // -------------------------------------------------------------------------

  getToolAllowlist(orgId: string, vendorSlug: string, role: string) { return this.toolAllowlistService.getToolAllowlist(orgId, vendorSlug, role); }
  setToolAllowlist(orgId: string, vendorSlug: string, role: string, toolNames: string[], grantedBy: string) { return this.toolAllowlistService.setToolAllowlist(orgId, vendorSlug, role, toolNames, grantedBy); }
  clearToolAllowlist(orgId: string, vendorSlug: string, role: string) { return this.toolAllowlistService.clearToolAllowlist(orgId, vendorSlug, role); }
  getAllToolAllowlists(orgId: string, vendorSlug: string) { return this.toolAllowlistService.getAllToolAllowlists(orgId, vendorSlug); }

  // -------------------------------------------------------------------------
  // Org settings
  // -------------------------------------------------------------------------

  async updateOrgSettings(orgId: string, settings: { defaultServerAccess?: 'none' | 'all' }): Promise<Organization | null> {
    if (settings.defaultServerAccess) {
      const rows = await this.sql<OrgRow[]>`
        UPDATE organizations SET default_server_access = ${settings.defaultServerAccess}, updated_at = NOW()
        WHERE id = ${orgId}
        RETURNING *
      `;
      return rows[0] ? this.toOrg(rows[0]) : null;
    }
    return this.getOrg(orgId);
  }

  // -------------------------------------------------------------------------
  // Server access control
  // -------------------------------------------------------------------------

  async grantServerAccess(orgId: string, userId: string, vendorSlug: string, grantedBy: string): Promise<OrgServerAccess | null> {
    const id = nanoid();
    const rows = await this.sql<ServerAccessRow[]>`
      INSERT INTO org_server_access (id, org_id, user_id, vendor_slug, granted_by)
      VALUES (${id}, ${orgId}, ${userId}, ${vendorSlug}, ${grantedBy})
      ON CONFLICT (org_id, user_id, vendor_slug) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return this.toServerAccess(rows[0]);
    // Already exists — return existing
    const existing = await this.sql<ServerAccessRow[]>`
      SELECT * FROM org_server_access WHERE org_id = ${orgId} AND user_id = ${userId} AND vendor_slug = ${vendorSlug}
    `;
    return existing[0] ? this.toServerAccess(existing[0]) : null;
  }

  async revokeServerAccess(orgId: string, userId: string, vendorSlug: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_server_access WHERE org_id = ${orgId} AND user_id = ${userId} AND vendor_slug = ${vendorSlug}
    `;
    return result.count > 0;
  }

  async hasServerAccess(orgId: string, userId: string, vendorSlug: string): Promise<boolean> {
    // Owners always have access
    const membership = await this.getMembership(orgId, userId);
    if (membership?.role === 'owner') return true;

    const rows = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM org_server_access
      WHERE org_id = ${orgId} AND user_id = ${userId} AND vendor_slug = ${vendorSlug}
    `;
    if ((rows[0]?.count ?? 0) > 0) return true;

    // Check team grants
    return this.teamService.hasTeamServerAccess(orgId, userId, vendorSlug);
  }

  async listServerAccess(orgId: string, userId?: string): Promise<OrgServerAccess[]> {
    if (userId) {
      const rows = await this.sql<ServerAccessRow[]>`
        SELECT * FROM org_server_access WHERE org_id = ${orgId} AND user_id = ${userId} ORDER BY granted_at
      `;
      return rows.map((r) => this.toServerAccess(r));
    }
    const rows = await this.sql<ServerAccessRow[]>`
      SELECT * FROM org_server_access WHERE org_id = ${orgId} ORDER BY user_id, granted_at
    `;
    return rows.map((r) => this.toServerAccess(r));
  }

  async bulkSetServerAccess(orgId: string, userId: string, vendorSlugs: string[], grantedBy: string): Promise<void> {
    // Remove all current grants for this user in this org
    await this.sql`
      DELETE FROM org_server_access WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    // Insert new grants
    for (const slug of vendorSlugs) {
      const id = nanoid();
      await this.sql`
        INSERT INTO org_server_access (id, org_id, user_id, vendor_slug, granted_by)
        VALUES (${id}, ${orgId}, ${userId}, ${slug}, ${grantedBy})
        ON CONFLICT (org_id, user_id, vendor_slug) DO NOTHING
      `;
    }
  }

  async grantAllServerAccess(orgId: string, userId: string, grantedBy: string): Promise<void> {
    // Get all vendors configured for this org
    const rows = await this.sql<{ vendor_slug: string }[]>`
      SELECT vendor_slug FROM org_credentials WHERE org_id = ${orgId}
    `;
    for (const row of rows) {
      const id = nanoid();
      await this.sql`
        INSERT INTO org_server_access (id, org_id, user_id, vendor_slug, granted_by)
        VALUES (${id}, ${orgId}, ${userId}, ${row.vendor_slug}, ${grantedBy})
        ON CONFLICT (org_id, user_id, vendor_slug) DO NOTHING
      `;
    }
  }

  async migrateServerAccessForExistingMembers(): Promise<void> {
    // For each org, grant all existing members access to all org vendors
    // Idempotent: ON CONFLICT DO NOTHING
    const orgs = await this.sql<{ id: string }[]>`SELECT id FROM organizations`;
    for (const org of orgs) {
      const members = await this.getMembers(org.id);
      const vendors = await this.sql<{ vendor_slug: string }[]>`
        SELECT vendor_slug FROM org_credentials WHERE org_id = ${org.id}
      `;
      for (const member of members) {
        for (const vendor of vendors) {
          const id = nanoid();
          await this.sql`
            INSERT INTO org_server_access (id, org_id, user_id, vendor_slug, granted_by)
            VALUES (${id}, ${org.id}, ${member.userId}, ${vendor.vendor_slug}, ${member.userId})
            ON CONFLICT (org_id, user_id, vendor_slug) DO NOTHING
          `;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Request log
  // -------------------------------------------------------------------------

  async cleanupRequestLog(retentionDays = 90): Promise<number> {
    const result = await this.sql`
      DELETE FROM request_log
      WHERE created_at < NOW() - ${retentionDays + ' days'}::interval
    `;
    return result.count;
  }

  async logRequest(entry: {
    userId: string;
    orgId?: string;
    vendorSlug: string;
    toolName?: string;
    statusCode: number;
    responseTimeMs?: number;
    toolArguments?: unknown;
    promptContext?: string;
    source?: string;
  }): Promise<void> {
    const id = nanoid();
    const toolArgs = entry.toolArguments ? JSON.stringify(entry.toolArguments) : null;
    await this.sql`
      INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, tool_arguments, prompt_context, source)
      VALUES (${id}, ${entry.userId}, ${entry.orgId ?? null}, ${entry.vendorSlug}, ${entry.toolName ?? null}, ${entry.statusCode}, ${entry.responseTimeMs ?? null}, ${toolArgs}, ${entry.promptContext ?? null}, ${entry.source ?? 'mcp'})
    `;
  }

  // -------------------------------------------------------------------------
  // Prompt capture settings
  // -------------------------------------------------------------------------

  async getPromptCaptureEnabled(orgId: string): Promise<boolean> {
    const rows = await this.sql<{ prompt_capture_enabled: boolean }[]>`
      SELECT prompt_capture_enabled FROM organizations WHERE id = ${orgId}
    `;
    return rows[0]?.prompt_capture_enabled ?? false;
  }

  async setPromptCaptureEnabled(orgId: string, enabled: boolean): Promise<void> {
    await this.sql`
      UPDATE organizations SET prompt_capture_enabled = ${enabled}, updated_at = NOW()
      WHERE id = ${orgId}
    `;
  }

  // -------------------------------------------------------------------------
  // Service clients (M2M / AI agent access)
  // -------------------------------------------------------------------------

  private toServiceClient(row: ServiceClientRow): ServiceClient {
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      clientId: row.client_id,
      clientSecretHash: row.client_secret_hash,
      createdBy: row.created_by,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async createServiceClient(entry: {
    orgId: string;
    name: string;
    clientId: string;
    clientSecretHash: string;
    createdBy: string;
    expiresAt?: string;
  }): Promise<ServiceClient> {
    const id = nanoid();
    await this.sql`
      INSERT INTO service_clients (id, org_id, name, client_id, client_secret_hash, created_by, expires_at)
      VALUES (${id}, ${entry.orgId}, ${entry.name}, ${entry.clientId}, ${entry.clientSecretHash}, ${entry.createdBy}, ${entry.expiresAt ?? null})
    `;
    const rows = await this.sql<ServiceClientRow[]>`
      SELECT * FROM service_clients WHERE id = ${id}
    `;
    return this.toServiceClient(rows[0]);
  }

  async getServiceClientByClientId(clientId: string): Promise<ServiceClient | null> {
    const rows = await this.sql<ServiceClientRow[]>`
      SELECT * FROM service_clients WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return null;
    return this.toServiceClient(rows[0]);
  }

  async listServiceClients(orgId: string): Promise<ServiceClient[]> {
    const rows = await this.sql<ServiceClientRow[]>`
      SELECT * FROM service_clients WHERE org_id = ${orgId} ORDER BY created_at
    `;
    return rows.map((r) => this.toServiceClient(r));
  }

  async deleteServiceClient(orgId: string, clientId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM service_clients WHERE org_id = ${orgId} AND client_id = ${clientId}
    `;
    return result.count > 0;
  }

  async touchServiceClientLastUsed(clientId: string): Promise<void> {
    await this.sql`
      UPDATE service_clients SET last_used_at = NOW() WHERE client_id = ${clientId}
    `;
  }

  // -------------------------------------------------------------------------
  // Teams (delegated to TeamService)
  // -------------------------------------------------------------------------

  createTeam(orgId: string, name: string, createdBy: string) { return this.teamService.createTeam(orgId, name, createdBy); }
  getTeam(teamId: string) { return this.teamService.getTeam(teamId); }
  listTeams(orgId: string) { return this.teamService.listTeams(orgId); }
  renameTeam(teamId: string, name: string) { return this.teamService.renameTeam(teamId, name); }
  deleteTeam(teamId: string) { return this.teamService.deleteTeam(teamId); }
  addTeamMember(teamId: string, orgId: string, userId: string, addedBy: string) { return this.teamService.addMember(teamId, orgId, userId, addedBy); }
  removeTeamMember(teamId: string, userId: string) { return this.teamService.removeMember(teamId, userId); }
  getTeamMembersWithProfiles(teamId: string) { return this.teamService.getTeamMembersWithProfiles(teamId); }
  getUserTeams(orgId: string, userId: string) { return this.teamService.getUserTeams(orgId, userId); }
  grantTeamServerAccess(orgId: string, teamId: string, vendorSlug: string, grantedBy: string) { return this.teamService.grantServerAccess(orgId, teamId, vendorSlug, grantedBy); }
  revokeTeamServerAccess(teamId: string, vendorSlug: string) { return this.teamService.revokeServerAccess(teamId, vendorSlug); }
  listTeamServerAccess(teamId: string) { return this.teamService.listServerAccess(teamId); }
  listTeamsWithDetails(orgId: string) { return this.teamService.listTeamsWithDetails(orgId); }
  listEffectiveTeamAccessForOrg(orgId: string) { return this.teamService.listEffectiveTeamAccessForOrg(orgId); }
}
