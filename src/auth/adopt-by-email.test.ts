/**
 * Unit coverage for findAdoptableUserId — the adopt-by-email decision.
 *
 * The security-load-bearing cases are the negatives: an unverified /
 * untrusted-tenant login must NOT adopt (no account-merge on an unproven
 * email). Those are covered here alongside the positive reconcile case.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { findAdoptableUserId } from './adopt-by-email.js';

/** Tagged-template stub returning a fixed row set; records whether it ran. */
function fakeSql(rows: { id: string }[]) {
  const tag = vi.fn(() => Promise.resolve(rows));
  return { sql: tag as unknown as postgres.Sql, tag };
}

describe('findAdoptableUserId — security gate (no adopt on unproven email)', () => {
  it('returns null when emailVerified is false — and does not even query', async () => {
    const { sql, tag } = fakeSql([{ id: 'victim-id' }]);
    const result = await findAdoptableUserId(sql, 'attacker-sub', 'victim@example.com', false);
    expect(result).toBeNull();
    expect(tag).not.toHaveBeenCalled();
  });

  it('returns null when email is empty', async () => {
    const { sql, tag } = fakeSql([{ id: 'whatever' }]);
    const result = await findAdoptableUserId(sql, 'some-sub', '', true);
    expect(result).toBeNull();
    expect(tag).not.toHaveBeenCalled();
  });
});

describe('findAdoptableUserId — adopt decision', () => {
  it('returns the existing id when a verified email matches a row under a different id', async () => {
    const { sql } = fakeSql([{ id: 'auth0|migrated-row' }]);
    const result = await findAdoptableUserId(sql, 'oid-fresh-sub', 'Aaron@Example.com', true);
    expect(result).toBe('auth0|migrated-row');
  });

  it('returns null when the matching row is already this sub (no self-adopt)', async () => {
    const { sql } = fakeSql([{ id: 'same-sub' }]);
    const result = await findAdoptableUserId(sql, 'same-sub', 'user@example.com', true);
    expect(result).toBeNull();
  });

  it('returns null when no row matches the email', async () => {
    const { sql } = fakeSql([]);
    const result = await findAdoptableUserId(sql, 'new-sub', 'brand-new@example.com', true);
    expect(result).toBeNull();
  });
});
