# MCP Gateway

OAuth 2.1 gateway for hosted MCP servers at `mcp.wyre.ai`. Users connect Claude Desktop/Code once, enter their vendor API credentials through a web form, and the gateway handles authentication and credential injection — no config file editing needed.

## How It Works

```
Claude Desktop/Code
    |
    +-- (1) GET /v1/datto-rmm/mcp  (no token)
    |       -> 401 + WWW-Authenticate header
    |
    +-- (2) OAuth 2.1 + PKCE dance
    |       -> Browser opens credential entry form
    |       -> User enters vendor API credentials
    |       -> Gateway stores encrypted, issues tokens
    |
    +-- (3) GET /v1/datto-rmm/mcp  (Bearer token)
            -> Validates JWT, decrypts credentials
            -> Proxies to MCP server container
               with vendor-specific HTTP headers
            -> Returns MCP tool results
```

## Supported Vendors

### Remote Monitoring & Management

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Datto RMM | `datto-rmm` | API Key, API Secret, Platform |
| Syncro | `syncro` | API Key, Subdomain (optional) |
| Atera | `atera` | API Key |
| SuperOps | `superops` | API Token, Subdomain |
| ConnectWise Automate | `connectwise-automate` | Server URL, Client ID, Username, Password |
| NinjaOne | `ninjaone` | Client ID, Client Secret, Region |

### Professional Services Automation

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Autotask PSA | `autotask` | Username, Secret, Integration Code |
| HaloPSA | `halopsa` | Client ID, Client Secret, Tenant |
| ConnectWise PSA | `connectwise-psa` | Company ID, Public Key, Private Key, Client ID |

### IT Documentation

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| IT Glue | `itglue` | API Key |
| Liongard | `liongard` | Instance Name, Access Key ID, Access Key Secret |
| Hudu | `hudu` | Base URL, API Key |

### Network Monitoring & Security

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Domotz | `domotz` | API Key |
| runZero | `runzero` | API Token |
| BetterStack | `betterstack` | API Token |

### Security & Incident Management

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| SentinelOne | `sentinelone` | API Token, Console URL |
| RocketCyber | `rocketcyber` | API Key, Region |
| Huntress | `huntress` | API Key, API Secret |
| Blumira | `blumira` | API Key |
| PagerDuty | `pagerduty` | User API Token |
| Rootly | `rootly` | API Token |

### Email Security & Awareness

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Checkpoint Avanan | `avanan` | Client ID, Secret Key |
| Proofpoint | `proofpoint` | Service Principal, API Key, Cluster URL (optional) |
| KnowBe4 | `knowbe4` | API Key, Region |

### Sales & Distribution

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Pax8 | `pax8` | MCP Token |
| SalesBuildr | `salesbuildr` | API Key |
| PandaDoc | `pandadoc` | API Key |
| Sherweb | `sherweb` | Client ID, Client Secret, Subscription Key |

### Accounting & Finance

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Xero | `xero` | OAuth 2.0 (browser consent) |
| QuickBooks Online | `qbo` | OAuth 2.0 (browser consent) |

### CRM

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| HubSpot | `hubspot` | OAuth 2.0 (browser consent) |

### Productivity

| Vendor | Slug | Credential Fields |
|--------|------|-------------------|
| Microsoft 365 | `m365` | OAuth 2.0 (browser consent, multi-tenant Entra ID) |

## Quick Start

```bash
# Clone and install
git clone https://github.com/wyre-technology/mcp-gateway.git
cd mcp-gateway
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env — set MASTER_KEY and JWT_SECRET (see .env.example for generation commands)

# Development
npm run dev

# Build and run
npm run build
npm start
```

### Docker Compose (with PostgreSQL + MCP servers)

```bash
# Start gateway + PostgreSQL + Datto RMM, IT Glue, and Autotask MCP servers
docker compose up --build
```

The gateway runs on `http://localhost:8080`. PostgreSQL runs on `localhost:5432`. MCP server containers run with `AUTH_MODE=gateway` on an internal network.

## Claude Desktop Configuration

Add the gateway URL to your Claude Desktop config:

```json
{
  "mcpServers": {
    "datto-rmm": {
      "url": "https://mcp.wyre.ai/v1/datto-rmm/mcp"
    },
    "itglue": {
      "url": "https://mcp.wyre.ai/v1/itglue/mcp"
    }
  }
}
```

Claude Desktop handles the OAuth 2.1 + PKCE flow automatically. On first connect, a browser window opens for credential entry.

## API Endpoints

### Core

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check |
| `ALL` | `/v1/:vendor/mcp` | Bearer | MCP proxy with credential injection |

