import { describe, it, expect } from 'vitest';
import {
  parseSamlIdpMetadata,
  SamlMetadataParseError,
} from './saml-metadata-parser.js';

/**
 * Multi-IdP slice 7 — parser unit tests against hand-crafted SAML metadata
 * fixtures. Locks the validation contract + the Auth0 connection-options
 * shape mapping. Real-network round-trip against actual Okta / Azure AD
 * metadata fires at integration-test layer once a sandbox IdP is wired.
 */

/** Minimum-viable SAML 2.0 IdP metadata XML. */
function validIdpMetadata(): string {
  // Self-signed test cert just to satisfy the metadata-shape requirement —
  // never used to verify real SAML assertions in tests.
  const cert =
    'MIIDXTCCAkWgAwIBAgIJAKfake1234567890MA0GCSqGSIb3DQEBCwUAMEUx' +
    'CzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJ' +
    'bnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwHhcNMjUwMTAxMDAwMDAwWhcNMjYw' +
    'MTAxMDAwMDAwWjBFMQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0';
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/sso">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>${cert}</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post" />
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso/redirect" />
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

function noSsoEndpointMetadata(): string {
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/no-sso">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>MIIDXTCCAkWtest</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

function noSigningCertMetadata(): string {
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/no-cert">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post" />
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

describe('parseSamlIdpMetadata — happy path', () => {
  it('extracts entityId + signInEndpoint + signingCert + algorithm defaults from valid metadata', () => {
    const result = parseSamlIdpMetadata(validIdpMetadata());
    expect(result.entityId).toBe('https://idp.example.com/sso');
    expect(result.options.signInEndpoint).toBe('https://idp.example.com/sso/post');
    expect(result.options.entityId).toBe('https://idp.example.com/sso');
    expect(result.options.signingCert).toBeTruthy();
    expect(result.options.signatureAlgorithm).toBe('RSA-SHA256');
    expect(result.options.digestAlgorithm).toBe('SHA256');
  });

  it('prefers HTTP-POST binding over HTTP-Redirect when both present (Auth0 transport preference)', () => {
    const result = parseSamlIdpMetadata(validIdpMetadata());
    expect(result.options.signInEndpoint).toContain('/sso/post');
    expect(result.options.signInEndpoint).not.toContain('/sso/redirect');
  });

  it('falls back to HTTP-Redirect when HTTP-POST binding is absent', () => {
    const redirectOnly = validIdpMetadata().replace(
      /<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]*\/>/,
      '',
    );
    const result = parseSamlIdpMetadata(redirectOnly);
    expect(result.options.signInEndpoint).toBe('https://idp.example.com/sso/redirect');
  });
});

describe('parseSamlIdpMetadata — validation errors', () => {
  it('throws EMPTY_INPUT for empty / whitespace input', () => {
    expect(() => parseSamlIdpMetadata('')).toThrow(SamlMetadataParseError);
    try {
      parseSamlIdpMetadata('');
    } catch (err) {
      expect((err as SamlMetadataParseError).code).toBe('EMPTY_INPUT');
    }
    try {
      parseSamlIdpMetadata('   \n\t  ');
    } catch (err) {
      expect((err as SamlMetadataParseError).code).toBe('EMPTY_INPUT');
    }
  });

  it('throws INVALID_XML for structurally-broken XML', () => {
    try {
      parseSamlIdpMetadata('<not-an-entity-descriptor-and-unclosed');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SamlMetadataParseError);
      expect((err as SamlMetadataParseError).code).toBe('INVALID_XML');
    }
  });

  it('throws MISSING_SSO_ENDPOINT when metadata has no HTTP-POST/Redirect SingleSignOnService', () => {
    try {
      parseSamlIdpMetadata(noSsoEndpointMetadata());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SamlMetadataParseError);
      expect((err as SamlMetadataParseError).code).toBe('MISSING_SSO_ENDPOINT');
    }
  });

  it('throws MISSING_SIGNING_CERT when metadata has no KeyDescriptor[use=signing]', () => {
    try {
      parseSamlIdpMetadata(noSigningCertMetadata());
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SamlMetadataParseError);
      expect((err as SamlMetadataParseError).code).toBe('MISSING_SIGNING_CERT');
    }
  });
});
