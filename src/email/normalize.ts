/**
 * Email normalization — single source of truth for both STORE and CHECK
 * paths. Per warden ratify (msg 1779450140052) on the case-insensitive
 * matching invariant for invitation email-match.
 *
 * Emails are case-insensitive per RFC 5321 routing semantics:
 * "Alice@Example.com" routes the same mailbox as "alice@example.com".
 * Stored-and-compared values MUST go through the same normalization
 * function or a case-mismatch (e.g. wizard accepts "Admin@Customer.Com"
 * while Auth0 returns "admin@customer.com") produces a false "your
 * email doesn't match" error.
 *
 * The DRY shape is the structural invariant: future normalization
 * changes touch one site (this file), not two divergent call sites.
 */

/**
 * Normalize an email address for storage and comparison.
 *
 * - Trims surrounding whitespace (handles wizard form input with trailing
 *   space).
 * - Lowercases the entire string. Strict RFC 5321 only requires the
 *   domain to be case-insensitive (the local-part is technically case-
 *   sensitive), but every real-world mail provider treats the local-part
 *   case-insensitively. Following industry convention beats RFC
 *   pedantry on this surface.
 *
 * Returns the normalized string. Does NOT validate that the input is a
 * well-formed email address — that's the caller's responsibility (existing
 * src/signup/routes.ts validateEmail for instance).
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
