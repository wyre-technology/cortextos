/**
 * Adopt-by-email — reconcile an SSO login to a pre-existing user row.
 *
 * conduit resolves a login to a `users` row by subject id. When a row for
 * the same person already exists under a DIFFERENT id — a user migrated
 * from mcp-gateway under an old Auth0 sub, or a case-variant duplicate —
 * keying purely on the id mints a fresh, empty row and the person loses
 * their account. findAdoptableUserId() lets the login bind to the existing
 * row instead, matched case-insensitively on email.
 *
 * SECURITY — the gate is not optional. An email-keyed match is an
 * account-merge: binding a login to whatever row shares its email. Done on
 * an UNVERIFIED email it is an account-takeover primitive — an attacker
 * authenticates with an unverified address equal to a victim's and adopts
 * the victim's row. The caller passes `emailVerified` reflecting a
 * provider-specific proof:
 *   - Auth0: the `email_verified` token claim.
 *   - Azure AD: the login tenant is on ENTRA_TRUSTED_TENANT_IDS. The
 *     Conduit Entra app is multi-tenant, so an untrusted tenant can emit an
 *     arbitrary `email` claim; only a trusted-tenant login may adopt.
 * When `emailVerified` is false, no adopt occurs — the login falls through
 * to the normal insert-by-id path and gets a fresh row.
 */
import type postgres from 'postgres';

/**
 * Return the id of an existing user row this login should adopt, or null to
 * proceed with the normal insert-by-id path.
 *
 * Returns null when: the email is unverified/untrusted, the email is empty,
 * no row matches `lower(email)`, or the only match is already this `sub`.
 */
export async function findAdoptableUserId(
  sql: postgres.Sql,
  sub: string,
  email: string,
  emailVerified: boolean,
): Promise<string | null> {
  if (!emailVerified || !email) return null;
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  if (existing[0] && existing[0].id !== sub) {
    return existing[0].id;
  }
  return null;
}
