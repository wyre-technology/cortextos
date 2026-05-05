/**
 * SCIM 2.0 internal types and inbound payload schemas.
 *
 * Spec: RFC 7643 (Core Schema), RFC 7644 (Protocol).
 *
 * Scope: only what we actually accept from Entra/Okta/JumpCloud/Google.
 * We do NOT implement the full RFC. In particular:
 *   - No Bulk endpoint.
 *   - Filter parser supports `eq` on `userName` and `externalId` only
 *     (see filter.ts) — anything else returns 400.
 *   - No custom schema extensions beyond core User and Group.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Internal types — what handlers and serializers pass around.
// ---------------------------------------------------------------------------

export type ScimScope = 'tenant' | 'reseller';

export type IdpType = 'entra' | 'okta' | 'jumpcloud' | 'google' | 'generic';

export type ScimConnectionStatus = 'active' | 'revoked';

export interface ScimConnection {
  id: string;
  orgId: string;
  scope: ScimScope;
  idpType: IdpType;
  /** sha256 hash of the bearer token; plaintext never persists. */
  tokenHash: string;
  /** Default role assigned to org_members / reseller_members rows. */
  defaultRole: string;
  status: ScimConnectionStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
}

/** Per-request context derived from the bearer token. */
export interface ScimRequestContext {
  connection: ScimConnection;
  /** Path-bound org id; must match `connection.orgId` or 401. */
  pathOrgId: string;
  /** Path-bound scope; must match `connection.scope` or 401. */
  pathScope: ScimScope;
}

// ---------------------------------------------------------------------------
// Inbound payload schemas (Zod). These intentionally tolerate the per-IdP
// quirks documented in idp-quirks.ts — extras are ignored, capitalization
// of PATCH `op` is normalized in the PATCH applier.
// ---------------------------------------------------------------------------

const scimEmailSchema = z.object({
  value: z.string().email(),
  type: z.string().optional(),
  primary: z.boolean().optional(),
});

const scimNameSchema = z
  .object({
    formatted: z.string().optional(),
    familyName: z.string().optional(),
    givenName: z.string().optional(),
    middleName: z.string().optional(),
    honorificPrefix: z.string().optional(),
    honorificSuffix: z.string().optional(),
  })
  .partial();

export const scimUserCreateSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    userName: z.string().min(1),
    externalId: z.string().min(1).optional(),
    active: z.boolean().optional().default(true),
    name: scimNameSchema.optional(),
    displayName: z.string().optional(),
    emails: z.array(scimEmailSchema).optional(),
  })
  .passthrough();

export type ScimUserCreatePayload = z.infer<typeof scimUserCreateSchema>;

export const scimUserReplaceSchema = scimUserCreateSchema;
export type ScimUserReplacePayload = z.infer<typeof scimUserReplaceSchema>;

const scimMemberRefSchema = z
  .object({
    value: z.string().min(1),
    display: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export const scimGroupCreateSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    displayName: z.string().min(1),
    externalId: z.string().min(1).optional(),
    members: z.array(scimMemberRefSchema).optional(),
  })
  .passthrough();

export type ScimGroupCreatePayload = z.infer<typeof scimGroupCreateSchema>;

/**
 * SCIM PATCH op. Entra sends capitalized `op` values ("Add", "Replace",
 * "Remove"); the applier in patch.ts normalizes to lowercase before handing
 * to the `scim-patch` library.
 */
export const scimPatchOpSchema = z
  .object({
    op: z.string().min(1),
    path: z.string().optional(),
    value: z.unknown().optional(),
  })
  .passthrough();

export const scimPatchSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(scimPatchOpSchema).min(1),
});

export type ScimPatchPayload = z.infer<typeof scimPatchSchema>;

// ---------------------------------------------------------------------------
// SCIM error envelope (RFC 7644 §3.12).
// ---------------------------------------------------------------------------

export type ScimErrorType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

export interface ScimError {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'];
  status: string;
  scimType?: ScimErrorType;
  detail?: string;
  [key: string]: unknown;
}

export function scimError(
  status: number,
  detail: string,
  scimType?: ScimErrorType,
): ScimError {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}
