# API Reference

> **MIGRATED — this file is no longer the source of truth.**
>
> The customer-facing version lives at [`docs/src/content/docs/reference/api.mdx`](src/content/docs/reference/api.mdx) and is published at `https://conduit.wyre.ai/docs/reference/api`. Endpoint paths in the Starlight version were verified against the registered routes in `src/`.
>
> This file is preserved as engineering reference until the legacy `docs/*.md` sweep-delete. Do not extend this file — make changes in the Starlight `.mdx` version.

---

All endpoints require authentication unless noted otherwise. Authentication is via Auth0 OIDC session (web UI routes) or Bearer JWT (API/MCP routes).

> **Note:** Examples in this document use vendor names like `datto-rmm`, `itglue`, and `autotask` for illustration. The actual vendors available depend on your deployment configuration.

## Health & Monitoring

### GET /health

Health check endpoint. No authentication required.

**Response:**
```json
{ "status": "ok", "timestamp": "2026-03-26T12:00:00.000Z" }
```

### GET /health/vendors

Vendor container health status. No authentication required.

**Response:**
```json
{
  "timestamp": "2026-03-26T12:00:00.000Z",
  "vendors": {
    "datto-rmm": { "status": "healthy", "lastCheck": "..." },
    "itglue": { "status": "healthy", "lastCheck": "..." }
  }
}
```

---

## OAuth 2.1 Endpoints

### GET /.well-known/oauth-authorization-server

RFC 8414 authorization server metadata. No authentication required.

### GET /.well-known/oauth-protected-resource/v1/mcp

RFC 9728 protected resource metadata for the unified MCP endpoint.

### POST /oauth/register

Dynamic client registration (RFC 7591). Used by MCP clients (Claude Desktop, mcp-remote) to register before starting the OAuth flow.

### GET /oauth/authorize

Authorization endpoint. Requires PKCE (S256). Redirects user to Auth0 for authentication, then to the credential connection page if needed.

**Query Parameters:**
- `response_type` -- must be `code`
- `client_id` -- from dynamic registration
- `redirect_uri` -- client callback URL
- `code_challenge` -- PKCE S256 challenge
- `code_challenge_method` -- must be `S256`
- `scope` -- `mcp:<vendor>` (per-vendor) or `mcp:all` (unified)
- `state` -- client-generated state parameter

### POST /oauth/token

Token exchange and refresh.

**Code Exchange:**
```
grant_type=authorization_code
&code=<auth_code>
&redirect_uri=<redirect_uri>
&client_id=<client_id>
&code_verifier=<pkce_verifier>
```

**Refresh:**
```
grant_type=refresh_token
&refresh_token=<refresh_token>
&client_id=<client_id>
```

**Client Credentials (Service Clients):**
```
grant_type=client_credentials
&client_id=<svc_client_id>
&client_secret=<svc_client_secret>
&scope=mcp:all
```

**Response:**
```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<token>"
}
```

### POST /oauth/revoke

Token revocation (RFC 7009).

```
token=<token>&token_type_hint=access_token
```

---

## Profile

### GET /api/profile

Returns the authenticated user's profile.

**Auth:** Auth0 session

**Response:**
```json
{
  "id": "auth0|abc123",
  "email": "user@example.com",
  "name": "John Doe",
  "firstName": "John",
  "lastName": "Doe",
  "displayName": "JD"
}
```

### PATCH /api/profile

Update profile fields.

**Auth:** Auth0 session

**Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "displayName": "JD"
}
```

---

## Organization CRUD

### POST /api/orgs

Create a new organization.

**Auth:** Auth0 session
**Body:**
```json
{
  "name": "Acme MSP",
  "invite_code": "ALPHA123"
}
```
**Response:** `201` with org object

### GET /api/orgs

List the authenticated user's organizations.

**Auth:** Auth0 session
**Response:** Array of org objects

### GET /api/orgs/:orgId

Get org details.

**Auth:** Auth0 session (member+)
**Response:** Org object

### PATCH /api/orgs/:orgId

Update org name.

**Auth:** Auth0 session (owner)
**Body:** `{ "name": "New Name" }`

### DELETE /api/orgs/:orgId

Delete organization.

**Auth:** Auth0 session (owner)
**Response:** `204 No Content`

### POST /api/orgs/:orgId/redeem-code

Redeem an invite code to upgrade to Pro. Rate limited: 5 per 15 minutes.

**Auth:** Auth0 session (owner)
**Body:** `{ "code": "ALPHA123" }`

### PATCH /api/orgs/:orgId/settings

Update org settings.

**Auth:** Auth0 session (owner)
**Body:**
```json
{ "defaultServerAccess": "all" }
```
Values: `"none"` or `"all"`

---

## Membership

### GET /api/orgs/:orgId/members

List org members.

**Auth:** Auth0 session (member+)
**Response:** Array of member objects

### DELETE /api/orgs/:orgId/members/:userId

Remove a member. Admins cannot remove other admins; only owners can.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

### PATCH /api/orgs/:orgId/members/:userId/role

Change member role. Cannot change your own role.

**Auth:** Auth0 session (owner)
**Body:** `{ "role": "admin" }` (or `"member"`)

---

## Invitations

### POST /api/orgs/:orgId/invitations

Create an invitation link. Rate limited: 10 per hour. Requires Pro plan.

**Auth:** Auth0 session (admin+)
**Response:**
```json
{
  "id": "...",
  "token": "...",
  "inviteUrl": "https://gateway.example.com/invite/<token>",
  "expiresAt": "...",
  "maxUses": 1,
  "useCount": 0
}
```

### GET /api/orgs/:orgId/invitations

List pending invitations.

**Auth:** Auth0 session (admin+)

### DELETE /api/orgs/:orgId/invitations/:id

Revoke an invitation.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

### GET /invite/:token

Show invitation acceptance page (web UI).

### POST /invite/:token

Accept an invitation. Rate limited: 5 per 15 minutes.

---

## Server Access Control

### GET /api/orgs/:orgId/server-access

List all server access grants for the org.

**Auth:** Auth0 session (admin+)

### GET /api/orgs/:orgId/members/:userId/server-access

List a user's vendor access grants. Users can view their own; admins can view any member's.

**Auth:** Auth0 session (member for self, admin+ for others)

### PUT /api/orgs/:orgId/members/:userId/server-access/:vendor

Grant a member access to a vendor.

**Auth:** Auth0 session (admin+)

### DELETE /api/orgs/:orgId/members/:userId/server-access/:vendor

Revoke a member's access to a vendor.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

### PUT /api/orgs/:orgId/members/:userId/server-access

Bulk-set a member's vendor access (replaces all grants).

**Auth:** Auth0 session (admin+)
**Body:** `{ "vendors": ["datto-rmm", "itglue", "autotask"] }`

---

## Credentials

### POST /api/orgs/:orgId/credentials/:vendor

Store or update org-level credentials for a vendor. Rate limited: 10 per minute. Requires Pro plan. Validates credentials against vendor API when possible.

**Auth:** Auth0 session (admin+)
**Body:** Vendor-specific fields (see vendor-integration.md)

```json
{
  "apiKey": "your-api-key",
  "apiSecret": "your-api-secret",
  "platform": "concord"
}
```

**Response:** `201` with `{ "id": "...", "vendor": "datto-rmm" }`

### GET /api/orgs/:orgId/credentials

List connected vendor slugs for the org.

**Auth:** Auth0 session (member+)
**Response:** `["datto-rmm", "itglue", "autotask"]`

### DELETE /api/orgs/:orgId/credentials/:vendor

Remove org-level credentials for a vendor.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

---

## Teams

### POST /api/orgs/:orgId/teams

Create a team. Requires Pro plan.

**Auth:** Auth0 session (admin+)
**Body:** `{ "name": "Tier 1 Support" }`
**Response:** `201` with team object

### GET /api/orgs/:orgId/teams

List teams with member counts and vendor connections.

**Auth:** Auth0 session (admin+)

### PATCH /api/orgs/:orgId/teams/:teamId

Rename a team.

**Auth:** Auth0 session (admin+)
**Body:** `{ "name": "New Name" }`

### DELETE /api/orgs/:orgId/teams/:teamId

Delete a team.

**Auth:** Auth0 session (owner)
**Response:** `204 No Content`

### PUT /api/orgs/:orgId/teams/:teamId/members/:userId

Add a member to a team.

**Auth:** Auth0 session (admin+)

### DELETE /api/orgs/:orgId/teams/:teamId/members/:userId

Remove a member from a team.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

### PUT /api/orgs/:orgId/teams/:teamId/server-access/:vendor

Grant a team access to a vendor.

**Auth:** Auth0 session (admin+)

### DELETE /api/orgs/:orgId/teams/:teamId/server-access/:vendor

Revoke a team's access to a vendor.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

---

## Team Credentials

### GET /api/orgs/:orgId/teams/:teamId/credentials

List vendors with team-level credentials.

**Auth:** Auth0 session (admin+)

### POST /api/orgs/:orgId/teams/:teamId/credentials/:vendor

Store team-level credentials for a vendor.

**Auth:** Auth0 session (admin+)
**Body:** Vendor-specific credential fields

### DELETE /api/orgs/:orgId/teams/:teamId/credentials/:vendor

Remove team-level credentials.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

---

## Service Clients (M2M)

### POST /api/orgs/:orgId/service-clients

Create a service client for M2M authentication.

**Auth:** Auth0 session (admin+)
**Body:**
```json
{
  "name": "Nightly Sync",
  "expires_in_days": 90
}
```
**Response:** `201`
```json
{
  "id": "...",
  "name": "Nightly Sync",
  "client_id": "svc_...",
  "client_secret": "<shown-once>",
  "expires_at": "2026-06-24T00:00:00.000Z",
  "created_at": "2026-03-26T00:00:00.000Z"
}
```

### GET /api/orgs/:orgId/service-clients

List service clients (secret is never returned after creation).

**Auth:** Auth0 session (admin+)

### DELETE /api/orgs/:orgId/service-clients/:clientId

Revoke a service client.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

### GET /api/orgs/:orgId/service-clients/:clientId/credentials

List vendors with service-client-level credentials.

**Auth:** Auth0 session (admin+)

### POST /api/orgs/:orgId/service-clients/:clientId/credentials/:vendor

Store service-client-level credentials.

**Auth:** Auth0 session (admin+)

### DELETE /api/orgs/:orgId/service-clients/:clientId/credentials/:vendor

Remove service-client-level credentials.

**Auth:** Auth0 session (admin+)
**Response:** `204 No Content`

---

## Tool Access (RBAC)

### GET /api/orgs/:orgId/tool-access/:vendor

Get tool allowlists for all roles for a vendor.

**Auth:** Auth0 session (admin+)

### PUT /api/orgs/:orgId/tool-access/:vendor/:role

Set the tool allowlist for a role. When set, members with that role can only use the listed tools.

**Auth:** Auth0 session (owner)
**Body:** `{ "tools": ["datto_list_devices", "datto_list_sites"] }`

### DELETE /api/orgs/:orgId/tool-access/:vendor/:role

Clear the allowlist (revert to allow-all).

**Auth:** Auth0 session (owner)
**Response:** `204 No Content`

### GET /api/orgs/:orgId/tool-access/:vendor/discover

Discover available tools from a vendor container (queries the live container).

**Auth:** Auth0 session (admin+)

---

## Audit

### GET /api/audit

Query the request audit log. Requires Pro plan and admin+ role.

**Auth:** Auth0 session
**Query Parameters:**
- `org_id` -- filter by org (defaults to user's primary org)
- `user_id` -- filter by user
- `vendor` -- filter by vendor slug
- `start` -- ISO date start
- `end` -- ISO date end
- `limit` -- page size
- `offset` -- page offset
- `format` -- `csv` for CSV export

### GET /api/audit/admin

Query the admin audit log (administrative actions).

**Auth:** Auth0 session (admin+, Pro plan)
**Query Parameters:**
- `org_id`, `event_type`, `actor_id`, `start`, `end`, `limit`, `offset`, `format`

---

## Billing

### POST /api/billing/checkout

Create a Stripe Checkout session for Pro plan subscription.

**Auth:** Auth0 session (owner)
**Body:**
```json
{
  "org_id": "...",
  "coupon": "DISCOUNT20"
}
```
**Response:** `{ "url": "https://checkout.stripe.com/..." }`

### POST /api/billing/portal

Create a Stripe Customer Portal session for managing subscription.

**Auth:** Auth0 session (owner)
**Body:** `{ "org_id": "..." }`
**Response:** `{ "url": "https://billing.stripe.com/..." }`

---

## Log Shipping

### GET /api/orgs/:orgId/log-shipping

List log shipping destinations (configs are masked).

**Auth:** Auth0 session (admin+, Pro plan)

### POST /api/orgs/:orgId/log-shipping

Create a log shipping destination.

**Auth:** Auth0 session (admin+, Pro plan)
**Body:**
```json
{
  "label": "Production Loki",
  "platform": "loki",
  "endpointUrl": "https://loki.example.com/loki/api/v1/push",
  "config": { "username": "...", "password": "..." }
}
```

---

## CLI Endpoints

### POST /v1/:vendor/cli

Execute a tool call via plain JSON (not MCP JSON-RPC). Rate limited per user/vendor.

**Auth:** Bearer JWT
**Body:**
```json
{
  "tool": "datto_list_devices",
  "args": { "siteId": "123" }
}
```
**Response:**
```json
{ "result": { "content": [...] } }
```
**Response Headers:** `X-Auth-Ms`, `X-Session-Ms`, `X-Vendor-Ms`, `X-Total-Ms`

### GET /v1/:vendor/cli/schema

Get CLI-friendly tool definitions for a vendor.

**Auth:** Bearer JWT
**Response:**
```json
{
  "vendor": "datto-rmm",
  "vendorName": "Datto RMM",
  "commands": [
    {
      "command": "list-devices",
      "description": "List all devices",
      "flags": [
        { "name": "siteId", "type": "string", "required": false, "description": "..." }
      ]
    }
  ]
}
```

---

## MCP Proxy Endpoints

### POST /v1/mcp (Unified)

Single MCP endpoint for all vendors. Handles `initialize`, `tools/list` (aggregated), and `tools/call` (routed by vendor prefix).

**Auth:** Bearer JWT (via OAuth 2.1 flow)

### POST /v1/:vendor/mcp (Per-Vendor, Deprecated)

Per-vendor MCP endpoint. Legacy; prefer the unified endpoint.

**Auth:** Bearer JWT (via OAuth 2.1 flow)

---

## Waitlist

### POST /waitlist

Add email to waitlist. No authentication required. Rate limited: 5 per hour.

**Body:** `{ "email": "user@example.com", "name": "John Doe" }`

### GET /admin/waitlist

List all waitlist signups. Requires admin API key.

**Auth:** `X-Admin-API-Key` header
