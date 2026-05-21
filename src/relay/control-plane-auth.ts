/**
 * Gateway↔relay control-plane HMAC signing.
 *
 * PR #2 scope-doc §3 decision (ii) — boss pre-ack pin + warden scope-stage
 * pre-ack endorsement. The auth shape is HMAC + ACA-internal-only ingress
 * (defense-in-depth): HMAC is the cryptographic guard, internal-only ingress
 * is the network-isolation defense-in-depth, `assertInternalIngress` is the
 * boot-time enforcement that internal-only is actually configured.
 *
 * Canonicalization (6 pins locked at scope, per warden):
 *   1. Delimiter: single `\n` between fields; per-field trimmed.
 *   2. Method: uppercase ASCII.
 *   3. Path: includes the request path; query string DELIBERATELY EXCLUDED
 *      in this version (the control-plane endpoint takes its inputs in the
 *      body, never the query). If a future control-plane endpoint takes
 *      query params, this must change AND must be re-reviewed by warden.
 *   4. Timestamp: integer Unix SECONDS (ASCII decimal); ±5 min window.
 *   5. Body hash: lowercase hex sha256, fixed 64 chars. Empty body =
 *      sha256("") = e3b0c4... — NOT special-cased; hash the zero-byte body.
 *   6. Replay defense: timestamp-window + nonce-tracking (in-memory LRU of
 *      seen nonces within the window). Window alone leaves a small-N replay
 *      vector inside the window; the nonce closes that.
 *
 * The HMAC binds the BODY (per boss's pin): a swap-the-body-keep-the-
 * signature replay is structurally impossible because the body's sha256 is
 * inside the canonical string the signature covers.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/** Header names exchanged on the wire. */
export const HEADER_TIMESTAMP = 'x-relay-control-timestamp';
export const HEADER_NONCE = 'x-relay-control-nonce';
export const HEADER_SIGNATURE = 'x-relay-control-signature';

const TIMESTAMP_WINDOW_SECONDS = 5 * 60; // ±5 minutes per the canonicalization pin.

/** Built from a raw secret + a request; the same shape signs and verifies. */
export interface CanonicalRequestParts {
  method: string;
  path: string;
  /** Unix epoch seconds, ASCII decimal. */
  timestamp: string;
  /** Per-request nonce — typically `nanoid()`; binds the request to one timestamp. */
  nonce: string;
  /** lowercase hex sha256 of the raw body bytes. Empty body = sha256(zero-byte). */
  bodyHashHex: string;
}

/**
 * Hash a request body — lowercase hex sha256, never special-case empty.
 * `body` MUST be the exact bytes that will be transmitted (no whitespace
 * mutation, no re-serialization after hashing).
 */
