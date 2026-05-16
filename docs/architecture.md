# Architecture

> **MIGRATED — this file is no longer the source of truth.**
> The customer-facing version lives at [`docs/src/content/docs/reference/architecture.mdx`](src/content/docs/reference/architecture.mdx), published at `https://conduit.wyre.ai/docs/reference/architecture`. Do not extend this file — edit the Starlight version.

## System Overview

The MCP Gateway is a Fastify/TypeScript application that acts as an OAuth 2.1 reverse proxy between AI clients (Claude Desktop, Claude Code, custom agents) and vendor MCP servers used by Managed Service Providers. The specific vendors available depend on the customer deployment.

```
                          +-----------------------+
                          |   AI Client           |
                          | (Claude Desktop/Code) |
                          +----------+------------+
                                     |
                            OAuth 2.1 + PKCE
                                     |
                          +----------v------------+
                          |                       |
                          |    Fastify Gateway     |
                          |    (Node.js / TS)      |
                          |                       |
                          |  +------------------+ |
                          |  | OAuth 2.1 Server | |
                          |  +------------------+ |
                          |  | Auth0 OIDC       | |
                          |  +------------------+ |
                          |  | Credential Svc   | |
                          |  +------------------+ |
                          |  | Org / Team Svc   | |
                          |  +------------------+ |
                          |  | Billing Gate     | |
                          |  +------------------+ |
                          |  | Audit Service    | |
                          |  +------------------+ |
                          |  | Tool Cache       | |
                          |  +------------------+ |
                          |  | CLI Router       | |
                          |  +------------------+ |
                          |  | Unified Proxy    | |
                          |  +------------------+ |
                          |                       |
                          +--+-----+-----+----+---+
                             |     |     |    |
                   +---------+  +--+--+  |  +-+--------+
                   |            |     |  |  |          |
               +---v---+  +----v-+ +-v--++ | +--------v--------+
               |Postgres|  |Auth0 | |Stripe| | Vendor MCP       |
               |  (DB)  |  |      | |      | | Containers       |
               +--------+  +------+ +------+ |                  |
                                              | vendor-a-mcp    |
                                              | vendor-b-mcp    |
                                              | vendor-c-mcp    |
                                              | ... (per customer|
                                              |     deployment)  |
                                              +-----------------+
```

## Component Roles

### Fastify Gateway (Core Application)

The central Node.js process running Fastify v5. Handles all HTTP traffic, route dispatch, and plugin orchestration. Listens on port 8080 by default.

### OAuth 2.1 Authorization Server

Implements RFC 8414 metadata discovery, RFC 7591 dynamic client registration, authorization code flow with PKCE (S256), token exchange, refresh, and revocation. Issues HS256 JWTs with configurable TTLs. Every MCP client authenticates through this server to obtain a Bearer token.

### Auth0 OIDC (User Authentication)

Handles human user identity via OpenID Connect. Users sign in through Auth0, and the gateway maps their Auth0 `sub` claim to internal user IDs. All web UI routes and API endpoints that manage settings require an Auth0 session.

### Vendor MCP Containers

Each vendor runs as an isolated container exposing the MCP protocol over Streamable HTTP (port 8080, path `/mcp`). Containers run in `AUTH_MODE=gateway` -- they trust the gateway to inject authenticated credentials via HTTP headers. The gateway never exposes vendor containers directly to clients.

### Credential Service

Manages encrypted storage of vendor API keys, tokens, and secrets. Uses AES-256-GCM encryption with per-credential salts derived from a master key via PBKDF2. Supports four credential scopes:

- **Personal** -- tied to an individual user
- **Organization** -- shared across all org members
- **Team** -- scoped to a sub-team within an org
- **Service Client** -- for M2M / AI agent access

### Organization & Team Service

Multi-tenant org management with role-based access. Roles: `owner` > `admin` > `member`. Handles org CRUD, membership, invitations, teams, server access grants (per-member, per-vendor), and tool allowlists (per-vendor, per-role).

### Billing Gate

Feature gating based on plan (free vs. pro). Controls connection limits, rate limits, team features, and audit log access. Integrates with Stripe for subscription management.

### Audit Service

Dual audit system:
- **Request audit** -- logs every MCP tool call to `request_log` (user, vendor, tool name, status, response time)
- **Admin audit** -- logs administrative actions (member invited, role changed, credential created, etc.)

