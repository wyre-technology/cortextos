# Vendor Integration Guide

This document explains how to add a new vendor MCP server to the gateway.

## Overview

Each vendor integration requires:

1. A running MCP server container (your own or third-party)
2. A vendor configuration entry in `vendor-config.ts`
3. A Docker Compose service definition for local development
4. Container registry image for production deployment

## Step 1: Create the MCP Server Container

### Option A: First-Party Container (Recommended)

Build a Node.js or Python MCP server that:

- Listens on port 8080
- Exposes the MCP protocol at `/mcp` (Streamable HTTP) or `/sse` (SSE transport)
- Supports `AUTH_MODE=gateway` -- reads credentials from HTTP headers instead of environment variables
- Implements MCP `initialize`, `tools/list`, and `tools/call` methods

The container should trust the gateway to authenticate requests. When `AUTH_MODE=gateway`, extract vendor credentials from request headers (e.g., `X-Vendor-API-Key`).

### Option B: Third-Party Wrapper

For third-party MCP servers that read credentials from environment variables (like SentinelOne Purple MCP), create a gateway wrapper:

1. Create `containers/<vendor>-mcp/` directory
2. Write a `gateway_wrapper.py` (or equivalent) that:
   - Runs as ASGI middleware in front of the stock MCP server
   - Extracts credentials from gateway-injected headers
   - Sets the corresponding environment variables
   - Clears any settings cache (e.g., `@lru_cache`)
   - Serializes requests with `asyncio.Lock` (env vars are process-global)
3. Write a `Dockerfile` extending the stock image

Example wrapper (from `containers/sentinelone-mcp/gateway_wrapper.py`):

```python
HEADER_MAP = {
    "x-s1-api-token": "PURPLEMCP_CONSOLE_TOKEN",
    "x-s1-console-url": "PURPLEMCP_CONSOLE_BASE_URL",
}

_request_lock = asyncio.Lock()

class GatewayAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        # Extract headers, set env vars, clear cache, serialize
```

### Option C: Hosted MCP Servers

Some vendors host their own MCP servers (e.g., Pax8 at `mcp.pax8.com`, runZero at `console.runzero.com/mcp`, PandaDoc at `developers.pandadoc.com`). For these, set `containerUrl` directly to the vendor's URL. No local container is needed.

## Step 2: Add Vendor Configuration

Edit `src/credentials/vendor-config.ts` and add an entry to the `VENDORS` object.

### Configuration Interface

```typescript
interface VendorConfig {
  name: string;            // Display name
  slug: string;            // URL-safe identifier (kebab-case)
  category: VendorCategory; // One of: rmm, psa, documentation, security,
                           //         network, sales, accounting, crm,
                           //         productivity, email-security, marketplace
  containerUrl: string;    // Container base URL (e.g., http://vendor-mcp:8080)
  fields: VendorField[];   // Credential input fields
  headerMapping: Record<string, string>;  // field key -> HTTP header name
  buildHeaders?: (creds: Record<string, string>) => Record<string, string>;
  docsUrl: string;         // Link to vendor API docs
  validate?: (creds: Record<string, string>) => Promise<ValidationResult>;
  oauthConfig?: OAuthVendorConfig;  // For OAuth vendors
  mcpPath?: string;        // Default: '/mcp'. Set to '/sse' for SSE transport.
}
```

### Example: API Key Vendor

```typescript
'example-vendor': {
  name: 'Example Vendor',
  slug: 'example-vendor',
  category: 'rmm',
  containerUrl: 'http://example-vendor-mcp:8080',
  fields: [
    { key: 'apiKey', label: 'API Key', required: true, secret: true },
    {
      key: 'region',
      label: 'Region',
      required: false,
      options: ['us', 'eu'],
    },
  ],
  headerMapping: {
    apiKey: 'X-Example-API-Key',
    region: 'X-Example-Region',
  },
  docsUrl: 'https://docs.example.com/api',
  async validate(creds) {
    const res = await fetch('https://api.example.com/v1/me', {
      headers: { 'Authorization': `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 401) {
        return { valid: false, error: 'Invalid API key.' };
      }
      return { valid: false, error: `Vendor returned HTTP ${res.status}.` };
    }
    return { valid: true };
  },
},
```

### Example: OAuth Vendor

```typescript
'example-oauth': {
  name: 'Example OAuth',
  slug: 'example-oauth',
  category: 'crm',
  containerUrl: 'http://example-oauth-mcp:8080',
  fields: [],  // No manual fields — credentials come from OAuth
  headerMapping: {
    accessToken: 'Authorization',
    tenantId: 'X-Example-Tenant-Id',
  },
  buildHeaders(creds) {
    return {
      Authorization: `Bearer ${creds.accessToken}`,
      'X-Example-Tenant-Id': creds.tenantId ?? '',
    };
  },
  docsUrl: 'https://docs.example.com/oauth',
  oauthConfig: {
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scopes: ['read', 'write', 'offline_access'],
    clientIdEnv: 'EXAMPLE_CLIENT_ID',
    clientSecretEnv: 'EXAMPLE_CLIENT_SECRET',
    extraFields: ['tenantId'],
  },
},
```

### Field Configuration

```typescript
interface VendorField {
  key: string;        // Internal key for storage and header mapping
  label: string;      // Display label in the web UI
  required: boolean;  // Whether the field is required
  secret?: boolean;   // If true, displayed as a password input
  options?: string[]; // If set, renders as a dropdown select
  placeholder?: string;
}
```

### Custom Header Building

Use `buildHeaders` when simple 1:1 header mapping is insufficient:

- **Base64-encoded credentials** (e.g., Liongard, Huntress): Combine fields and encode
- **Bearer tokens** (e.g., HubSpot, Blumira): Prefix with `Bearer`
- **Complex auth schemes**: Any transformation from stored fields to HTTP headers

### Validation Functions

The `validate` function is called when a user submits credentials. It should:

- Make a lightweight API call to verify credentials work
- Use `AbortSignal.timeout(10_000)` to prevent hangs
- Return `{ valid: true }` on success
- Return `{ valid: false, error: "Human-readable message" }` on failure
- Distinguish between 401/403 (bad credentials) and other errors

## Step 3: Add Docker Compose Service

Add the vendor to `docker-compose.yml`:

```yaml
example-vendor-mcp:
  image: ghcr.io/wyre-technology/example-vendor-mcp:latest
  environment:
    - AUTH_MODE=gateway
    - PORT=8080
  expose:
    - "8080"
