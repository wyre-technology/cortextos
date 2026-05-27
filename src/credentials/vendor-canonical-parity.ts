/**
 * Cross-repo parity assert (forge's standing gate) — the pure, testable core.
 * Asserts two committed `canonical-map.json` artifacts (this repo's + the other
 * repo's, fetched read-only at a pinned ref by the CI job) agree on the vendor
 * DEFINITIONS:  equal-on-N + FIELD-SCOPED-allow  (== 31 batch-1, else RED).
 *
 * FIELD-SCOPED (forge discipline): a slug may differ ONLY on the canonical fields
 * named in its CROSS_REPO_DRIFT_ALLOWLIST entry; drift on any other field is RED
 * (no vendor-blanket exemption). The canonicalizer-identity (both repos serialize
 * the same way) is enforced separately by the byte-identical vendor-canonical.ts
 * + the per-repo golden-vector test; this asserts the DATA outcome over it.
 *
 * FAIL-CLOSED: drift on an unlisted field, a missing/extra slug, or a non-batch-1
 * allow-list entry all throw. An allow-listed field/slug that is now EQUAL is
 * reported as a SHRINK candidate (the list shrinks toward zero as drift is
 * reconciled) — surfaced so the list can't silently ossify.
 *
 * The thin CLI wrapper lives in scripts/assert-cross-repo-parity.ts.
 */
import { BATCH_1_SLUGS, CROSS_REPO_DRIFT_ALLOWLIST } from './vendor-batch1.js';

export interface ParityResult {
  matched: string[]; // slugs whose canonical form is byte-equal across repos
  allowed: string[]; // slugs that DIFFER only on their allow-listed field(s)
  drifted: string[]; // slugs that DIFFER on an UNLISTED field → RED (with fields)
  missing: string[]; // batch-1 slugs absent from one or both maps → RED
  shrinkCandidates: string[]; // allow-listed field/slug now EQUAL → could shrink
}

/** The canonical fields on which two serialized vendor forms differ. */
export function driftingFields(a: string, b: string): string[] {
  const ao = JSON.parse(a) as Record<string, unknown>;
  const bo = JSON.parse(b) as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  const drifted: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(ao[k]) !== JSON.stringify(bo[k])) drifted.push(k);
  }
  return drifted.sort();
}

/**
 * Pure assert over two canonical maps — FIELD-SCOPED. Throws on any fail-closed
 * condition with a precise message; returns the breakdown on success.
 */
export function assertCrossRepoParity(
  mapA: Record<string, string>,
  mapB: Record<string, string>,
  allowlist: Readonly<Record<string, readonly string[]>> = CROSS_REPO_DRIFT_ALLOWLIST,
): ParityResult {
  const matched: string[] = [];
  const allowed: string[] = [];
  const drifted: string[] = [];
  const missing: string[] = [];
  const shrinkCandidates: string[] = [];

  for (const slug of BATCH_1_SLUGS) {
    const a = mapA[slug];
    const b = mapB[slug];
    if (a === undefined || b === undefined) {
      missing.push(slug);
      continue;
    }
    const fields = driftingFields(a, b);
    const allowedFields = allowlist[slug] ?? [];
    if (fields.length === 0) {
      matched.push(slug);
      // An allow-listed slug that no longer drifts → the entry can be removed.
      if (allowedFields.length > 0) shrinkCandidates.push(slug);
      continue;
    }
    const unlisted = fields.filter((f) => !allowedFields.includes(f));
    if (unlisted.length > 0) {
      drifted.push(`${slug}{${unlisted.join(',')}}`);
    } else {
      allowed.push(slug);
      // Field-level shrink: an allowed field that did NOT actually drift this run.
      for (const f of allowedFields) {
        if (!fields.includes(f)) shrinkCandidates.push(`${slug}.${f}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Cross-repo parity FAILED — batch-1 slug(s) missing from one or both maps: ${missing.join(', ')}`);
  }
  if (drifted.length > 0) {
    throw new Error(
      `Cross-repo parity FAILED — drift on UNLISTED field(s): ${drifted.join(', ')}. ` +
        `Either reconcile the drift, or deliberately add the field to the allow-list with sign-off.`,
    );
  }
  // No-silent-grow: every allow-listed slug must be a real batch-1 vendor.
  for (const slug of Object.keys(allowlist)) {
    if (!BATCH_1_SLUGS.includes(slug)) {
      throw new Error(`Allow-list contains a non-batch-1 slug: ${slug}`);
    }
  }
  if (matched.length + allowed.length !== BATCH_1_SLUGS.length) {
    throw new Error(
      `Cross-repo parity FAILED — matched(${matched.length}) + allowed(${allowed.length}) != ${BATCH_1_SLUGS.length} batch-1.`,
    );
  }

  return { matched, allowed, drifted, missing, shrinkCandidates };
}