### OAuth 2.1

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | No | OAuth metadata (RFC 8414) |
| `POST` | `/oauth/register` | No | Dynamic Client Registration (RFC 7591) |
| `GET` | `/oauth/authorize` | No | Authorization endpoint (PKCE required) |
| `POST` | `/oauth/token` | No | Token exchange / refresh |
| `POST` | `/oauth/revoke` | No | Token revocation |

### Auth (Auth0 OIDC)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/auth/callback` | No | Auth0 OIDC callback |
| `GET` | `/auth/logout` | Session | Logout + Auth0 session clear |

### Web UI

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/connect/:vendor` | Session | Credential entry form |
| `POST` | `/connect/:vendor` | Session | Store encrypted credentials |
| `POST` | `/disconnect/:vendor` | Session | Remove stored credentials |
| `GET` | `/settings` | Session | Personal connections dashboard |
| `GET` | `/settings/team` | Session | Team overview |
| `GET` | `/settings/team/members` | Session | Team member management |
| `GET` | `/settings/team/invitations` | Session | Invitation management |
| `GET` | `/settings/team/connections` | Session | Org-level credentials |
| `GET` | `/settings/team/tool-access` | Session | Per-role tool allowlists |
| `GET` | `/settings/team/server-access` | Session | Per-role server access |
| `GET` | `/settings/team/service-clients` | Session | API service clients |
| `GET` | `/settings/team/audit` | Session | Audit log viewer |

### Organization API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/orgs` | Session | Create organization |
| `GET` | `/api/orgs` | Session | List user's organizations |
| `GET` | `/api/orgs/:orgId` | Session | Get organization details |
| `PATCH` | `/api/orgs/:orgId` | Session | Update organization |
| `DELETE` | `/api/orgs/:orgId` | Session | Delete organization |
| `POST` | `/api/orgs/:orgId/invite-code` | Session | Apply invite code |
| `GET` | `/api/orgs/:orgId/members` | Session | List members |
| `DELETE` | `/api/orgs/:orgId/members/:userId` | Session | Remove member |
| `POST` | `/api/orgs/:orgId/invitations` | Session | Create invitation |
| `GET` | `/api/orgs/:orgId/invitations` | Session | List invitations |
| `DELETE` | `/api/orgs/:orgId/invitations/:id` | Session | Revoke invitation |
| `GET` | `/api/invitations/:token` | Session | View invitation |
| `POST` | `/api/invitations/:token/accept` | Session | Accept invitation |
| `POST` | `/api/orgs/:orgId/credentials/:vendor` | Session | Store org credential |
| `GET` | `/api/orgs/:orgId/credentials` | Session | List org credentials |
| `DELETE` | `/api/orgs/:orgId/credentials/:vendor` | Session | Delete org credential |
| `GET` | `/api/orgs/:orgId/tool-access/:vendor` | Session | Get tool allowlist |
| `PUT` | `/api/orgs/:orgId/tool-access/:vendor` | Session | Set tool allowlist |
| `DELETE` | `/api/orgs/:orgId/tool-access/:vendor/:role` | Session | Remove role allowlist |
| `GET` | `/api/orgs/:orgId/tools/:vendor` | Session | List available tools |

### Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/billing/checkout` | Session | Create Stripe Checkout session |
| `POST` | `/api/billing/portal` | Session | Create Stripe Customer Portal session |
| `POST` | `/api/webhooks/stripe` | Stripe sig | Stripe webhook handler |

### Audit

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/audit` | Session | Proxy request audit log (JSON/CSV) |
| `GET` | `/api/audit/admin` | Session | Admin action audit log (JSON/CSV) |

### Waitlist

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/waitlist` | No | Waitlist signup page |
| `GET` | `/waitlist/count` | No | Current waitlist count |

## Architecture

