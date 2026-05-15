# MSP Customer Onboarding Guide

> **MIGRATED — this file is no longer the source of truth.**
>
> The customer-facing version lives at [`docs/src/content/docs/guides/msp-onboarding.mdx`](src/content/docs/guides/msp-onboarding.mdx) and is published at `https://conduit.wyre.ai/docs/guides/msp-onboarding`. The Starlight version is rebranded to Conduit and has corrected UI paths (the `/settings/*` → `/org/*` IA hoist from PRs #57/#73/#90).
>
> This file is preserved as engineering reference until the legacy `docs/*.md` sweep-delete. Do not extend this file — make changes in the Starlight `.mdx` version.

---

This document describes the end-to-end flow for onboarding a new Managed Service Provider (MSP) onto the MCP Gateway platform.

## Phase 1: Discovery

### Identify Vendor Stack

Work with the MSP to inventory which vendors they use. The gateway is vendor-agnostic -- the specific vendors configured for each deployment depend on what the customer uses. During discovery, identify all tools in the customer's stack and determine which vendor integrations to enable.

Common vendor categories include:

| Category | Examples |
|---|---|
| RMM | Datto RMM, Syncro, Atera, SuperOps, ConnectWise Automate, NinjaOne |
| PSA | Autotask, HaloPSA, ConnectWise PSA |
| Documentation | IT Glue, Hudu, Liongard |
| Security | RocketCyber, SentinelOne, Huntress, Blumira, runZero |
| Email Security | Avanan, Proofpoint, KnowBe4 |
| Network | Domotz |
| Sales | SalesBuildr, PandaDoc, Pax8 |
| Accounting | Xero, QuickBooks Online |
| CRM | HubSpot |
| Productivity | Microsoft 365 |
| Marketplace | Sherweb |

> **Note:** The table above lists example vendors. The actual vendors available in your deployment are configured during customer onboarding based on what tools the MSP uses. See `vendor-integration.md` for how to add new vendor integrations.

### Gather Requirements

- **Team size**: How many technicians will use the platform?
- **Role structure**: Who needs access to which vendors?
- **Credential model**: Shared org-level API keys or per-team/per-user keys?
- **Compliance needs**: Do they require audit log export or SIEM integration?
- **AI client preference**: Claude Desktop, Claude Code, or custom automation via service clients?

## Phase 2: Build-Out

### 1. Create the Organization

The MSP owner creates an org via the web UI at `/settings` or the API:

```
POST /api/orgs
{
  "name": "Acme MSP",
  "invite_code": "<alpha-invite-code>"    // Optional: grants Pro plan
}
```

An alpha invite code immediately upgrades the org to the Pro plan. Without one, the org starts on the free plan (3 vendor connections, 100 requests/hour/vendor).

### 2. Upgrade to Pro Plan

If not using an invite code, the owner can:
- Start a Stripe checkout session: `POST /api/billing/checkout { "org_id": "..." }`
- Redeem a code later: `POST /api/orgs/:orgId/redeem-code { "code": "..." }`

Pro plan unlocks:
- Unlimited vendor connections
- 1,000 requests/hour/vendor
- Team features (members, roles, invitations)
- Tool allowlists (RBAC)
- Audit log access and CSV export
- Log shipping to SIEM (Loki, Graylog, LogScale)
- Service clients for M2M automation

### 3. Connect Vendor Credentials

For each vendor the MSP uses, configure credentials at the org level:

**API-key vendors** (most vendors): Navigate to `/settings/team/connections` and click "Connect" next to the vendor. Enter the required API keys/secrets.

**OAuth vendors** (Xero, QuickBooks, HubSpot, M365): Click "Connect" and complete the OAuth flow. The gateway handles token exchange and stores refresh tokens for automatic renewal.

Credentials can also be stored via API:

```
POST /api/orgs/:orgId/credentials/:vendor
{
  "apiKey": "...",
  "apiSecret": "..."
}
```

### 4. Configure Server Access

By default, new members get access based on the org's `defaultServerAccess` setting (`all` or `none`). To control which vendors each member can use:

```
PUT /api/orgs/:orgId/members/:userId/server-access
{
  "vendors": ["datto-rmm", "itglue", "autotask"]
}
```

Or grant individual vendors:

```
PUT /api/orgs/:orgId/members/:userId/server-access/datto-rmm
```

### 5. Set Up Teams (Optional)

For MSPs with distinct groups (e.g., "Tier 1 Support", "Security Team", "Accounting"):

```
POST /api/orgs/:orgId/teams
{ "name": "Tier 1 Support" }
```

Teams can have their own vendor credentials (separate API keys) and their own vendor access grants:

```
PUT /api/orgs/:orgId/teams/:teamId/server-access/datto-rmm
```

### 6. Configure Tool Allowlists (Optional)

Restrict which tools a role can access per vendor:

```
PUT /api/orgs/:orgId/tool-access/datto-rmm/member
{
  "tools": ["datto_list_devices", "datto_list_sites", "datto_list_alerts"]
}
```

Owners always have full access. Setting no allowlist means all tools are available.

### 7. Invite Team Members

Generate invitation links:

```
POST /api/orgs/:orgId/invitations
```

Returns an invitation URL like `https://gateway.example.com/invite/<token>`. Share with team members. When they visit the link and sign in via Auth0, they join the org as a `member`.

Admins can promote members:

```
PATCH /api/orgs/:orgId/members/:userId/role
{ "role": "admin" }
```

### 8. Create Service Clients (Optional)

For M2M automation (AI agents, scripts, integrations):

```
POST /api/orgs/:orgId/service-clients
{
  "name": "Nightly Ticket Sync",
  "expires_in_days": 90
}
```

Returns a `client_id` and `client_secret` (shown once). The service client authenticates via `client_credentials` grant and receives a JWT scoped to the org.

### 9. Configure Log Shipping (Optional)

For compliance or monitoring, ship audit logs to an external SIEM:

```
POST /api/orgs/:orgId/log-shipping
{
  "label": "Production Loki",
  "platform": "loki",
  "endpointUrl": "https://loki.internal.example.com/loki/api/v1/push",
  "config": { "username": "...", "password": "..." }
}
```

Supported platforms: Loki, Graylog, LogScale.

## Phase 3: Go-Live Checklist

- [ ] Organization created and on Pro plan
- [ ] All required vendor credentials connected and validated
- [ ] Server access grants configured for each member
- [ ] Tool allowlists set for restricted roles (if needed)
- [ ] Team members invited and accepted
- [ ] Claude Desktop or Claude Code configured with the MCP server URL
- [ ] Service clients created for any automation workflows
- [ ] Audit log verified (make a test tool call and check `/api/audit`)
- [ ] Log shipping tested (if configured)
- [ ] MSP owner has verified they can access the Stripe billing portal

### Client Configuration

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "wyre": {
      "url": "https://gateway.example.com/v1/mcp"
    }
  }
}
```

**Claude Code**:
```
claude mcp add wyre https://gateway.example.com/v1/mcp
```

On first use, the OAuth flow opens a browser for authentication. After sign-in and credential connection, the JWT is cached and refreshed automatically.

## Phase 4: Ongoing Support

### Monitoring

- **Vendor health**: `GET /health/vendors` shows container-level health for all vendors
- **Audit log**: `GET /api/audit` with filters for user, vendor, date range
- **Admin audit**: `GET /api/audit/admin` for administrative action history

### Common Operations

| Task | Endpoint |
|---|---|
| Add a new team member | `POST /api/orgs/:orgId/invitations` |
| Remove a member | `DELETE /api/orgs/:orgId/members/:userId` |
| Rotate vendor credentials | `POST /api/orgs/:orgId/credentials/:vendor` (overwrites) |
| Change member role | `PATCH /api/orgs/:orgId/members/:userId/role` |
| Export audit log | `GET /api/audit?format=csv` |
| Manage billing | `POST /api/billing/portal` |

### Credential Rotation

When rotating vendor API keys, update credentials at the appropriate scope:
- **Org-level**: `/api/orgs/:orgId/credentials/:vendor` or web UI at `/settings/team/connections`
- **Team-level**: `/api/orgs/:orgId/teams/:teamId/credentials/:vendor`
- **Personal**: Web UI at `/settings` (individual user connects)

The gateway encrypts new credentials and begins using them immediately. Old credentials are overwritten.
