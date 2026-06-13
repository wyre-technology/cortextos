/**
 * SAML metadata parser — Multi-IdP foundation slice 7.
 *
 * Why this exists (June 29 launch directive 2026-06-13):
 *   The SAML wizard (slice 6 UI) accepts pasted SAML 2.0 IdP metadata
 *   XML from a customer admin and submits it to the slice-7 backend.
 *   That backend parses the XML via samlify's IdentityProvider helper,
 *   extracts the entity-id + SSO endpoints + signing cert, and emits the
 *   `options` JSON shape Auth0 expects for a `samlp`-strategy connection
 *   (Auth0ManagementClient.createConnection, slice 7 foundation).
 *
 * Scope:
 *   * IdP-initiated SAML 2.0 ONLY. Auth0 IS the SP; the customer's IdP
 *     (Okta, ADFS, JumpCloud, Azure AD via SAML) is the upstream. SP-
 *     initiated metadata is rejected.
 *   * Parses metadata XML strings (the wizard textarea body) — no
 *     network metadata-URL fetching. Customer admins paste the XML
 *     directly. Eliminates SSRF + URL-allowlist surface from the launch
 *     scope.
 *
 * Validation contract:
 *   parseSamlIdpMetadata throws SamlMetadataParseError on any of:
 *     - Empty input
 *     - XML structurally invalid (samlify's metadata loader throws)
 *     - Required fields missing: entity id, at least one SSO endpoint
 *       (HTTP-POST or HTTP-Redirect binding), signing cert
 *   On success returns the normalized Auth0 connection-options shape +
 *   the parsed entity id (the wizard uses it to derive the connection
 *   name + to display in confirm-pages).
 *
 * Mocked tests inject hand-crafted XML fixtures. Real-network round-
 * trip against actual Okta / Azure AD metadata fires at integration-
 * test layer once M2M creds + a sandbox IdP are wired up.
 */

import { IdentityProvider } from 'samlify';

const SAML_HTTP_POST_BINDING =
  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const SAML_HTTP_REDIRECT_BINDING =
  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/**
 * Thrown when parseSamlIdpMetadata cannot produce a valid Auth0
 * connection-options shape from the input. The `code` discriminator
 * lets the wizard render named actionable error states (vs a single
 * generic "parse failed" toast).
 */
export class SamlMetadataParseError extends Error {
  public readonly code: SamlMetadataParseErrorCode;

  constructor(code: SamlMetadataParseErrorCode, message: string) {
    super(message);
    this.name = 'SamlMetadataParseError';
    this.code = code;
  }
}

export type SamlMetadataParseErrorCode =
  | 'EMPTY_INPUT'
  | 'INVALID_XML'
  | 'MISSING_ENTITY_ID'
  | 'MISSING_SSO_ENDPOINT'
  | 'MISSING_SIGNING_CERT';

/**
 * Normalized parser output — directly consumable as the `options` payload
 * for Auth0ManagementClient.createConnection({ strategy: 'samlp' }).
 *
 * Field naming mirrors Auth0's samlp-options vocabulary so the wizard
 * substrate can do `{ ...options }` without per-field renaming. The
 * `entityId` field is hoisted to top-level for the wizard's confirm
 * page; it's also persisted alongside in the Conduit org_idp_connections
 * row for the audit trail.
 */
export interface ParsedSamlIdpMetadata {
  /** Entity id from the metadata's EntityDescriptor — also the IdP's `entityID` in Auth0 options. */
  entityId: string;
  /**
   * Auth0 connection-options shape for strategy='samlp'. Subset of fields
   * relevant to IdP-initiated SAML 2.0; the wizard can extend this with
   * org-specific settings (e.g. user_id_attribute, sign_in_endpoint
   * overrides) before passing to createConnection.
   */
  options: {
    signInEndpoint: string;
    signOutEndpoint?: string;
    signingCert: string;
    entityId: string;
    /**
     * Auth0 accepts `RSA-SHA256` / `RSA-SHA1`. Default to RSA-SHA256 per
     * the modern-baseline recommendation; metadata-declared
     * SignatureAlgorithm can override post-launch.
     */
    signatureAlgorithm: 'RSA-SHA256';
    digestAlgorithm: 'SHA256';
  };
}