export function hashBody(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Build the canonical string the HMAC signs. Single `\n` delimiter, method
 * upper-cased, path verbatim, timestamp/nonce/body-hash as-is. Exposed for
 * unit testing — production callers should not need to reach in.
 */
export function buildCanonicalString(parts: CanonicalRequestParts): string {
  return [
    parts.method.toUpperCase().trim(),
    parts.path.trim(),
    parts.timestamp.trim(),
    parts.nonce.trim(),
    parts.bodyHashHex.trim().toLowerCase(),
  ].join('\n');
}

/** HMAC-SHA256 a canonical string under `secret`; returns lowercase hex. */
export function signCanonical(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export interface SignRequestParams {
  secret: string;
  method: string;
  path: string;
  body: string | Buffer;
  /** Unix epoch seconds; defaults to `Math.floor(Date.now() / 1000)`. */
  timestamp?: number;
  /** Per-request nonce; the caller supplies (typically nanoid). */
  nonce: string;
}

export interface SignedHeaders {
  [HEADER_TIMESTAMP]: string;
  [HEADER_NONCE]: string;
  [HEADER_SIGNATURE]: string;
}

/** Build the three headers a signed gateway→relay request must carry. */
export function signRequest(params: SignRequestParams): SignedHeaders {
  const ts = (params.timestamp ?? Math.floor(Date.now() / 1000)).toString();
  const bodyHashHex = hashBody(params.body);
  const canonical = buildCanonicalString({
    method: params.method,
    path: params.path,
    timestamp: ts,
    nonce: params.nonce,
    bodyHashHex,
  });
  return {
    [HEADER_TIMESTAMP]: ts,
    [HEADER_NONCE]: params.nonce,
    [HEADER_SIGNATURE]: signCanonical(params.secret, canonical),
  };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'timestamp_skew' | 'replay' | 'bad_signature' };

/**
 * In-memory replay-defense store. Maps `nonce` → unix-seconds-seen-at, with
 * an LRU bound. A nonce seen within the timestamp window cannot be replayed
 * because it is structurally bound (via the canonical string) to the
 * specific timestamp it was signed at — replaying within the window with the
 * same nonce + timestamp short-circuits at the nonce-seen check; reusing the
 * nonce with a fresher timestamp would require a fresh signature (which the
 * attacker cannot produce without the secret).
 */
class NonceStore {
  private readonly seen = new Map<string, number>();
  private readonly capacity: number;

  constructor(capacity = 10_000) {
    this.capacity = capacity;
  }

  /** Returns true if this nonce was already used; otherwise records it. */
  recordOrFlag(nonce: string, nowSec: number, windowSec: number): boolean {
    this.evictOlderThan(nowSec - windowSec);
    if (this.seen.has(nonce)) return true;
    if (this.seen.size >= this.capacity) {
      // Cheap LRU-ish: drop oldest insertion.
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
    this.seen.set(nonce, nowSec);
    return false;
  }

  private evictOlderThan(cutoffSec: number): void {
    for (const [k, t] of this.seen) {
      if (t < cutoffSec) this.seen.delete(k);
    }
  }

  /** For tests. */
  size(): number {
    return this.seen.size;
  }
}

export const sharedNonceStore = new NonceStore();

export interface VerifyRequestParams {
  secret: string;
  method: string;
  path: string;
  body: string | Buffer;
  headers: {
    [HEADER_TIMESTAMP]?: string;
    [HEADER_NONCE]?: string;
    [HEADER_SIGNATURE]?: string;
  };
  /** Override for tests. Defaults to `Math.floor(Date.now() / 1000)`. */
  nowSeconds?: number;
  /** Override for tests. Defaults to the module-shared store. */
  nonceStore?: NonceStore;
}

/**
 * Verify a signed gateway→relay request. Returns a discriminated result so
 * the caller can map each failure mode to a specific HTTP response without
 * leaking which check failed in the error body.
 *
 * Verification order is deliberately:
 *   1. headers present (malformed)
 *   2. timestamp within window (timestamp_skew)
 *   3. signature valid (bad_signature, constant-time compare)
 *   4. nonce not already seen (replay)
 *
 * Why this order: the cheapest checks first, the most expensive (signature
 * verify + nonce record) gated on cheaper checks passing.
 */
export function verifyRequest(params: VerifyRequestParams): VerifyResult {
  const ts = params.headers[HEADER_TIMESTAMP];
  const nonce = params.headers[HEADER_NONCE];
  const provided = params.headers[HEADER_SIGNATURE];
  if (!ts || !nonce || !provided) return { ok: false, reason: 'malformed' };

  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'malformed' };

  const nowSec = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, reason: 'timestamp_skew' };
  }

  const bodyHashHex = hashBody(params.body);
  const canonical = buildCanonicalString({
    method: params.method,
    path: params.path,
    timestamp: ts,
    nonce,
    bodyHashHex,
  });
  const expected = signCanonical(params.secret, canonical);

  // Constant-time signature compare — short-circuit on length mismatch first
  // because timingSafeEqual throws on unequal-length buffers.
  if (provided.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Nonce check LAST — the signature is verified before we touch state. A
  // bad-signature replay never affects the nonce store.
  const store = params.nonceStore ?? sharedNonceStore;
  if (store.recordOrFlag(nonce, nowSec, TIMESTAMP_WINDOW_SECONDS)) {
    return { ok: false, reason: 'replay' };
  }

  return { ok: true };
}

/** Exported for tests. */
export { NonceStore, TIMESTAMP_WINDOW_SECONDS };
