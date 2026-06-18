import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';
import { getDefaultPlan } from '../billing/plan-catalog.js';
import type { OrgBillingProvisioner } from './org-billing-provisioner.js';
import type { OrgAuth0Provisioner, OrgAuth0Rollback } from './org-auth0-provisioner.js';
import type { SeatSyncer } from '../billing/seat-syncer.js';
import { isAcceptInvitationError } from './invitation-service.js';
export { isAcceptInvitationError } from './invitation-service.js';
export type { AcceptInvitationError } from './invitation-service.js';
import { MemberService } from './member-service.js';
import { InvitationService } from './invitation-service.js';
import { ToolAllowlistService } from './tool-allowlist-service.js';
import { TeamService } from './team-service.js';
import type { OrgTeam, OrgTeamMember, OrgTeamServerAccess, OrgTeamWithMembers } from './team-service.js';
import { notifyNewSignup } from '../billing/sales-notifier.js';
import type { FastifyBaseLogger } from 'fastify';
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
  // Flat-pricing: the canonical value is 'conduit', but the column is a
  // free-form text field that still carries legacy 'free'/'pro'/'business'
  // values on un-migrated rows during the WI-8 migration window. Typed as
  // `string` to reflect that reality — getPlan/isPaidPlan (billing/gate.ts)
  // resolve ANY slug to the one plan, so reads are safe; writes use the
  // 'conduit' literal. Narrowing this to 'conduit' would be untruthful about
  // what the column can hold mid-migration.
  plan: string;
  defaultServerAccess: 'none' | 'all';
  promptCaptureEnabled: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  type: OrgType;
  parentOrgId: string | null;
  /**
   * Paired Auth0 Organization id (`org_<alnum>`). Nullable while pre-launch
   * orgs backfill + while the Management API provisioning slice ships.
   *
   * Multi-IdP foundation (June 29 launch directive 2026-06-13): the Auth0
   * Org id is the routing key for per-org IdP connections (Okta, JumpCloud,
   * Google direct). The authorize URL builder reads this to pass the
   * `organization` param to Auth0; the callback handler validates the
   * returned id_token's `org_id` claim against it.
   *
   * NULL = "Conduit org without an Auth0 Org peer yet" — the auth flow
   * falls through to legacy Universal Login.
   */
  auth0OrgId: string | null;
  /**
   * Set when a reseller-admin suspends a customer-org via the LAYER-C
   * suspend route (POST /api/orgs/:orgId/suspend, mig 012 column).
   * `null` = active; ISO timestamp = suspended.
   *
   * Read-only on this interface; mutate via `suspendOrg` / `unsuspendOrg`
   * (org-service) which thread through the requireOrgRoleForWrite gate +
   * actingAsAuditTriplet emit at the route boundary.
   */
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgOptions {
  type?: OrgType;
  parentOrgId?: string | null;
  /** Owner's email — flowed through to Stripe for trial-ending notices.
   *  Optional because the reseller/customer paths don't always have it
   *  available at creation time and don't always need it. */
  ownerEmail?: string;
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
  expiresAt: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
  /**
   * Role granted on accept. NULL for legacy pre-Layer-1 invitations (treated
   * as 'member' by acceptInvitation). 'owner' triggers the atomic-swap path;
   * 'admin' / 'member' use the standard INSERT path.
   * From migration 010 (intended_role column).
   */
  intendedRole: OrgRole | null;
  /**
   * Email the invite is bound to (lowercased+trimmed by src/email/normalize.ts).
   * When NOT NULL, acceptInvitation enforces auth.user.email match. NULL is
   * tolerated for legacy pre-2026-05-22 invitations — new owner-invite code
   * paths never write null. Paired-follow-up task_1779450095130 extends the
   * same shape to member-invites. From migration 034.
   */
  recipientEmail: string | null;
  /**
   * Invitation-type discriminator (migration 041, WYREAI-118 + 119 admin
   * create-org flow). 'member_join' is the legacy default and covers every
   * pre-mig-041 row + every default-shape invite (member-invites + the
   * customer-create owner-invite using the blanket-DELETE atomic-swap).
   * 'owner_swap_to_invited' is the admin create-org-with-stub-owner flow:
   * uses the NARROWED-DELETE atomic-swap that filters on swapFromUserId
   * only (vs blanket all-other-owners), per the warden warning at
   * invitation-service.ts acceptInvitation (carried-forward at impl-time).
   */
  inviteType: 'member_join' | 'owner_swap_to_invited';
  /**
   * Interim stub-owner user_id to swap from on accept. NOT NULL when
   * inviteType='owner_swap_to_invited' (DB CHECK at mig 041 enforces),
   * NULL otherwise. The NARROWED-DELETE predicate uses this directly.
   */
  swapFromUserId: string | null;
}

