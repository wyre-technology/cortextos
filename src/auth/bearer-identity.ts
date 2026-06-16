import * as jose from 'jose';
import { config } from '../config.js';

/**
 * Verify a gateway-issued Bearer access token and return its subject (the
 * user/service-client id), or null when the header is absent, not a Bearer
 * token, or fails verification.
 *
 * Intentionally dependency-light (jose + config only) so the request-context
 * plugin can resolve the Bearer identity for the RLS GUC without importing the
 * heavy proxy/credential-injector module graph. Mirrors the verification in
 * `resolveUserId` (proxy/credential-injector.ts) — keep the two in lockstep.
 */
export async function resolveBearerUserId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const secret = new TextEncoder().encode(config.jwtSecret);
  try {
    const { payload } = await jose.jwtVerify(token, secret, { issuer: config.baseUrl });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
