/**
 * On-prem tunnel enrollment token — M1 per-tunnel identity.
 *
 * M1 scope doc decision (iii): M1 ships a signed enrollment token as the
 * per-tunnel identity. Acceptable ONLY because M1 is echo-only — no
 * credentials, no real MCP server, no customer data on the wire. The blast
 * radius of a leaked M1 token is "an attacker can echo a string."
 *
 * Two hard constraints from the pre-ack:
 *   - SHORT-TTL / single-use-enrollment (analyst fold): the token is minted,
 *     used once to enroll a tunnel, and the live WSS session takes over.
 *     A short TTL bounds even M1's nil-risk bearer window. Default 5 min.
 *   - mTLS is a HARD M2 GATE (Gate A): this token-based identity is a
 *     skeleton-only convenience. M2 pre-ack cannot pass while a real MCP
 *     server or credential rides a token-only tunnel — mTLS supersedes this
 *     module before M2. Do NOT extend this module to carry M2 payloads.
 *
 * Signed with `config.jwtSecret` (HS256) via `jose`, matching conduit's
 * existing JWT posture (src/proxy/credential-injector.ts). The token binds
 * to exactly one subtenant — a tunnel for subtenant A can never enroll as B.
 */
import * as jose from 'jose';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

const ISSUER = config.baseUrl;
const AUDIENCE = 'onprem-tunnel-enrollment';
const DEFAULT_TTL_SECONDS = 300; // 5 minutes — short-TTL per the analyst fold.

function secret(): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

export interface EnrollmentClaims {
  /** The subtenant (org) this tunnel is bound to. */
  subtenantId: string;
  /** Capabilities the tunnel is being enrolled with. M1: ['echo']. */
  capabilities: string[];
}

/**
 * Mint a short-TTL enrollment token bound to one subtenant. Issued by WYRE
 * (the enrollment UX — forge open-decision #4, M2 — will call this; M1 mints
 * in tests / a manual enrollment step).
 */
export async function mintEnrollmentToken(
  claims: EnrollmentClaims,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  return new jose.SignJWT({
    subtenantId: claims.subtenantId,
    capabilities: claims.capabilities,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret());
}

export type VerifyResult =
  | { ok: true; claims: EnrollmentClaims; fingerprint: string }
  | { ok: false; reason: 'invalid_identity' | 'revoked_identity' | 'malformed' };

/**
 * Verify an enrollment token. Returns the bound subtenant + capabilities and
 * a stable fingerprint of the token (sha256, first 16 hex) for the registry's
 * `identity_fingerprint` column.
 *
 * The `reason` on failure is deliberately coarse — it maps 1:1 to
 * RegisterNackFrame.reason and MUST NOT leak which check failed in detail.
 *
 * M1 has no revocation list — `revoked_identity` is reserved for when M2
 * adds revocation. An expired or bad-signature token is `invalid_identity`.
 */
export async function verifyEnrollmentToken(token: string): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    payload = result.payload;
  } catch {
    // Bad signature, expired, wrong issuer/audience — all collapse to invalid.
    return { ok: false, reason: 'invalid_identity' };
  }

  const subtenantId = payload.subtenantId;
  const capabilities = payload.capabilities;
  if (typeof subtenantId !== 'string' || subtenantId.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
    return { ok: false, reason: 'malformed' };
  }

  return {
    ok: true,
    claims: { subtenantId, capabilities: capabilities as string[] },
    fingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16),
  };
}
