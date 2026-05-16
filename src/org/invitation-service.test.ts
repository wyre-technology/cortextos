import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { InvitationService } from './invitation-service.js';
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
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createMockSql() {
  const inviteRows = new Map<string, InvitationRowShape>();
  const memberRows: Record<string, unknown>[] = [];
  const insertStatements: string[] = [];
  const selectStatements: string[] = [];

  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('INSERT INTO org_invitations')) {
      insertStatements.push(text);
      // Contract: INSERT must not reference the legacy `token` column.
      // The fake SQL captures the statement; assertions inspect it.
      const [id, orgId, invitedBy, tokenHash, expiresAt, maxUses, useCount] = values as [
        string, string, string, string, string, number | null, number,
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
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  };

  return {
    sql: sql as unknown as postgres.Sql,
    inviteRows,
    insertStatements,
    selectStatements,
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
    expect(member?.orgId).toBe('org-1');
    expect(member?.userId).toBe('newuser-1');
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
});
