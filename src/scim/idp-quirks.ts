/**
 * Per-IdP quirk normalization. Most lives in PATCH ops.
 *
 *   Entra:      sends "Add"/"Replace"/"Remove" capitalised; uses
 *               `members[value eq "<id>"]` paths on group PATCH.
 *   Okta:       spec-compliant lowercase ops; well-behaved.
 *   JumpCloud:  mostly spec; occasional missing "schemas" array on PATCH.
 *   Google:     limited; uses PUT-style replace for most updates.
 *
 * The only behavior that varies materially is PATCH op casing and
 * tolerance for missing `schemas`. Everything else is handled by the
 * generic Zod schemas in types.ts (`.passthrough()`).
 */

import type { IdpType, ScimPatchPayload } from './types.js';

/**
 * Normalize a PATCH payload to a shape `scim-patch` accepts:
 *   - lowercase `op` ("Add" -> "add")
 *   - inject default `schemas` if missing
 */
export function normalizePatch(
  payload: ScimPatchPayload,
  _idpType: IdpType,
): ScimPatchPayload {
  const Operations = payload.Operations.map((op: { op: string; path?: string; value?: unknown }) => ({
    ...op,
    op: typeof op.op === 'string' ? op.op.toLowerCase() : op.op,
  }));
  const schemas = payload.schemas ?? [
    'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  ];
  return { schemas, Operations };
}