### Tool Cache

Caches `tools/list` responses from vendor containers to avoid repeated MCP handshakes. Tools are fetched once per vendor and refreshed periodically.

### Unified Proxy (`/v1/mcp`)

Single MCP endpoint that aggregates all connected vendors behind one JWT. Tool names are prefixed with `{vendorSlug}__` to avoid collisions. On `tools/call`, the prefix is extracted to route to the correct vendor container. Descriptions are truncated to 200 characters to reduce token cost.

### CLI Router (`/v1/:vendor/cli`)

REST API that accepts plain JSON tool calls instead of MCP JSON-RPC. Uses `McpSessionPool` to maintain persistent MCP sessions with vendor containers, avoiding the 3-request handshake per call. Includes result caching with in-flight deduplication for read operations.

### Log Shipping Service

Ships audit logs to external SIEM platforms (Loki, Graylog, LogScale). Per-org configuration with encrypted credentials. Runs as a background process.

### Vendor Monitor

Background health checker that periodically pings vendor containers and reports status. Exposes results via `/health/vendors`.

## Data Flow: MCP Tool Call

```
1. Client sends MCP tools/call request
   POST /v1/mcp (unified) or /v1/:vendor/mcp (per-vendor)
   Authorization: Bearer <JWT>

2. Gateway verifies JWT (HS256, issued by this server)
   Extracts userId from sub claim

3. Credential Injector resolves vendor credentials:
   a. Personal credentials (user-level)
   b. Team credentials (if user is in exactly 1 team with creds)
   c. Org-level credentials
   d. Service client credentials (for svc:orgId:clientId tokens)

4. For OAuth vendors (Xero, QBO, HubSpot, M365):
   If access token is expired, refresh using stored refresh token
   Persist new tokens back to credential store

5. Credentials mapped to vendor-specific HTTP headers:
   e.g., apiKey -> X-Datto-API-Key, apiSecret -> X-Datto-API-Secret

6. Tool allowlist enforcement:
   If org has an allowlist for this vendor/role, verify tool is permitted

7. Request proxied to vendor container:
   POST http://vendor-mcp:8080/mcp
   Headers: vendor-specific auth headers + Mcp-Session-Id

8. Vendor container processes the tool call against the vendor API

9. Response returned through gateway to client

10. Audit log entry written (fire-and-forget):
    user_id, org_id, vendor, tool_name, status, response_time_ms

11. If log shipping configured, entry forwarded to SIEM
```

## Key Design Decisions

### Single JWT for All Vendors

A user authenticates once via OAuth 2.1 and receives a JWT that works across all vendor MCP servers. The gateway resolves which vendors the user has credentials for at request time. This eliminates per-vendor OAuth flows for the end user.

### Encrypted Credential Hierarchy

Credentials are encrypted at rest using AES-256-GCM with PBKDF2-derived keys. The hierarchy (personal > team > org) allows flexible credential sharing:

- **Personal**: individual API keys, full isolation
- **Team**: shared keys for a subset of org members (e.g., "Tier 1 Support" team)
- **Org**: default credentials shared by all members
- **Service Client**: M2M credentials for automated agents

Resolution walks the hierarchy top-down. The first match wins.

### Credential Injection via HTTP Headers

Vendor containers never store credentials. The gateway injects them per-request via HTTP headers. This keeps containers stateless and allows credential rotation without redeploying containers.

### Vendor Container Isolation

Each vendor runs in its own container with `AUTH_MODE=gateway`. Containers trust the gateway for authentication. Some third-party MCP servers (e.g., SentinelOne Purple MCP) use a gateway wrapper middleware that extracts credentials from headers and sets them as environment variables, serialized with an `asyncio.Lock`.

### Tool Name Prefixing (Unified Endpoint)

The unified `/v1/mcp` endpoint prefixes all tool names with `{vendor}__` (e.g., `vendor-a__list_items`). This allows a single MCP connection to access tools from all vendors simultaneously, reducing client configuration to a single URL.

### Session Pooling (CLI Endpoint)

The CLI endpoint maintains a pool of MCP sessions with vendor containers. This avoids the `initialize` / `notifications/initialized` / `tools/list` handshake on every tool call, reducing latency from ~500ms to ~50ms for the auth overhead.
