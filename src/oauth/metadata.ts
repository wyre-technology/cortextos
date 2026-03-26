/**
 * OAuth 2.1 Authorization Server Metadata (RFC 8414)
 *
 * Returns the well-known metadata document describing the capabilities
 * and endpoints of this authorization server.
 */

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export function getMetadata(baseUrl: string): OAuthServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
  };
}

/**
 * Protected Resource Metadata (RFC 9728)
 *
 * Per-vendor document that tells MCP clients which authorization server
 * to use and what resource URL to include in the authorize request.
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
}

export function getProtectedResourceMetadata(
  baseUrl: string,
  vendorSlug: string,
): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}/v1/${vendorSlug}/mcp`,
    authorization_servers: [`${baseUrl}/v1/${vendorSlug}`],
    scopes_supported: ['mcp'],
  };
}

/**
 * Per-vendor authorization server metadata.
 *
 * mcp-remote discovers the auth server from the protected resource metadata's
 * authorization_servers array, then fetches /.well-known/oauth-authorization-server
 * from that URL. By making each vendor its own "authorization server", we can
 * bake the vendor into the authorize endpoint URL — solving the problem of
 * mcp-remote not sending a resource parameter.
 */
export function getVendorAuthMetadata(
  baseUrl: string,
  vendorSlug: string,
): OAuthServerMetadata {
  return {
    issuer: `${baseUrl}/v1/${vendorSlug}`,
    authorization_endpoint: `${baseUrl}/oauth/authorize?vendor=${vendorSlug}`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
  };
}

/**
 * Protected Resource Metadata for the unified MCP endpoint (/v1/mcp).
 *
 * Points to the global authorization server (no vendor-specific issuer)
 * so clients complete a single OAuth flow for all vendors.
 */
export function getUnifiedProtectedResourceMetadata(
  baseUrl: string,
): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}/v1/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp'],
  };
}

/**
 * Authorization Server Metadata for the unified MCP endpoint.
 *
 * Same as global metadata — no vendor param in the authorize URL.
 * The JWT issued will have an empty vendor field, indicating unified access.
 */
export function getUnifiedAuthMetadata(baseUrl: string): OAuthServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
  };
}
