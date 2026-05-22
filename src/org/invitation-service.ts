import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';
import type { OrgInvitation, OrgMember, CreatedInvitation, OrgRole } from './org-service.js';
import { MemberService } from './member-service.js';
import { hashInvitationToken } from './invitation-token-hash.js';
import { notifyNewSignup } from '../billing/sales-notifier.js';
import { normalizeEmail } from '../email/normalize.js';
import type { FastifyBaseLogger } from 'fastify';

interface InvitationRow {
  id: string;
  org_id: string;
  invited_by: string;
  token_hash: string;
  expires_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  max_uses: number | null;
  use_count: number;
  created_at: string;
  intended_role: string | null;
  recipient_email: string | null;
}

interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string | null;
  created_at: string;
}

/**
 * Discriminated-union failure modes from acceptInvitation. The HTTP layer
 * maps each kind to the right status + named-actionable-choice message
 * per the route-helpers pattern. Null return (no invitation found / token
 * invalid) stays as null per the existing contract.
 */
export type AcceptInvitationError =
  | { kind: 'email_mismatch'; message: string }
  | { kind: 'owner_invite_scope_violation'; message: string };

export function isAcceptInvitationError(
  result: OrgMember | AcceptInvitationError | null,
): result is AcceptInvitationError {
  return (
    result !== null
    && typeof result === 'object'
    && 'kind' in result
    && (result.kind === 'email_mismatch' || result.kind === 'owner_invite_scope_violation')
  );
}