/**
 * Returned by `createInvitation`. `plainToken` is shown exactly once — embed
 * in the invite URL at creation time and never re-display. Only the hash
 * lives in the DB; subsequent reads of an invitation never carry plaintext.
 */
export interface CreatedInvitation {
  invitation: OrgInvitation;
  plainToken: string;
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
  auth0_org_id: string | null;
  suspended_at: string | null;
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

export interface OrgServiceOptions {
  /**
   * Optional billing-provisioner. When present, standalone-org creation
   * attaches a Stripe trialing subscription (Layer 1 paid-with-trial path
   * per DOR §9.1). When absent — tests, dev environments without Stripe —
   * createOrg silently skips the Stripe attach and the org row is left
   * with null stripe_customer_id / stripe_subscription_id. The fallback
   * is structural; no flag, no env-check inside createOrg.
   */
  billingProvisioner?: OrgBillingProvisioner;
  /**
   * Optional seat-syncer. When present, the 5 seat-mutation sites
   * (invitation-accept + domain-auto-join + member-remove + service-client
   * create + service-client delete) call syncSeats(orgId) after their DB
   * write, which pushes the new billableSeats to the org's Stripe
   * subscription seat-item. Per DOR §6. When absent — tests, dev — the
   * mutation sites complete cleanly with no Stripe push. Same shape and
   * skip-semantics as billingProvisioner.
   */
  seatSyncer?: SeatSyncer;
  /**
   * Optional Auth0-side provisioner + rollback pair (Multi-IdP foundation
   * slice 3 — June 29 launch directive 2026-06-13). When present, every
   * createOrg call pair-creates an Auth0 Organization peer BEFORE the DB
   * INSERT and persists the returned id to organizations.auth0_org_id
   * (column from migration 046, slice 1). When absent — tests, dev,
   * production-without-M2M-creds — the org row is created with
   * auth0_org_id=NULL and the auth flow falls through to legacy
   * Universal Login. BOTH-OR-NEITHER discipline: see
   * org-auth0-provisioner.ts docstring for the failure-mode rationale.
   */
  auth0Provisioner?: OrgAuth0Provisioner;
  auth0Rollback?: OrgAuth0Rollback;
}

export class OrgService {
  private memberService: MemberService;
  private invitationService: InvitationService;
  private toolAllowlistService: ToolAllowlistService;
  private teamService: TeamService;
  private billingProvisioner?: OrgBillingProvisioner;
  private seatSyncer?: SeatSyncer;
  private auth0Provisioner?: OrgAuth0Provisioner;
  private auth0Rollback?: OrgAuth0Rollback;

  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  constructor(options: OrgServiceOptions = {}) {
    this.memberService = new MemberService();
    this.invitationService = new InvitationService(this.memberService);
    this.toolAllowlistService = new ToolAllowlistService();
    this.teamService = new TeamService();
    this.billingProvisioner = options.billingProvisioner;
    this.seatSyncer = options.seatSyncer;
    this.auth0Provisioner = options.auth0Provisioner;
    this.auth0Rollback = options.auth0Rollback;
  }

  /**
   * Post-construction wiring for the billing provisioner. Used in
   * src/index.ts to break the orgService ⇄ seatService dependency cycle:
   * orgService constructs first (no provisioner), seatService binds to
   * the live orgService, then the provisioner — which closes over
   * seatService — attaches here. Tests use the constructor option
   * instead and never hit this path.
   */
  setBillingProvisioner(provisioner: OrgBillingProvisioner): void {
    this.billingProvisioner = provisioner;
  }

  /**
   * Post-construction wiring for the seat-syncer. Same cycle-breaking
   * pattern as setBillingProvisioner — syncer closes over seatService
   * which closes over orgService.
   */
  setSeatSyncer(syncer: SeatSyncer): void {
    this.seatSyncer = syncer;
  }

  /**
   * Post-construction wiring for the Auth0 org-provisioner + its rollback
   * hook. Same cycle-breaking pattern as setBillingProvisioner — index.ts
   * constructs orgService first, then the Auth0ManagementClient (which
   * depends only on config + fetch), then calls this setter with the pair
   * returned from createAuth0OrgProvisioner. Tests use the constructor
   * option instead.
   */
  setAuth0Provisioner(provisioner: OrgAuth0Provisioner, rollback: OrgAuth0Rollback): void {
    this.auth0Provisioner = provisioner;
    this.auth0Rollback = rollback;
  }

