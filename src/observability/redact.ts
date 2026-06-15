/**
 * In-process redaction of tool-call arguments before they are written anywhere
 * (request_log audit columns today; the wide-event `prompt.redacted` field once
 * the observability emission build lands — both import THIS function, so there is
 * one redaction policy with two enforcement points).
 *
 * Design split (deliberate):
 *   - MECHANISM (`redactArgs`)  — dev-owned, stable. Walks any JSON value and
 *     replaces sensitive leaves/subtrees with `REDACTED`.
 *   - POLICY (the two pattern consts) — a STARTER set. murph owns the
 *     authoritative list; swapping it is a const change, not a code change.
 *
 * Bias: err toward OVER-redaction. A false negative is a leaked secret at rest
 * (the bad direction); a false positive is a `<REDACTED>` in an audit log that
 * nobody minds. When unsure, redact.
 */

export const REDACTED = '<REDACTED>';

/**
 * STARTER POLICY — pending murph ratification.
 *
 * Keys whose VALUE is redacted regardless of the value's shape. Catches secrets
 * that do not "look like" secrets (a password `hunter2`, a vendor-shaped API key
 * we did not enumerate). Unanchored on purpose: substring matches (e.g. a key
 * containing `token`) redact — over-redaction is the intended direction.
 */
export const SENSITIVE_KEY_PATTERN =
  /(?:password|secret|token|api[_-]?key|authorization|auth|credential|client[_-]?secret|private[_-]?key|passphrase|cookie|session)/i;

/**
 * STARTER POLICY — pending murph ratification.
 *
 * Value shapes redacted even when they appear under a non-sensitive key. Covers
 * credential/PII formats that leak through generic fields (a JWT in `note`, an
 * email in `description`).
 */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/, // JWT (header.payload.signature)
  /(?:sk-|pk_|ghp_|gho_|xox[baprs]-)[\w-]{12,}/, // common API-key prefixes
  /\b[A-Fa-f0-9]{32,}\b/, // long hex secret / hash
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64 token
];

/**
 * Recursively redact a tool-call argument value. Returns a redacted COPY; the
 * input is never mutated. `null`/`undefined` pass through (arg-less calls log
 * `null`). A sensitive KEY redacts its entire subtree without recursing.
 */
export function redactArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(redactArgs);
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactArgs(val);
    }
    return out;
  }

  if (typeof value === 'string') {
    return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value)) ? REDACTED : value;
  }

  // number | boolean | bigint — not string-pattern sensitive; key-name rule
  // above already redacts these when they sit under a sensitive key.
  return value;
}