```
src/
  index.ts                        # Fastify entry point
  config.ts                       # Environment configuration
  auth/
    auth0.ts                      # Auth0 OIDC login, callback, logout
  audit/
    audit-service.ts              # Proxy request audit logging
    admin-audit-service.ts        # Admin action audit logging
    routes.ts                     # /api/audit endpoints + CSV export
  billing/
    checkout.ts                   # Stripe Checkout + Customer Portal
    gate.ts                       # Plan-based feature gating
    stripe-webhook.ts             # Stripe webhook handler
  credentials/
    vendor-config.ts              # Vendor field definitions + header mappings
    credential-service.ts         # Encrypted credential CRUD (AES-256-GCM)
  oauth/
    authorization-server.ts       # OAuth 2.1 + PKCE endpoints
    token-store.ts                # PostgreSQL-backed token/session storage
    metadata.ts                   # .well-known/oauth-authorization-server
    vendor-oauth.ts               # Vendor-side OAuth flows (Xero, QBO, HubSpot)
  org/
    org-service.ts                # Organization CRUD + membership
    member-service.ts             # Member management
    invitation-service.ts         # Invitation links + acceptance
    tool-allowlist-service.ts     # Per-role tool access control
    routes/                       # REST API routes for org management
  proxy/
    router.ts                     # /v1/:vendor/mcp reverse proxy
    credential-injector.ts        # JWT validation + header injection
    tool-cache.ts                 # MCP tool list caching
  waitlist/
    routes.ts                     # Waitlist signup + count
  web/
    routes.ts                     # Settings pages + connect/disconnect flows
    layout.ts                     # Sidebar layout shell (dark/light theme)
    styles.ts                     # CSS variables + shared styles
    helpers.ts                    # HTML escaping + success page
    templates/
      connect.ts                  # Standalone credential entry form
      personal-connections.ts     # Personal vendor connections page
      team-overview.ts            # Team settings overview
      team-members.ts             # Team member management
      team-invitations.ts         # Invitation management
      team-connections.ts         # Org-level credential management
      team-tool-access.ts         # Per-role tool allowlists
      team-server-access.ts       # Per-role server access control
      team-service-clients.ts     # API service client management
      team-audit.ts               # Proxy + admin audit log viewer
```

### Security

- **User authentication**: Auth0 OIDC with session cookies
- **Credential encryption**: AES-256-GCM with per-user PBKDF2 key derivation (100k iterations, SHA-512)
- **OAuth 2.1**: PKCE with S256 code challenge (mandatory per MCP spec)
- **JWT access tokens**: HS256 signed, configurable TTL
- **Refresh token rotation**: Old token revoked on every use
- **Role-based access**: Org owner/admin/member roles with per-role tool allowlists
- **Audit logging**: Proxy request + admin action audit trails with CSV export
- **PostgreSQL**: Production-ready database with connection pooling via postgres.js

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `BASE_URL` | `http://localhost:8080` | Public-facing URL (used in OAuth metadata) |
| `MASTER_KEY` | Auto-generated | 32-byte hex encryption master key |
| `JWT_SECRET` | Auto-generated | 32-byte hex JWT signing key |
| `DATABASE_URL` | `postgres://gateway:gateway@localhost:5432/gateway` | PostgreSQL connection URL |
| `ACCESS_TOKEN_TTL` | `3600` | Access token lifetime (seconds) |
| `REFRESH_TOKEN_TTL` | `2592000` | Refresh token lifetime (seconds) |
| `AUTH_CODE_TTL` | `300` | Authorization code lifetime (seconds) |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

### Auth0 OIDC

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH0_DOMAIN` | — | Auth0 tenant domain (e.g. `wyre.us.auth0.com`) |
| `AUTH0_CLIENT_ID` | — | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | — | Auth0 application client secret |
| `AUTH0_CALLBACK_URL` | — | Auth0 callback URL (e.g. `https://mcp.wyre.ai/auth/callback`) |

### Stripe Billing

| Variable | Default | Description |
|----------|---------|-------------|
| `STRIPE_SECRET_KEY` | — | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | — | Stripe Price ID for Pro plan |
| `ALPHA_INVITE_CODES` | — | Comma-separated invite codes that grant Pro plan |

### Vendor OAuth

| Variable | Default | Description |
|----------|---------|-------------|
| `XERO_CLIENT_ID` | — | Xero OAuth app client ID |
| `XERO_CLIENT_SECRET` | — | Xero OAuth app client secret |
| `QBO_CLIENT_ID` | — | QuickBooks Online OAuth app client ID |
| `QBO_CLIENT_SECRET` | — | QuickBooks Online OAuth app client secret |
| `HUBSPOT_CLIENT_ID` | — | HubSpot OAuth app client ID |
| `HUBSPOT_CLIENT_SECRET` | — | HubSpot OAuth app client secret |
| `MICROSOFT_CLIENT_ID` | — | Microsoft Entra app client ID (multi-tenant, for M365 OAuth) |
| `MICROSOFT_CLIENT_SECRET` | — | Microsoft Entra app client secret |

> **Production**: `MASTER_KEY`, `JWT_SECRET`, `DATABASE_URL`, and `AUTH0_*` variables must be set explicitly. The auto-generated key defaults are random per process restart and will invalidate all existing tokens/credentials.

## License

Apache-2.0
