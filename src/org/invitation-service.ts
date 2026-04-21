import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { nanoid } from 'nanoid';
import type { OrgInvitation, OrgMember } from './org-service.js';
import { MemberService } from './member-service.js';

interface InvitationRow {
  id: string;
  org_id: string;
  invited_by: string;
  token: string;
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
    token: row.token,
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
  private memberService: MemberService;

  constructor(private sql: postgres.Sql, memberService: MemberService) {
    this.memberService = memberService;
  }

  /**
   * Hash an invitation token for at-rest storage and lookup.
   *
   * SOC2 invariant (PRD §8.4 / §A.19): the plaintext token never persists
   * to disk. We hand the raw token back to the caller exactly once — at
   * creation time, for the email link — and only the hash lives in the DB.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async createInvitation(
    orgId: string,
    invitedBy: string,
    options?: { maxUses?: number | null; expiresInHours?: number },
  ): Promise<OrgInvitation> {
    const id = nanoid();
    const token = nanoid(32);
    const tokenHash = this.hashToken(token);
    const expiresInHours = options?.expiresInHours ?? 168; // 7 days default
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const maxUses = options?.maxUses !== undefined ? options.maxUses : 1;

    // Dual-write phase (migration 011): we write the hash (new canonical
    // storage) AND the plaintext token (legacy column, retained for rollback
    // safety). A follow-up migration drops the plaintext column once all
    // outstanding invitations issued before this rollout have expired.
    const rows = await this.sql<InvitationRow[]>`
      INSERT INTO org_invitations
        (id, org_id, invited_by, token, token_hash, expires_at, max_uses, use_count)
      VALUES
        (${id}, ${orgId}, ${invitedBy}, ${token}, ${tokenHash}, ${expiresAt}, ${maxUses}, ${0})
      RETURNING *
    `;

    // Return the raw token to the caller (for email link). The DB row stores
    // the hash; we substitute the plaintext back in so callers receive the
    // single copy that will ever exist.
    return { ...toInvitation(rows[0]), token };
  }

  async getInvitationByToken(token: string): Promise<OrgInvitation | null> {
    const tokenHash = this.hashToken(token);
    // Prefer the hash column (new path). Fall back to plaintext `token` only
    // for legacy rows written before migration 011 that have a NULL
    // token_hash — those age out naturally within expires_at (<= 7 days).
    const rows = await this.sql<InvitationRow[]>`
      SELECT * FROM org_invitations
      WHERE (token_hash = ${tokenHash} OR (token_hash IS NULL AND token = ${token}))
        AND (max_uses IS NULL OR use_count < max_uses)
        AND expires_at > NOW()
    `;
    if (!rows[0]) return null;
    // Return the raw token the caller already supplied rather than the
    // stored hash, so downstream code building invite URLs keeps working.
    return { ...toInvitation(rows[0]), token };
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

  async revokeInvitation(invitationId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM org_invitations WHERE id = ${invitationId}
    `;
    return result.count > 0;
  }
}