```

For containers built from local source:

```yaml
example-vendor-mcp:
  build: ./containers/example-vendor-mcp
  environment:
    - AUTH_MODE=gateway
  expose:
    - "8080"
```

Also add the vendor URL environment variable to the gateway service:

```yaml
- VENDOR_URL_EXAMPLE_VENDOR=http://example-vendor-mcp:8080
```

## Step 4: Update Tests

Update `src/credentials/vendor-config.test.ts` -- the test hardcodes the vendor count. Increment it to match the new total.

## Step 5: Test Locally

1. Start the containers:
   ```bash
   docker compose up -d example-vendor-mcp gateway postgres
   ```

2. Connect credentials via the web UI at `http://localhost:8080/connect/example-vendor`

3. Test MCP proxy:
   ```bash
   curl -X POST http://localhost:8080/v1/example-vendor/cli \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{"tool": "example_list_items", "args": {}}'
   ```

4. Test via unified endpoint:
   ```bash
   curl -X POST http://localhost:8080/v1/mcp \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/call",
       "params": {
         "name": "example-vendor__list_items",
         "arguments": {}
       }
     }'
   ```

## Step 6: Deploy

1. Push the container image to GitHub Container Registry:
   ```bash
   docker build -t ghcr.io/wyre-technology/example-vendor-mcp:latest .
   docker push ghcr.io/wyre-technology/example-vendor-mcp:latest
   ```

2. Add the container to the Azure Container Apps deployment (see deployment.md)

3. Update the gateway configuration to point to the new container URL in production

## Vendor Categories

| Slug | Label |
|---|---|
| `rmm` | Remote Monitoring & Management |
| `psa` | Professional Services Automation |
| `documentation` | IT Documentation |
| `security` | Security |
| `network` | Network Monitoring & Security |
| `sales` | Sales & Distribution |
| `accounting` | Accounting & Finance |
| `crm` | CRM |
| `productivity` | Productivity |
| `email-security` | Email Security & Awareness |
| `marketplace` | Marketplace |

## Supported Vendors (Current)

| Vendor | Slug | Category | Auth Type |
|---|---|---|---|
| Datto RMM | `datto-rmm` | RMM | API Key + Secret |
| Syncro | `syncro` | RMM | API Key |
| Atera | `atera` | RMM | API Key |
| SuperOps | `superops` | RMM | API Token |
| ConnectWise Automate | `connectwise-automate` | RMM | Client Credentials |
| NinjaOne | `ninjaone` | RMM | Client Credentials |
| Autotask PSA | `autotask` | PSA | Username + Secret |
| HaloPSA | `halopsa` | PSA | Client Credentials |
| ConnectWise PSA | `connectwise-psa` | PSA | Public/Private Key |
| IT Glue | `itglue` | Documentation | API Key |
| Hudu | `hudu` | Documentation | API Key |
| Liongard | `liongard` | Documentation | Access Key |
| Domotz | `domotz` | Network | API Key |
| RocketCyber | `rocketcyber` | Security | API Key |
| SentinelOne | `sentinelone` | Security | API Token |
| Huntress | `huntress` | Security | API Key + Secret |
| Blumira | `blumira` | Security | JWT Token |
| runZero | `runzero` | Security | API Token |
| Avanan | `avanan` | Email Security | API Key |
| Proofpoint | `proofpoint` | Email Security | API Key |
| KnowBe4 | `knowbe4` | Email Security | API Key |
| SalesBuildr | `salesbuildr` | Sales | API Key |
| PandaDoc | `pandadoc` | Sales | API Key |
| Pax8 | `pax8` | Sales | MCP Token |
| Xero | `xero` | Accounting | OAuth 2.0 |
| QuickBooks Online | `qbo` | Accounting | OAuth 2.0 |
| HubSpot | `hubspot` | CRM | OAuth 2.0 |
| Microsoft 365 | `m365` | Productivity | OAuth 2.0 |
| Sherweb | `sherweb` | Marketplace | API Key |
