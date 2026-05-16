import { getSql, type Sql } from '../db/context.js';
import { nanoid } from 'nanoid';
import type { OrgInvitation, OrgMember, CreatedInvitation } from './org-service.js';
import { MemberService } from './member-service.js';
import { hashInvitationToken } from './invitation-token-hash.js';

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
}

interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string | null;
  created_at: string;
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
    options?: { maxUses?: number | null; expiresInHours?: number },
  ): Promise<CreatedInvitation> {
    const id = nanoid();
    const plainToken = nanoid(32);
    const tokenHash = this.hashToken(plainToken);
    const expiresInHours = options?.expiresInHours ?? 168; // 7 days default
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const maxUses = options?.maxUses !== undefined ? options.maxUses : 1;

    // Contract phase (migration 015): only the hash persists. The plaintext
    // token is handed back to the caller exactly once for the invite URL.
    // Migration 011 added `token_hash` and dual-wrote both columns; the
    // legacy `token` column is dropped by 015 once this contract change is
    // in production. See PRD §8.4 / §A.19 for the SOC2 invariant: plaintext
    // never persists to disk.
    const rows = await this.sql<InvitationRow[]>`
      INSERT INTO org_invitations
        (id, org_id, invited_by, token_hash, expires_at, max_uses, use_count)
      VALUES
        (${id}, ${orgId}, ${invitedBy}, ${tokenHash}, ${expiresAt}, ${maxUses}, ${0})
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

  async acceptInvitation(token: string, userId: string): Promise<OrgMember | null> {
    const invitation = await this.getInvitationByToken(token);
    if (!invitation) return null;

    // Check if user is already a member
    const existing = await this.memberService.getMembership(invitation.orgId, userId);
    if (existing) return existing;

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

    // Create membership
    const memberId = nanoid();
    const rows = await this.sql<MemberRow[]>`
      INSERT INTO org_members (id, org_id, user_id, role, joined_at)
      VALUES (${memberId}, ${invitation.orgId}, ${userId}, 'member', NOW())
      ON CONFLICT (org_id, user_id) DO NOTHING
      RETURNING *
    `;

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