  /**
   * Pushes the org's current billableSeats to its Stripe subscription
   * seat-item. Called by every seat-mutation site (the 5 hookable sites:
   * createServiceClient, deleteServiceClient, removeMember, acceptInvitation,
   * domain-auto-join) after the underlying DB write completes.
   *
   * LOG + SWALLOW SEMANTIC (API CONTRACT, not caller-side discipline):
   * Stripe errors are logged via console.warn and absorbed. The DB write
   * is the source of truth for entitlement; the Stripe push is eventually-
   * consistent. A reconciliation job (filed as launch-gate task with
   * named triggers — first observed drift OR fleet >~100 orgs OR
   * compliance ask) catches persistent drift; this method prevents a
   * transient Stripe blip from cascading into a user-facing 5xx on a
   * mutation whose DB write already committed.
   *
   * Per DOR §6 + ruby disposition: payments shouldn't gate auth/membership.
   * Analyst HOLD on PR #221 caught a 4-of-5 address-the-set inconsistency
   * where this method previously threw and 4 in-class callers used a
   * private trySyncSeats wrapper — the 5th caller (domain-auto-join)
   * could 5xx despite a committed INSERT. Disposition (β): lift the
   * log+swallow to the API boundary so every caller gets the same
   * semantic by construction; future mutation sites can't pick wrong.
   *
   * No-op when no syncer is wired (tests, dev w/o Stripe).
   */
  async syncSeats(orgId: string): Promise<void> {
    if (!this.seatSyncer) return;
    try {
      await this.seatSyncer(orgId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[seat-sync] failed for org ${orgId} after seat mutation; DB write is committed, Stripe quantity may be stale:`,
        err instanceof Error ? err.message : err,
      );
    }
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
        expires_at  TIMESTAMPTZ NOT NULL,
        accepted_by TEXT REFERENCES users(id),
        accepted_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Post-015 contract: only the hash column is referenced by the runtime
    // service. The `token` column (and its UNIQUE constraint + index) has
    // been dropped by migration 015. On a fresh DB this CREATE TABLE never
    // creates the legacy column; on an existing DB the migration drops it.

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

    // ---------------------------------------------------------------------
    // Team-scoped allowlist additions (WYREAI-59, parity port of gateway #189).
    // Each org_tool_allowlist row is EITHER team-scoped (team_id NOT NULL,
    // role NULL) OR role-scoped (team_id NULL, role NOT NULL) — never both
    // and never neither. The CHECK invariant enforces that at the schema
    // layer so the call-site never has to remember. (Structural-XOR pin.)
    //
    // Existing RLS policies on org_tool_allowlist are org-scoped (org_members
    // check + reseller-admin parent check) and DON'T reference role or team_id
    // — they continue to gate at the org-membership level, which is correct
    // for both shapes. Whether team-scoped rows additionally need a finer-grain
    // team-membership check is a warden-domain call (sibling Linear WYREAI-59).
    //
    // All additions idempotent (boot DDL). Existing role-scoped rows are
    // untouched — they remain valid under the new partial UNIQUE for role rows.
    // ---------------------------------------------------------------------

    // 1) Add nullable team_id column (FK to org_teams, cascade on team delete).
    await this.sql`
      ALTER TABLE org_tool_allowlist
        ADD COLUMN IF NOT EXISTS team_id TEXT
        REFERENCES org_teams(id) ON DELETE CASCADE
    `;

    // 2) Make role nullable (was NOT NULL; team rows have role IS NULL).
    //    ALTER COLUMN ... DROP NOT NULL is idempotent in PostgreSQL.
    await this.sql`
      ALTER TABLE org_tool_allowlist ALTER COLUMN role DROP NOT NULL
    `;

    // 3) Drop the existing UNIQUE(org_id, vendor_slug, role, tool_name)
    //    constraint — it can't enforce uniqueness for team rows (role is NULL
    //    there, and PG treats NULLs as distinct in UNIQUE). The two partial
    //    UNIQUEs below replace it with shape-correct enforcement.
    await this.sql`
      ALTER TABLE org_tool_allowlist
        DROP CONSTRAINT IF EXISTS org_tool_allowlist_org_id_vendor_slug_role_tool_name_key
    `;

    // 4) CHECK invariant: exactly one of (team_id, role) is non-NULL.
    //    PostgreSQL doesn't support ADD CONSTRAINT IF NOT EXISTS, so guard via
    //    pg_constraint lookup. Same idempotency idiom as the rest of initTables.
    await this.sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'org_tool_allowlist_team_xor_role'
        ) THEN
          ALTER TABLE org_tool_allowlist
            ADD CONSTRAINT org_tool_allowlist_team_xor_role
            CHECK ((team_id IS NULL) <> (role IS NULL));
        END IF;
      END $$;
    `;

    // 5) Partial UNIQUE for role-scoped rows (team_id IS NULL).
    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_tool_allowlist_role
        ON org_tool_allowlist(org_id, vendor_slug, role, tool_name)
        WHERE team_id IS NULL
    `;

    // 6) Partial UNIQUE for team-scoped rows (role IS NULL).
    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_tool_allowlist_team
        ON org_tool_allowlist(org_id, vendor_slug, team_id, tool_name)
        WHERE role IS NULL
    `;

    // 8) granted_at audit timestamp (WYREAI-62, gateway #200 parity).
    //    Idempotent ADD + backfill from created_at for existing rows. Future
    //    writes set granted_at = NOW() via setTeamToolAllowlist / setToolAllowlist
    //    (the replace-set DELETE+INSERT cadence makes granted_at == row creation
    //    time for new grants).
    await this.sql`
      ALTER TABLE org_tool_allowlist
        ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ
    `;
    // Backfill: any row added before this column existed gets its created_at,
    // or NOW() as a last-resort fallback (defensive — no rows lack created_at
    // in practice since it's NOT NULL DEFAULT NOW() on insert).
    await this.sql`
      UPDATE org_tool_allowlist
         SET granted_at = COALESCE(created_at, NOW())
       WHERE granted_at IS NULL
    `;

    // 7) Lookup index for team-scoped queries (mirrors the role-lookup index).
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_org_tool_allowlist_team_lookup
        ON org_tool_allowlist(org_id, vendor_slug, team_id)
        WHERE team_id IS NOT NULL
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
      plan: row.plan,
      defaultServerAccess: (row.default_server_access as 'none' | 'all') || 'none',
      promptCaptureEnabled: row.prompt_capture_enabled ?? false,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      type: (row.type as OrgType | null) ?? 'standalone',
      parentOrgId: row.parent_org_id,
      // Coalesce `undefined` to `null` defensively: the mock SQL used in
      // unit tests doesn't return rows with the auth0_org_id column until
      // the migration runs against the test container, so an INSERT-result
      // row mid-test can omit the field. Production rows + migrated rows
      // always have a literal value (string or null). Mapping `undefined`
      // to `null` keeps the type honest as `string | null` for callers.
      auth0OrgId: row.auth0_org_id ?? null,
      suspendedAt: row.suspended_at ?? null,
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
    plan?: string,
    options?: CreateOrgOptions,
    log?: FastifyBaseLogger,
  ): Promise<Organization> {
    const orgId = nanoid();
    const memberId = nanoid();
    // Layer 1 default: every new org is conduit-with-trial (DOR §9.1).
    // Callers retain the explicit-plan override for the reseller/customer
    // paths that bill differently; standalone callers should let this
    // default fire by passing undefined.
    const orgPlan = plan ?? getDefaultPlan().slug;
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

    // Multi-IdP foundation slice 3 (June 29 launch directive 2026-06-13):
    // pair-create the Auth0 Organization BEFORE the DB INSERT so that an
    // Auth0-side failure results in zero DB state (no orphan org row to
    // roll back). BOTH-OR-NEITHER discipline rationale lives at the
    // src/org/org-auth0-provisioner.ts docstring.
    //
    // Provisioner-absent (tests, dev environments without M2M creds,
    // prod-without-M2M-creds) → auth0OrgId stays null and the legacy
    // Universal Login path stays active (slice 1 migration 046 documents
    // this nullable contract on Organization.auth0OrgId).
    let auth0OrgId: string | null = null;
    if (this.auth0Provisioner) {
      const auth0Result = await this.auth0Provisioner({
        orgId,
        orgName: name,
        orgType,
      });
      auth0OrgId = auth0Result.auth0OrgId;
    }

    // DB INSERT block wrapped in try/catch so a post-Auth0 failure can
    // roll back the Auth0-side state (deleteOrganization) before the
    // exception propagates — preserves BOTH-OR-NEITHER even when the
    // failure happens AFTER the Auth0 succeed.
    let rows: OrgRow[];
    try {
      rows = await this.sql<OrgRow[]>`
        INSERT INTO organizations (id, name, owner_id, plan, type, parent_org_id, auth0_org_id)
        VALUES (${orgId}, ${name}, ${ownerId}, ${orgPlan}, ${orgType}, ${parentOrgId}, ${auth0OrgId})
        RETURNING *
      `;

      // Add owner as first member
      await this.sql`
        INSERT INTO org_members (id, org_id, user_id, role, joined_at)
        VALUES (${memberId}, ${orgId}, ${ownerId}, 'owner', NOW())
      `;
    } catch (err) {
      // Roll back the Auth0-side state if we got one before the DB INSERT
      // failed. The rollback is best-effort — a rollback failure here is
      // logged and swallowed; the original DB error is the load-bearing
      // signal the caller needs to handle. Surfacing both would muddle
      // the error contract.
      if (auth0OrgId && this.auth0Rollback) {
        try {
          await this.auth0Rollback(auth0OrgId);
        } catch (rollbackErr) {
          log?.error(
            { err: rollbackErr, auth0OrgId, orgId },
            'Auth0 rollback failed after DB INSERT failure — manual cleanup may be needed',
          );
        }
      }
      throw err;
    }

    // Notify new signup (from main — fire-and-forget signup analytics).
    if (log) {
      void notifyNewSignup(this.sql, { userId: ownerId, orgId, isOwner: true }, log);
    }

    // Layer 1: standalone orgs attach a Stripe trialing subscription at
    // creation (DOR §9.1). Customer and reseller orgs are billed via the
    // reseller path and skip this. Provisioner-absent (tests, dev w/o
    // Stripe) is also a clean skip — the org row's stripe_customer_id /
    // stripe_subscription_id stay null and downstream consumers handle
    // the no-Stripe case (already exercised today on the F3 surface).
    //
    // Order of ops ratified by ruby (msg 1779411593149): org INSERT →
    // owner-member INSERT → provisioner → UPDATE stripe IDs. Idempotency
    // keys inside createTrialingSubscription (orgId-bound) make a retry
    // after a mid-flight failure safe — Stripe returns the same objects
    // rather than minting duplicates.
    let stripeCustomerId: string | null = null;
    let stripeSubscriptionId: string | null = null;
    if (orgType === 'standalone' && this.billingProvisioner) {
      const provisionResult = await this.billingProvisioner({
        orgId,
        orgName: name,
        ownerEmail: options?.ownerEmail,
      });
      if (provisionResult) {
        stripeCustomerId = provisionResult.stripeCustomerId;
        stripeSubscriptionId = provisionResult.stripeSubscriptionId;
        await this.sql`
          UPDATE organizations
          SET stripe_customer_id = ${stripeCustomerId},
              stripe_subscription_id = ${stripeSubscriptionId},
              updated_at = NOW()
          WHERE id = ${orgId}
        `;
        // Shape-A′ fix #1 (ruby ruling 2026-05-26): SEED the subscriptions
        // row at provisioning so the cancellation/dunning lifecycle handlers
        // have a row to mutate. Net-new orgs otherwise have NO subscriptions
        // row (the provisioner writes Stripe IDs to organizations only), so
        // cancellation would be a no-op (UPDATE hits zero rows →
        // isServiceActive(null)=true) AND the dunning grace UI would never
        // fire. BEST-EFFORT LOCAL SEED — ON CONFLICT DO NOTHING: if a
        // customer.subscription.created/updated webhook (Stripe-truth) raced
        // ahead and wrote the row, its status wins; the seed yields.
        // (Asymmetry-by-authority: Stripe-truth writers upsert-and-win; the
        // local seed does-nothing. id = stripe_subscription_id; conflict
        // target = UNIQUE(stripe_subscription_id).)
        const periodEndIso = provisionResult.currentPeriodEnd
          ? new Date(provisionResult.currentPeriodEnd * 1000).toISOString()
          : null;
        await this.sql`
          INSERT INTO subscriptions (
            id, org_id, stripe_customer_id, stripe_subscription_id,
            plan, status, current_period_end, cancel_at_period_end
          )
          VALUES (
            ${stripeSubscriptionId}, ${orgId}, ${stripeCustomerId}, ${stripeSubscriptionId},
            'conduit', 'trialing', ${periodEndIso}, FALSE
          )
          ON CONFLICT (stripe_subscription_id) DO NOTHING
        `;
      }
    }

    const org = this.toOrg(rows[0]);
    if (stripeCustomerId) org.stripeCustomerId = stripeCustomerId;
    if (stripeSubscriptionId) org.stripeSubscriptionId = stripeSubscriptionId;
    return org;
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
   * Reseller tenant-tree data for /org/hierarchy: the reseller's own member
   * count plus each direct customer org with its member count. Two cheap
   * queries (no per-customer N+1). The hierarchy is capped at depth 2 by the
   * DB trigger (reseller → customer), so direct children are the whole tree —
   * no recursion needed. Scoped by `parent_org_id = resellerOrgId AND
   * type = 'customer'`, the same tenant boundary as {@link getCustomersOfReseller}.
   */
  async getResellerHierarchy(resellerOrgId: string): Promise<{
    customers: Array<{ org: Organization; userCount: number }>;
    resellerUserCount: number;
  }> {
    const [customerRows, resellerCountRows] = await Promise.all([
      this.sql<(OrgRow & { user_count: number })[]>`
        SELECT o.*, COUNT(m.user_id)::int AS user_count
          FROM organizations o
          LEFT JOIN org_members m ON m.org_id = o.id
         WHERE o.parent_org_id = ${resellerOrgId}
           AND o.type = 'customer'
         GROUP BY o.id
         ORDER BY o.created_at
      `,
      this.sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM org_members WHERE org_id = ${resellerOrgId}
      `,
    ]);
    return {
      customers: customerRows.map((r) => ({ org: this.toOrg(r), userCount: r.user_count })),
      resellerUserCount: resellerCountRows[0]?.c ?? 0,
    };
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

  /**
   * Hard-delete an org row (DELETE FROM). Cascade follows FK rules in the
   * schema. Used by the launch-window soft-delete sweeper (post-window
   * cleanup) AND by the legacy direct-DELETE path that LAYER-C is in the
   * process of replacing — see `softDeleteOrg` below for the new launch-
   * safe primitive. Callers should prefer `softDeleteOrg` + the 7-day
   * reversibility window unless the operator is explicitly bypassing it.
   */
  async deleteOrg(orgId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM organizations WHERE id = ${orgId}
    `;
    return result.count > 0;
  }

  /**
   * Soft-delete an org by setting `suspended_at` if not already set and
   * marking the row for the sweeper. LAYER-C launch-safety primitive
   * (boss msg-1781747367566 warden pre-prep): hard-delete is irreversible
   * and a single accidental click should not destroy an MSP customer's
   * org. Soft-delete buys a ≥7-day reversibility window during which
   * `restoreOrg` un-marks the row.
   *
   * Implementation note: we reuse `suspended_at` as the soft-delete
   * marker for now (no new column) — the discriminator is the audit
   * event (`customer_org_soft_deleted` vs `customer_org_suspended`), not
   * the schema. Post-window the sweeper hard-deletes; a dedicated
   * `deleted_at` column is a follow-up if/when forensics needs it
   * cleanly separated from operator-initiated suspends. Returning the
   * updated row keeps the call-site symmetrical with suspendOrg.
   *
   * Idempotent: if the row is already suspended/soft-deleted, this is a
   * no-op that still returns the current row state. That lets the
   * DELETE route's idempotency contract (boss warden pre-prep #4)
   * collapse to a service-layer guarantee.
   */
  async softDeleteOrg(orgId: string): Promise<Organization | null> {
    const rows = await this.sql<OrgRow[]>`
      UPDATE organizations
      SET suspended_at = COALESCE(suspended_at, NOW()), updated_at = NOW()
      WHERE id = ${orgId}
      RETURNING *
    `;
    return rows[0] ? this.toOrg(rows[0]) : null;
  }

  /**
   * Restore a soft-deleted (or suspended) org by clearing
   * `suspended_at`. Used by the LAYER-C `POST /api/orgs/:orgId/restore`
   * route within the reversibility window AND by the unsuspend route.
   * Single primitive intentionally: at the schema layer there's nothing
   * to distinguish a soft-delete from a suspend — that distinction is
   * the audit event emitted at the route boundary. Returning null when
   * no row matches keeps not-found handling at the route level.
   */
  async restoreOrg(orgId: string): Promise<Organization | null> {
    const rows = await this.sql<OrgRow[]>`
      UPDATE organizations
      SET suspended_at = NULL, updated_at = NOW()
      WHERE id = ${orgId}
      RETURNING *
    `;
    return rows[0] ? this.toOrg(rows[0]) : null;
  }

  /**
   * Suspend an org by setting `suspended_at` to NOW(). LAYER-C
   * customer-suspend primitive — sets the column AND the route layer
   * is responsible for the side-effect cascade (revoke active acting-as
   * sessions targeting this org so 'suspended but still impersonable'
   * is closed by-construction per boss msg-1781747367566).
   *
   * Schema-identical to `softDeleteOrg`: the difference is the audit
   * event emitted by the route handler (`customer_org_suspended` vs
   * `customer_org_soft_deleted`) and what the post-window sweeper does
   * (suspend = no sweep, stays indefinitely until unsuspended; soft-
   * delete = sweep + hard-delete after ≥7d). The sweeper itself is a
   * follow-up PR; this method just writes the column.
   *
   * Idempotent: re-suspending an already-suspended org is a no-op that
   * still returns the current row.
   */
  async suspendOrg(orgId: string): Promise<Organization | null> {
    const rows = await this.sql<OrgRow[]>`
      UPDATE organizations
      SET suspended_at = COALESCE(suspended_at, NOW()), updated_at = NOW()
      WHERE id = ${orgId}
      RETURNING *
    `;
    return rows[0] ? this.toOrg(rows[0]) : null;
  }

  /**
   * Unsuspend an org by clearing `suspended_at`. Alias for `restoreOrg`
   * — kept as a separate symbol so route-side audit-event selection
   * stays readable at the call site (suspend route ↔ unsuspendOrg,
   * delete route ↔ restoreOrg). Schema-identical operation.
   */
  async unsuspendOrg(orgId: string): Promise<Organization | null> {
    return this.restoreOrg(orgId);
  }

  async updateOrgPlan(
    orgId: string,
    plan: string,
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
  // Subscriptions (mig 017 + 024 schema, used by isServiceActive dunning gate)
  // -------------------------------------------------------------------------

  /**
   * Fetch the current subscription row for an org, or null if no row.
   * Used by BillingGate.canAccessPaidFeatures to compose the dunning-aware
   * service-active gate alongside isPaidPlan. Returns only the fields the
   * gate-composition logic needs (status, first_failure_at, recovered_at).
   */
  async getSubscription(orgId: string): Promise<{
    status: string;
    first_failure_at: Date | null;
    recovered_at: Date | null;
    /** Period end of the current billing cycle (or the cutover-grace T+14d
     *  natural-flip moment for a free-org grace row). Combined with
     *  cancel_at_period_end, lets isServiceActive flip service off by
     *  time-elapsed at request-time — no cron / no status-write needed. */
    current_period_end: Date | null;
    /** "End service when the period ends" flag. TRUE on cutover-seeded local
     *  grace rows (Aaron's 2026-05-29 free-org 14-day decide-or-revert policy)
     *  AND on Stripe subscriptions the user chose to cancel-at-period-end. */
    cancel_at_period_end: boolean | null;
  } | null> {
    const rows = await this.sql<{
      status: string;
      first_failure_at: Date | null;
      recovered_at: Date | null;
      current_period_end: Date | null;
      cancel_at_period_end: boolean | null;
    }[]>`
      SELECT status, first_failure_at, recovered_at,
             current_period_end, cancel_at_period_end
        FROM subscriptions
       WHERE org_id = ${orgId}
       ORDER BY created_at DESC
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Memberships (delegated to MemberService)
  // -------------------------------------------------------------------------

  getMembers(orgId: string) { return this.memberService.getMembers(orgId); }
  getMembersWithProfiles(orgId: string) { return this.memberService.getMembersWithProfiles(orgId); }
  getMembership(orgId: string, userId: string) { return this.memberService.getMembership(orgId, userId); }
  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const removed = await this.memberService.removeMember(orgId, userId);
    if (removed) await this.syncSeats(orgId);
    return removed;
  }

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

  /**
   * Mint an invitation. opts extended in Layer 1 to carry intendedRole +
   * recipientEmail for the owner-invite path. AUTHORIZATION GUARD: when
   * opts.intendedRole === 'owner' the caller MUST verify invitedBy is the
   * current owner of orgId before calling — see route-layer guard in
   * src/reseller/routes.ts customer-create path.
   */
  createInvitation(
    orgId: string,
    invitedBy: string,
    options?: {
      maxUses?: number | null;
      expiresInHours?: number;
      intendedRole?: OrgRole;
      recipientEmail?: string;
      /** WYREAI-118+119 admin create-org-with-stub-owner flow. See
       *  InvitationService.createInvitation for the full docblock + the
       *  consistency-pair contract (inviteType ↔ swapFromUserId). */
      inviteType?: 'member_join' | 'owner_swap_to_invited';
      swapFromUserId?: string;
    },
  ) {
    return this.invitationService.createInvitation(orgId, invitedBy, options);
  }
  getInvitationByToken(token: string) { return this.invitationService.getInvitationByToken(token); }
  async acceptInvitation(
    token: string,
    userId: string,
    log?: FastifyBaseLogger,
    /** Authenticated user's email — required when the invitation has
     *  recipient_email set (owner-invite shape). Verbatim from auth context;
     *  normalization happens inside invitationService.acceptInvitation. */
    userEmail?: string | null,
  ) {
    const result = await this.invitationService.acceptInvitation(token, userId, log, userEmail);
    // Seat-sync only fires on a successful membership outcome (not on a
    // discriminated-union failure case or null). The log+swallow API
    // contract on syncSeats still applies — Stripe push errors don't 5xx
    // the accept flow.
    if (result && !isAcceptInvitationError(result)) {
      await this.syncSeats(result.orgId);
    }
    return result;
  }
  listInvitations(orgId: string) { return this.invitationService.listInvitations(orgId); }
  revokeInvitation(invitationId: string, orgId: string) { return this.invitationService.revokeInvitation(invitationId, orgId); }

  // -------------------------------------------------------------------------
  // Tool allowlist (delegated to ToolAllowlistService)
  // -------------------------------------------------------------------------

  getToolAllowlist(orgId: string, vendorSlug: string, role: string) { return this.toolAllowlistService.getToolAllowlist(orgId, vendorSlug, role); }
  setToolAllowlist(orgId: string, vendorSlug: string, role: string, toolNames: string[], grantedBy: string) { return this.toolAllowlistService.setToolAllowlist(orgId, vendorSlug, role, toolNames, grantedBy); }
  clearToolAllowlist(orgId: string, vendorSlug: string, role: string) { return this.toolAllowlistService.clearToolAllowlist(orgId, vendorSlug, role); }
  getAllToolAllowlists(orgId: string, vendorSlug: string) { return this.toolAllowlistService.getAllToolAllowlists(orgId, vendorSlug); }
  // Team-scoped variants (WYREAI-59, parity port of gateway #189). Same shape as the role-scoped trio above; the schema CHECK enforces (team_id IS NULL) <> (role IS NULL) so a row is either-or by construction.
  getTeamToolAllowlist(orgId: string, teamId: string, vendorSlug: string) { return this.toolAllowlistService.getTeamToolAllowlist(orgId, teamId, vendorSlug); }
  setTeamToolAllowlist(orgId: string, teamId: string, vendorSlug: string, toolNames: string[], grantedBy: string) { return this.toolAllowlistService.setTeamToolAllowlist(orgId, teamId, vendorSlug, toolNames, grantedBy); }
  clearTeamToolAllowlist(orgId: string, teamId: string, vendorSlug: string) { return this.toolAllowlistService.clearTeamToolAllowlist(orgId, teamId, vendorSlug); }
  // WYREAI-62 — team allowlist with audit metadata (grantedBy label + grantedAt).
  getTeamToolAllowlistWithAudit(orgId: string, teamId: string, vendorSlug: string) { return this.toolAllowlistService.getTeamToolAllowlistWithAudit(orgId, teamId, vendorSlug); }

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
    // Layer 1: agent seat creation may change billableSeats (agent #3+
    // adds a $20 line; agents 1–2 don't move the quantity but the syncer
    // safely no-ops via the quantity-unchanged short-circuit).
    await this.syncSeats(entry.orgId);
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
    const deleted = result.count > 0;
    if (deleted) await this.syncSeats(orgId);
    return deleted;
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
  getUserTeamIds(userId: string) { return this.teamService.getUserTeamIds(userId); }
  grantTeamServerAccess(orgId: string, teamId: string, vendorSlug: string, grantedBy: string) { return this.teamService.grantServerAccess(orgId, teamId, vendorSlug, grantedBy); }
  revokeTeamServerAccess(teamId: string, vendorSlug: string) { return this.teamService.revokeServerAccess(teamId, vendorSlug); }
  listTeamServerAccess(teamId: string) { return this.teamService.listServerAccess(teamId); }
  listTeamsWithDetails(orgId: string) { return this.teamService.listTeamsWithDetails(orgId); }
  listEffectiveTeamAccessForOrg(orgId: string) { return this.teamService.listEffectiveTeamAccessForOrg(orgId); }
}