function toInvitation(row: InvitationRow): OrgInvitation {
  return {
    id: row.id,
    orgId: row.org_id,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    createdAt: row.created_at,
    intendedRole: row.intended_role as OrgRole | null,
    recipientEmail: row.recipient_email,
  };
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

export class InvitationService {
  /** Resolves to the active request- or system-path connection. See src/db/context.ts. */
  private get sql(): Sql {
    return getSql();
  }

  private memberService: MemberService;

  constructor(memberService: MemberService) {
    this.memberService = memberService;
  }

  /**
   * Hash an invitation token for at-rest storage and lookup. Delegates to
   * the shared util in `invitation-token-hash.ts` so the backfill script
   * (`scripts/backfill-invitation-tokens.ts`) provably uses the same
   * implementation. Drift between the two = silent backfill miss.
   */
  private hashToken(token: string): string {
    return hashInvitationToken(token);
  }

  async createInvitation(
    orgId: string,
    invitedBy: string,
    options?: {
      maxUses?: number | null;
      expiresInHours?: number;
      /**
       * Role granted on accept. Defaults to 'member' (NULL in DB → legacy
       * pre-Layer-1 behavior, which acceptInvitation treats as 'member').
       * 'owner' triggers the atomic-swap path on accept; AUTHORIZATION
       * GUARD: callers minting an owner-invite must verify the inviter
       * is the current owner of the org BEFORE calling this method —
       * see acceptInvitation security comment for the threat model.
       */
      intendedRole?: OrgRole;
      /**
       * Email the invite is bound to. When provided, normalized via
       * src/email/normalize.ts (lowercase + trim) before storage so the
       * accept-time match is case-insensitive. When NOT provided
       * (shareable-link flow), the invite is null-recipient and accepts
       * any authenticated user (the (α) model).
       */
      recipientEmail?: string;
    },
  ): Promise<CreatedInvitation> {
    const id = nanoid();
    const plainToken = nanoid(32);
    const tokenHash = this.hashToken(plainToken);
    const expiresInHours = options?.expiresInHours ?? 168; // 7 days default
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const maxUses = options?.maxUses !== undefined ? options.maxUses : 1;
    const intendedRole = options?.intendedRole ?? null;
    // Normalize at the store site so the accept-time check uses the same
    // shape. Shared util in src/email/normalize.ts (DRY).
    const recipientEmail = options?.recipientEmail
      ? normalizeEmail(options.recipientEmail)
      : null;

    // Contract phase (migration 015): only the hash persists. The plaintext
    // token is handed back to the caller exactly once for the invite URL.
    // Migration 011 added `token_hash` and dual-wrote both columns; the
    // legacy `token` column is dropped by 015 once this contract change is
    // in production. See PRD §8.4 / §A.19 for the SOC2 invariant: plaintext
    // never persists to disk.
    //
    // intended_role + recipient_email persist Layer 1's owner-invite payload
    // shape (migrations 010 + 034). NULL on both = legacy pre-Layer-1
    // invitation = (α) member-shape behavior on accept.
    const rows = await this.sql<InvitationRow[]>`
      INSERT INTO org_invitations
        (id, org_id, invited_by, token_hash, expires_at, max_uses, use_count, intended_role, recipient_email)
      VALUES
        (${id}, ${orgId}, ${invitedBy}, ${tokenHash}, ${expiresAt}, ${maxUses}, ${0}, ${intendedRole}, ${recipientEmail})
      RETURNING *
    `;

    return { invitation: toInvitation(rows[0]), plainToken };
  }

  async getInvitationByToken(token: string): Promise<OrgInvitation | null> {
    const tokenHash = this.hashToken(token);
    // Hash-only lookup. The pre-015 dual-read fallback for legacy rows with
    // NULL token_hash is removed: those rows had a max 7-day TTL and the
    // 011 rollout was >7 days before this lands, so any survivors are stale.
    const rows = await this.sql<InvitationRow[]>`
      SELECT * FROM org_invitations
      WHERE token_hash = ${tokenHash}
        AND (max_uses IS NULL OR use_count < max_uses)
        AND expires_at > NOW()
    `;
    if (!rows[0]) return null;
    return toInvitation(rows[0]);
  }

  /**
   * Possible failure modes from acceptInvitation. Discriminated union so
   * callers can route on the kind without parsing error messages.
   */
  async acceptInvitation(
    token: string,
    userId: string,
    log?: FastifyBaseLogger,
    /**
     * Authenticated user's email — required when invitation.recipient_email
     * IS NOT NULL (the email-match guard fires). Pass auth.user.email
     * verbatim; normalization happens inside this method (DRY via
     * src/email/normalize.ts).
     *
     * Optional because legacy invitations created before migration 034
     * have NULL recipient_email and accept any authenticated user (the
     * pre-Layer-1 (α) shape, preserved during the rollout window).
     */
    userEmail?: string | null,
  ): Promise<OrgMember | AcceptInvitationError | null> {
    const invitation = await this.getInvitationByToken(token);
    if (!invitation) return null;

    // ─────────────────────────────────────────────────────────────────────
    // SECURITY MODEL — accept-invitation
    //
    // Attack model addressed (warden ratify msg 1779450054436 + 1779450140052):
    //   The bare token-hash + max_uses=1 + TTL + auth-required defense
    //   (the pre-Layer-1 (α) shape) is sufficient for member-invites.
    //   For owner-invites it is NOT — a leaked link allows any attacker
    //   with any authentic IdP session to claim ownership via the
    //   atomic-swap path. The leaked-link → ownership-takeover surface
    //   needs an explicit defense.
    //
    // Disposition shipped (β) for owner-invites:
    //   When invitation.recipient_email IS NOT NULL, accept requires
    //   normalize(userEmail) === recipient_email. Mismatch → returns
    //   { kind: 'email_mismatch' }. The customer-create flow ALWAYS
    //   populates recipient_email; new owner-invites carry the guard
    //   by construction.
    //
    // Legacy null-tolerance (rollout window, terminus = naturally expire):
    //   invitations created before 2026-05-22 have NULL recipient_email
    //   and accept any authenticated user (the (α) shape). New code paths
    //   never write NULL on the owner-invite branch. In-flight invitations
    //   expire naturally per max_uses=1 + 7-day TTL — no backfill risk.
    //
    // Paired follow-up (task_1779450095130): extend the same email-match
    // shape to member-invites. Discipline does not fork between the two
    // invite types; the normalize-once via shared util survives the
    // extension.
    // ─────────────────────────────────────────────────────────────────────
    if (invitation.recipientEmail) {
      const callerEmail = userEmail ? normalizeEmail(userEmail) : '';
      if (!callerEmail || callerEmail !== invitation.recipientEmail) {
        return {
          kind: 'email_mismatch',
          message:
            'This invitation is addressed to a different email address. ' +
            'Sign in with the invited account, or ask an organization admin ' +
            'to reissue the invitation to your current address.',
        };
      }
    }

    // Increment use_count; for single-use invites also set accepted_by/accepted_at
    if (invitation.maxUses === 1) {
      await this.sql`
        UPDATE org_invitations
        SET use_count = use_count + 1, accepted_by = ${userId}, accepted_at = NOW()
        WHERE id = ${invitation.id}
      `;
    } else {
      await this.sql`
        UPDATE org_invitations
        SET use_count = use_count + 1
        WHERE id = ${invitation.id}
      `;
    }

    // ─────────────────────────────────────────────────────────────────────
    // ROLE BRANCH — owner-invite atomic-swap vs member-invite INSERT
    // ─────────────────────────────────────────────────────────────────────
    if (invitation.intendedRole === 'owner') {
      // STRUCTURAL ASSERTION — owner-invite is reseller-channel-only by
      // design (ruby billing-sanity flag msg 1779449975616). Customer orgs
      // are billed via reseller path with no direct Stripe sub; firing the
      // atomic-swap on a standalone org with a stripeSubscriptionId would
      // (in a future seat-syncer reorganization) cause a transient
      // N+1 → N quantity divergence the idempotent short-circuit would
      // mask — silent-rot class. The check converts the discipline from
      // comment to assertion per the comment-vs-assertion discriminator
      // (ruby msg 1779450010433): existing safety nets MASK the violation,
      // so the structural defense is an assertion at the boundary.
      const orgRow = await this.sql<Array<{ type: string | null; stripe_subscription_id: string | null }>>`
        SELECT type, stripe_subscription_id FROM organizations WHERE id = ${invitation.orgId}
      `;
      if (orgRow[0] && orgRow[0].type !== 'customer') {
        return {
          kind: 'owner_invite_scope_violation',
          message:
            'Owner-invites are reseller-channel-only by design (Layer 1 ' +
            'customer-create → first-owner-claim transition). This invite ' +
            'targets a non-customer org which violates the design invariant.',
        };
      }

      // ATOMIC SWAP — INSERT (or promote) new owner + DELETE all OTHER owners.
      //
      // SCOPE WARNING (warden ratify msg 1779450054436): this DELETE-all-others
      // is scoped to the CUSTOMER-CREATE → FIRST-OWNER-CLAIM transition.
      // For any FUTURE multi-owner owner-transfer use case, the DELETE
      // predicate must filter on the specific interim-owner user_id (or
      // otherwise narrow) — NOT blanket-delete-all-others, or legitimate
      // co-owners get silently wiped. Future contributors copy-pasting
      // this pattern into an owner-transfer flow must read this warning.
      //
      // Single tx refuses the half-state "two owners simultaneously" race
      // (concurrent tx waits on row-lock or sees committed state).
      let memberRows: MemberRow[] = [];
      await this.sql.begin(async (tx) => {
        const inserted = await tx<MemberRow[]>`
          INSERT INTO org_members (id, org_id, user_id, role, joined_at)
          VALUES (${nanoid()}, ${invitation.orgId}, ${userId}, 'owner', NOW())
          ON CONFLICT (org_id, user_id) DO UPDATE
            SET role = 'owner', joined_at = COALESCE(org_members.joined_at, NOW())
          RETURNING *
        `;
        memberRows = inserted;
        await tx`
          DELETE FROM org_members
          WHERE org_id = ${invitation.orgId}
            AND role = 'owner'
            AND user_id != ${userId}
        `;
      });

      if (memberRows[0] && log) {
        void notifyNewSignup(this.sql, { userId, orgId: invitation.orgId, isOwner: true }, log);
      }
      return memberRows[0] ? toMember(memberRows[0]) : null;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Default (member-invite) branch — pre-Layer-1 (α) shape preserved.
    // ─────────────────────────────────────────────────────────────────────
    // Idempotent join: if already a member, return the existing membership.
    // (Owner-branch above intentionally re-runs the swap on duplicate
    // acceptance — that's the desired behavior for ownership clarification.)
    const existing = await this.memberService.getMembership(invitation.orgId, userId);
    if (existing) return existing;

    const memberId = nanoid();
    const rows = await this.sql<MemberRow[]>`
      INSERT INTO org_members (id, org_id, user_id, role, joined_at)
      VALUES (${memberId}, ${invitation.orgId}, ${userId}, 'member', NOW())
      ON CONFLICT (org_id, user_id) DO NOTHING
      RETURNING *
    `;

    if (rows[0] && log) {
      void notifyNewSignup(this.sql, { userId, orgId: invitation.orgId, isOwner: false }, log);
    }

    return rows[0] ? toMember(rows[0]) : await this.memberService.getMembership(invitation.orgId, userId);
  }

  async listInvitations(orgId: string): Promise<OrgInvitation[]> {
    const rows = await this.sql<InvitationRow[]>`
      SELECT * FROM org_invitations
      WHERE org_id = ${orgId}
        AND (max_uses IS NULL OR use_count < max_uses)
        AND expires_at > NOW()
      ORDER BY created_at DESC
    `;
    return rows.map((r) => toInvitation(r));
  }

  /**
   * Revoke a pending invitation. The DELETE is scoped by `orgId` as well as
   * `invitationId`: the route authorizes the caller against :orgId, but the
   * invitation id alone is not org-bound, so an unscoped DELETE lets an admin
   * of one org revoke another org's invitations. Scoping at the SQL layer
   * makes a cross-org id match zero rows; the caller treats that as not-found.
   */
  async revokeInvitation(invitationId: string, orgId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_invitations WHERE id = ${invitationId} AND org_id = ${orgId}
    `;
    return result.count > 0;
  }
}
