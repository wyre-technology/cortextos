import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { InvitationService, OwnerInviteAuthzError } from './invitation-service.js';
import { MemberService } from './member-service.js';
import { enterTestContext } from '../db/context.js';

// =============================================================================
// Tests pin the post-015 contract for InvitationService:
//
//   1. createInvitation returns { invitation, plainToken }. The invitation
//      row carries the hash; plaintext is handed back exactly once for the
//      caller to embed in the invite URL.
//   2. The INSERT does NOT write the plaintext token column. Only token_hash.
//   3. getInvitationByToken hashes the supplied token and looks up by hash
//      only. The legacy OR-NULL fallback (for pre-011 rows that have
//      plaintext-only) is removed: those rows have aged out (max expires_at
//      is 7 days; rollout was >7 days ago).
//   4. listInvitations returns OrgInvitation rows with NO token field.
//   5. acceptInvitation chains through getInvitationByToken correctly under
//      the hash-only lookup.
//
// These tests fail against the current pre-015 service (which dual-writes
// token + token_hash and uses an OR-NULL dual-read). They pass after the
// contract-phase refactor lands.
// =============================================================================

interface InvitationRowShape {
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

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createMockSql() {
  const inviteRows = new Map<string, InvitationRowShape>();
  const memberRows: Record<string, unknown>[] = [];
  const ownerships = new Map<string, Record<string, unknown>>();
  const insertStatements: string[] = [];
  const selectStatements: string[] = [];

  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('INSERT INTO org_invitations')) {
      insertStatements.push(text);
      // Contract: INSERT must not reference the legacy `token` column.
      // The fake SQL captures the statement; assertions inspect it.
      // Layer 1: 9 positional values — intended_role + recipient_email
      // appended (migrations 010 + 034).
      const [
        id, orgId, invitedBy, tokenHash, expiresAt, maxUses, useCount,
        intendedRole, recipientEmail,
      ] = values as [
        string, string, string, string, string, number | null, number,
        string | null, string | null,
      ];
      const row: InvitationRowShape = {
        id,
        org_id: orgId,
        invited_by: invitedBy,
        token_hash: tokenHash,
        expires_at: expiresAt,
        accepted_by: null,
        accepted_at: null,
        max_uses: maxUses,
        use_count: useCount,
        created_at: new Date().toISOString(),
        intended_role: intendedRole,
        recipient_email: recipientEmail,
      };
      inviteRows.set(id, row);
      return Promise.resolve([row]);
    }

    // Order matters: the org_id (list) variant must match before the
    // generic token_hash (lookup) variant — both are SELECTs with WHERE
    // and we disambiguate on the column referenced.
    if (text.includes('SELECT * FROM org_invitations') && text.includes('org_id')) {
      selectStatements.push(text);
      const orgId = values[0] as string;
      const matches = [...inviteRows.values()].filter((r) => {
        const usable = (r.max_uses === null || r.use_count < r.max_uses)
          && new Date(r.expires_at) > new Date();
        return r.org_id === orgId && usable;
      });
      return Promise.resolve(matches);
    }

    if (text.includes('SELECT * FROM org_invitations') && text.includes('token_hash')) {
      selectStatements.push(text);
      // Contract: lookup is by token_hash only. No OR-NULL fallback.
      const tokenHash = values[0] as string;
      const matches = [...inviteRows.values()].filter((r) => {
        const usable = (r.max_uses === null || r.use_count < r.max_uses)
          && new Date(r.expires_at) > new Date();
        return r.token_hash === tokenHash && usable;
      });
      return Promise.resolve(matches);
    }

    if (text.includes('UPDATE org_invitations')) {
      // accept-path: increment use_count + maybe stamp accepted_*
      return Promise.resolve([]);
    }

    if (text.includes('INSERT INTO org_members')) {
      memberRows.push({ id: values[0], org_id: values[1], user_id: values[2], role: values[3] });
      return Promise.resolve([{
        id: values[0],
        org_id: values[1],
        user_id: values[2],
        role: values[3],
        joined_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }]);
    }

    if (text.includes('SELECT * FROM org_members')) {
      // Convention: in this test substrate, "owner-1" is the owner of
      // "org-1". The owner-mint authz guard at createInvitation (lifted
      // to runtime per task_1779464309991) calls getMembership(orgId,
      // invitedBy) — return a matching owner row for the canonical pair,
      // empty otherwise. Individual tests that need a different membership
      // can use the seedMembership helper exposed on the mock.
      const orgId = values[0] as string;
      const userId = values[1] as string;
      const seeded = ownerships.get(`${orgId}:${userId}`);
      if (seeded) return Promise.resolve([seeded]);
      // Default convention: owner-1 / org-1 is an owner.
      if (orgId === 'org-1' && userId === 'owner-1') {
        return Promise.resolve([{
          id: 'm_default_owner',
          org_id: 'org-1',
          user_id: 'owner-1',
          role: 'owner',
          joined_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }]);
      }
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  };

