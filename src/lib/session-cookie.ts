import type { Auth0User } from '../auth/auth0.js';

/**
 * Decode the `gateway_session` cookie payload. Returns `null` for any
 * unparseable input. Used by both the auth0 plugin's onRequest hook and
 * the index.ts fallback hook (when auth0 isn't registered) — keeping the
 * legacy-cookie failure-mode in one place is a security invariant.
 *
 * Legacy cookies (pre email-verified plumbing) lack `emailVerified`; we
 * read missing as `false` so they can't pass admin / domain-claim trust
 * gates until the user re-logs in. The session is otherwise valid, so
 * the user stays logged in.
 *
 * Caller is expected to have already validated the cookie signature via
 * `request.unsignCookie(...)`.
 */
export function decodeSessionCookie(rawValue: string): Auth0User | null {
  try {
    const json = Buffer.from(rawValue, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Partial<Auth0User>;
    if (!parsed || typeof parsed.sub !== 'string' || typeof parsed.email !== 'string') {
      return null;
    }
    return {
      sub: parsed.sub,
      email: parsed.email,
      name: parsed.name ?? '',
      emailVerified: parsed.emailVerified === true,
    };
  } catch {
    return null;
  }
}