/**
 * Parse a SAML 2.0 IdP metadata XML string into the Auth0 samlp-strategy
 * options shape. Throws SamlMetadataParseError on any structural or
 * field-missing failure.
 *
 * Sibling-shape to src/auth/auth0-management.ts at the validation layer:
 * upstream-untrusted-input is normalized + validated at a single seam
 * before flowing into the Auth0 API call. Same cheap-detector pattern
 * pearl banked across consent-crypto + slug-resolution + dispatch +
 * concurrency + claim-boundary substrates today (N=6 promoted).
 */
export function parseSamlIdpMetadata(xml: string): ParsedSamlIdpMetadata {
  if (!xml || !xml.trim()) {
    throw new SamlMetadataParseError('EMPTY_INPUT', 'SAML metadata XML is empty');
  }

  let idp: ReturnType<typeof IdentityProvider>;
  try {
    idp = IdentityProvider({ metadata: xml });
  } catch (err) {
    throw new SamlMetadataParseError(
      'INVALID_XML',
      `SAML metadata could not be parsed as XML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entityId = idp.entityMeta.getEntityID();
  if (!entityId || typeof entityId !== 'string') {
    throw new SamlMetadataParseError(
      'MISSING_ENTITY_ID',
      'SAML metadata is missing the IdP entity id (EntityDescriptor[@entityID])',
    );
  }

  // Prefer HTTP-POST binding (Auth0's preferred SAML transport); fall
  // back to HTTP-Redirect. samlify's getSingleSignOnService accepts the
  // short binding key ('post' / 'redirect') and resolves it to the full
  // URN internally; passing the URN itself returns the full service map.
  const ssoPost = idp.entityMeta.getSingleSignOnService('post');
  const ssoRedirect = idp.entityMeta.getSingleSignOnService('redirect');
  const signInEndpoint =
    (typeof ssoPost === 'string' && ssoPost) ||
    (typeof ssoRedirect === 'string' && ssoRedirect) ||
    null;

  if (!signInEndpoint) {
    throw new SamlMetadataParseError(
      'MISSING_SSO_ENDPOINT',
      `SAML metadata is missing a SingleSignOnService endpoint with binding ${SAML_HTTP_POST_BINDING} or ${SAML_HTTP_REDIRECT_BINDING}`,
    );
  }

  // samlify exposes signing certs via the X509Certificate inside
  // KeyDescriptor[use="signing"] elements. The library normalizes them to
  // strings; we pick the first one (multi-cert rollover is rare for
  // launch IdPs + post-launch work).
  const signingCerts = extractSigningCerts(idp);
  if (signingCerts.length === 0) {
    throw new SamlMetadataParseError(
      'MISSING_SIGNING_CERT',
      'SAML metadata is missing a signing X509Certificate inside an IDPSSODescriptor/KeyDescriptor[@use="signing"]',
    );
  }
  const signingCert = signingCerts[0];

  // SingleLogoutService is optional per the SAML 2.0 spec — Auth0 falls
  // back to its own logout page when absent. Only emit when present.
  const sloPost = idp.entityMeta.getSingleSignOnService('singleLogoutService');
  const signOutEndpoint = typeof sloPost === 'string' ? sloPost : undefined;

  return {
    entityId,
    options: {
      signInEndpoint,
      ...(signOutEndpoint && { signOutEndpoint }),
      signingCert,
      entityId,
      signatureAlgorithm: 'RSA-SHA256',
      digestAlgorithm: 'SHA256',
    },
  };
}

/**
 * samlify's public API doesn't expose a typed certs-getter on the IdP
 * metadata facade — we reach through to the underlying meta object's
 * extracted signing key descriptor. Defensive: returns an empty array
 * when the shape varies across samlify versions rather than throwing,
 * so the caller surfaces the named MISSING_SIGNING_CERT error.
 */
function extractSigningCerts(idp: ReturnType<typeof IdentityProvider>): string[] {
  const meta = idp.entityMeta as unknown as {
    meta?: {
      certificate?: { signing?: string | string[] };
    };
  };
  const signing = meta.meta?.certificate?.signing;
  if (!signing) return [];
  if (Array.isArray(signing)) return signing.filter((c) => typeof c === 'string' && c.length > 0);
  if (typeof signing === 'string' && signing.length > 0) return [signing];
  return [];
}