  return {
    sql: sql as unknown as postgres.Sql,
    inviteRows,
    insertStatements,
    selectStatements,
    /** Seed a membership row visible to memberService.getMembership.
     *  Used by tests asserting the owner-mint authz guard against
     *  non-owner inviters. */
    seedMembership(orgId: string, userId: string, role: 'owner' | 'admin' | 'member'): void {
      ownerships.set(`${orgId}:${userId}`, {
        id: `m_seeded_${orgId}_${userId}`,
        org_id: orgId,
        user_id: userId,
        role,
        joined_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    },
  };
}

describe('InvitationService — post-015 contract', () => {
  let mock: ReturnType<typeof createMockSql>;
  let svc: InvitationService;

  beforeEach(() => {
    mock = createMockSql();
    enterTestContext(mock.sql);
    const memberSvc = new MemberService();
    svc = new InvitationService(memberSvc);
  });

  // ---------------------------------------------------------------------------
  // (1) createInvitation return shape
  // ---------------------------------------------------------------------------

  it('createInvitation returns { invitation, plainToken } as separate fields', async () => {
    const result = await svc.createInvitation('org-1', 'user-1');

    expect(result).toHaveProperty('invitation');
    expect(result).toHaveProperty('plainToken');
    expect(typeof result.plainToken).toBe('string');
    expect(result.plainToken.length).toBeGreaterThanOrEqual(20);
  });

  it('createInvitation invitation row carries no plaintext token', async () => {
    const result = await svc.createInvitation('org-1', 'user-1');
    // The invitation object surfaced to callers must not leak plaintext.
    expect((result.invitation as unknown as Record<string, unknown>).token).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // (2) INSERT writes only the hash
  // ---------------------------------------------------------------------------

  it('createInvitation INSERT does NOT include the legacy `token` column', async () => {
    await svc.createInvitation('org-1', 'user-1');
    const insertText = mock.insertStatements.join(' ');
    // Column list must not contain a bare `token` column reference.
    // (token_hash is allowed — that's the new canonical storage.)
    const tokenColumnRefs = (insertText.match(/[,\s(]token[\s,)]/g) ?? []);
    expect(tokenColumnRefs).toEqual([]);
    expect(insertText).toMatch(/token_hash/);
  });

  // ---------------------------------------------------------------------------
  // (3) getInvitationByToken: hash-only lookup, no OR-NULL fallback
  // ---------------------------------------------------------------------------

  it('getInvitationByToken finds an invitation issued in the same flow', async () => {
    const { plainToken } = await svc.createInvitation('org-1', 'user-1');
    const found = await svc.getInvitationByToken(plainToken);
    expect(found).not.toBeNull();
    expect(found?.orgId).toBe('org-1');
  });

  it('getInvitationByToken returns null for an unknown token', async () => {
    await svc.createInvitation('org-1', 'user-1');
    const found = await svc.getInvitationByToken('not-the-real-token');
    expect(found).toBeNull();
  });

  it('getInvitationByToken SQL has NO `token_hash IS NULL` legacy fallback', async () => {
    await svc.createInvitation('org-1', 'user-1');
    await svc.getInvitationByToken('whatever');
    const selectText = mock.selectStatements.join(' ');
    // The pre-015 service used `WHERE (token_hash = ? OR (token_hash IS NULL AND token = ?))`.
    // Post-015, that fallback must be gone.
    expect(selectText).not.toMatch(/token_hash\s+IS\s+NULL/i);
    expect(selectText).not.toMatch(/AND\s+token\s*=/i);
  });

  it('getInvitationByToken returned object has no token field', async () => {
    const { plainToken } = await svc.createInvitation('org-1', 'user-1');
    const found = await svc.getInvitationByToken(plainToken);
    expect(found).not.toBeNull();
    expect((found as unknown as Record<string, unknown>).token).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // (4) listInvitations returns rows without token
  // ---------------------------------------------------------------------------

  it('listInvitations returns rows with NO token field', async () => {
    await svc.createInvitation('org-1', 'user-1');
    await svc.createInvitation('org-1', 'user-1');
    const list = await svc.listInvitations('org-1');
    expect(list).toHaveLength(2);
    for (const inv of list) {
      expect((inv as unknown as Record<string, unknown>).token).toBeUndefined();
    }
  });

  // ---------------------------------------------------------------------------
  // (5) acceptInvitation still works under hash-only lookup
  // ---------------------------------------------------------------------------

  it('acceptInvitation resolves the row by hashing the plaintext token', async () => {
    const { plainToken } = await svc.createInvitation('org-1', 'inviter-1');
    const member = await svc.acceptInvitation(plainToken, 'newuser-1');
    expect(member).not.toBeNull();
    // Member-invite path → OrgMember (no discriminated-error kind).
    expect(member).not.toHaveProperty('kind');
    expect((member as { orgId: string }).orgId).toBe('org-1');
    expect((member as { userId: string }).userId).toBe('newuser-1');
  });

  it('acceptInvitation returns null for an unknown token', async () => {
    await svc.createInvitation('org-1', 'inviter-1');
    const member = await svc.acceptInvitation('bogus-token', 'newuser-1');
    expect(member).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Smoke: the hash function we use in tests matches the service's own
  // ---------------------------------------------------------------------------

  it('plaintext token round-trips through sha256(plaintext) === stored hash', async () => {
    const { plainToken } = await svc.createInvitation('org-1', 'user-1');
    const expectedHash = hash(plainToken);
    const rows = [...mock.inviteRows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(expectedHash);
  });

  // ---------------------------------------------------------------------------
  // Layer 1 owner-invite-delivery: intended_role + recipient_email persistence
  // ---------------------------------------------------------------------------

  it('createInvitation persists intendedRole when opts.intendedRole is set', async () => {
    await svc.createInvitation('org-1', 'owner-1', { intendedRole: 'owner' });
    const rows = [...mock.inviteRows.values()];
    expect(rows[0].intended_role).toBe('owner');
  });

  it('createInvitation persists NULL intended_role when not specified (legacy/(α) shape)', async () => {
    await svc.createInvitation('org-1', 'owner-1');
    const rows = [...mock.inviteRows.values()];
    expect(rows[0].intended_role).toBeNull();
  });

  it('createInvitation NORMALIZES recipientEmail at store time (case-insensitive invariant)', async () => {
    // Same normalization function (src/email/normalize.ts) used at the
    // accept-time check. Storing the normalized form is the DRY-invariant
    // half — the comparison half normalizes the auth.user.email value.
    await svc.createInvitation('org-1', 'owner-1', {
      intendedRole: 'owner',
      recipientEmail: '  ADMIN@Customer.IO  ',
    });
    const rows = [...mock.inviteRows.values()];
    expect(rows[0].recipient_email).toBe('admin@customer.io');
  });

  it('createInvitation persists NULL recipient_email when not specified (share-link/(α) shape)', async () => {
    await svc.createInvitation('org-1', 'owner-1');
    const rows = [...mock.inviteRows.values()];
    expect(rows[0].recipient_email).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Layer 1 acceptInvitation: email-match guard (β) for invites with recipient_email
  // ---------------------------------------------------------------------------

  it('acceptInvitation returns email_mismatch when recipient_email is set and userEmail differs', async () => {
    const { plainToken } = await svc.createInvitation('org-1', 'inviter-1', {
      recipientEmail: 'invited@customer.io',
    });
    const result = await svc.acceptInvitation(plainToken, 'newuser-1', undefined, 'attacker@elsewhere.com');
    expect(result).toEqual(
      expect.objectContaining({ kind: 'email_mismatch' }),
    );
  });

  it('acceptInvitation email-match is CASE-INSENSITIVE (same normalizer both ends)', async () => {
    // Stored "admin@customer.io" (normalized); incoming "ADMIN@Customer.IO".
    // Both routes through normalizeEmail → match. The RFC-routing-semantic
    // invariant via shared util.
    const { plainToken } = await svc.createInvitation('org-1', 'inviter-1', {
      recipientEmail: 'admin@customer.io',
    });
    const result = await svc.acceptInvitation(plainToken, 'newuser-1', undefined, 'ADMIN@Customer.IO');
    // Either a member (member-invite path with email-match passing) or
    // null on edge cases; what matters is it's NOT an email_mismatch error.
    expect(result).not.toEqual(expect.objectContaining({ kind: 'email_mismatch' }));
  });

  it('acceptInvitation returns email_mismatch when userEmail is undefined on a recipient_email-bound invite', async () => {
    // Defense: missing auth email on an email-bound invite is treated as
    // mismatch (rather than allow-through), so a bug in the auth-context
    // wiring fails-closed.
    const { plainToken } = await svc.createInvitation('org-1', 'inviter-1', {
      recipientEmail: 'invited@customer.io',
    });
    const result = await svc.acceptInvitation(plainToken, 'newuser-1', undefined, undefined);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'email_mismatch' }),
    );
  });

  it('acceptInvitation does NOT enforce email-match when recipient_email is NULL (legacy (α) tolerance)', async () => {
    // Pre-Layer-1 / share-link invites have NULL recipient_email and
    // accept any authenticated user. New owner-invite code paths never
    // write NULL on the owner path; legacy tolerance lives for the
    // rollout window per migration 034 + the paired-follow-up task.
    const { plainToken } = await svc.createInvitation('org-1', 'inviter-1');
    const result = await svc.acceptInvitation(plainToken, 'newuser-1', undefined, 'anyone@anywhere.com');
    expect(result).not.toEqual(expect.objectContaining({ kind: 'email_mismatch' }));
  });

  // ---------------------------------------------------------------------------
  // Owner-mint authz guard at createInvitation — lifted from by-construction
  // call-site discipline to runtime structural check per task_1779464309991.
  // ---------------------------------------------------------------------------

  it('createInvitation throws OwnerInviteAuthzError when inviter is NOT the current owner', async () => {
    // Inviter 'attacker-1' has no membership in org-1 → memberService.getMembership
    // returns null → guard throws. Convention-to-structure conversion: today
    // the only owner-mint caller (reseller/routes.ts customer-create) passes
    // by construction; tomorrow this catches new callers structurally.
    await expect(
      svc.createInvitation('org-1', 'attacker-1', { intendedRole: 'owner' }),
    ).rejects.toThrow(OwnerInviteAuthzError);
  });

  it('createInvitation throws OwnerInviteAuthzError when inviter is a member-but-not-owner', async () => {
    // Inviter is a member of the org (legit access) but NOT owner → still
    // refused. Member self-promotion-via-invite is the privilege-escalation
    // surface this guard closes.
    mock.seedMembership('org-1', 'member-1', 'member');
    await expect(
      svc.createInvitation('org-1', 'member-1', { intendedRole: 'owner' }),
    ).rejects.toThrow(OwnerInviteAuthzError);
  });

  it('createInvitation throws OwnerInviteAuthzError when inviter is admin-but-not-owner', async () => {
    // Admin role !== owner role; admin escalation is refused.
    mock.seedMembership('org-1', 'admin-1', 'admin');
    await expect(
      svc.createInvitation('org-1', 'admin-1', { intendedRole: 'owner' }),
    ).rejects.toThrow(OwnerInviteAuthzError);
  });

  it('createInvitation SUCCEEDS for owner-invite when inviter IS the current owner', async () => {
    // Happy path: owner-1 is the seeded owner of org-1 (default convention
    // in the mock). The runtime check passes → INSERT proceeds.
    const result = await svc.createInvitation('org-1', 'owner-1', {
      intendedRole: 'owner',
      recipientEmail: 'newowner@customer.io',
    });
    expect(result.invitation.intendedRole).toBe('owner');
    expect(result.invitation.recipientEmail).toBe('newowner@customer.io');
  });

  it('createInvitation guard does NOT fire for non-owner intendedRole (member/admin invites unchanged)', async () => {
    // Member-invite path: inviter need not be owner. The guard runs only
    // when intendedRole === 'owner'; admin/member invites preserve the
    // existing flexibility (any member can mint a non-owner invite per
    // route-layer requireOrgRole gates).
    await expect(
      svc.createInvitation('org-1', 'random-inviter', { intendedRole: 'member' }),
    ).resolves.toBeDefined();
    await expect(
      svc.createInvitation('org-1', 'random-inviter', /* no intendedRole */),
    ).resolves.toBeDefined();
  });

  it('OwnerInviteAuthzError carries orgId + invitedBy for caller-side recovery', async () => {
    // Discriminated-error-shape discipline — caller can map to a precise
    // HTTP response (403) with the right context rather than a generic 500.
    try {
      await svc.createInvitation('org-1', 'attacker-1', { intendedRole: 'owner' });
    } catch (err) {
      expect(err).toBeInstanceOf(OwnerInviteAuthzError);
      expect((err as OwnerInviteAuthzError).orgId).toBe('org-1');
      expect((err as OwnerInviteAuthzError).invitedBy).toBe('attacker-1');
      expect((err as Error).name).toBe('OwnerInviteAuthzError');
      return;
    }
    throw new Error('createInvitation should have thrown OwnerInviteAuthzError');
  });
});
