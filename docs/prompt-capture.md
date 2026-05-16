# Prompt Capture

> **MIGRATED — this file is no longer the source of truth.**
> The customer-facing version lives at [`docs/src/content/docs/reference/prompt-capture.mdx`](src/content/docs/reference/prompt-capture.mdx), published at `https://conduit.wyre.ai/docs/reference/prompt-capture`. Do not extend this file — edit the Starlight version.

## Overview

The gateway captures metadata about every MCP tool call in the `request_log` table. This provides visibility into how AI tools are being used across the organization.

## What Is Captured

Each tool call generates a log entry with the following fields:

| Field | Description |
|---|---|
| `id` | Unique log entry ID (nanoid) |
| `user_id` | The authenticated user who made the call |
| `org_id` | The organization context (if applicable) |
| `vendor_slug` | Which vendor was called (e.g., `datto-rmm`) |
| `tool_name` | The specific tool invoked (e.g., `datto_list_devices`) |
| `status_code` | HTTP status code of the response |
| `response_time_ms` | End-to-end latency in milliseconds |
| `created_at` | Timestamp of the request |

## What Is NOT Captured

The gateway does **not** capture:

- The user's prompt or conversation context
- Tool call arguments (the parameters passed to the tool)
- Tool call results (the data returned by the vendor)
- The AI model's reasoning or chain-of-thought

This is a deliberate privacy decision. The audit log records *what tools were used, by whom, and when* -- not the content of the interaction.

## Per-Org Access Control

Audit log access is gated by:

1. **Plan**: Only Pro plan organizations can access audit logs
2. **Role**: Only `admin` and `owner` roles can view the audit log
3. **Scope**: Users can only see logs for their own organization

## API Access

### Query Audit Log

```
GET /api/audit?vendor=datto-rmm&start=2026-03-01&end=2026-03-26&limit=100
```

**Parameters:**
- `org_id` -- filter by org (defaults to primary org)
- `user_id` -- filter by specific user
- `vendor` -- filter by vendor slug
- `start` / `end` -- ISO date range
- `limit` / `offset` -- pagination

**Response:**
```json
{
  "entries": [
    {
      "id": "abc123",
      "userId": "auth0|user1",
      "orgId": "org_xyz",
      "vendorSlug": "datto-rmm",
      "toolName": "datto_list_devices",
      "statusCode": 200,
      "responseTimeMs": 342,
      "createdAt": "2026-03-26T14:30:00.000Z"
    }
  ],
  "total": 1
}
```

### CSV Export

```
GET /api/audit?format=csv&start=2026-03-01&end=2026-03-26
```

Returns a downloadable CSV file with headers: `id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, created_at`.

### Admin Audit Log

Administrative actions (member invited, role changed, credentials updated, etc.) are tracked separately:

```
GET /api/audit/admin?event_type=member_invited&start=2026-03-01
```

**Event types:**
- `org_updated` -- org name or settings changed
- `org_deleted` -- org deleted
- `member_invited` -- invitation created
- `invitation_accepted` -- member joined via invitation
- `invitation_revoked` -- invitation revoked
- `member_removed` -- member removed from org
- `role_changed` -- member role updated
- `server_access_granted` / `server_access_revoked` -- vendor access changed
- `server_access_bulk_set` -- bulk vendor access update
- `org_credential_created` / `org_credential_deleted` -- org credential changed
- `team_created` / `team_renamed` / `team_deleted` -- team lifecycle
- `team_member_added` / `team_member_removed` -- team membership
- `team_server_access_granted` / `team_server_access_revoked` -- team vendor access
- `service_client_created` / `service_client_revoked` -- M2M client lifecycle

## Web UI

The audit log is accessible from the team management sidebar at `/settings/team/audit`. It provides a filterable view of both request and admin audit logs.

## Data Retention

Request log entries older than 90 days are automatically cleaned up on gateway startup. The cleanup runs as a fire-and-forget background task:

```typescript
orgService.cleanupRequestLog(90).then((count) => {
  if (count > 0) app.log.info(`Cleaned up ${count} request_log entries`);
});
```

## Log Shipping

For organizations that require long-term retention or integration with existing SIEM infrastructure, the gateway supports shipping audit logs to external platforms:

- **Loki** -- Grafana's log aggregation system
- **Graylog** -- Open-source log management
- **LogScale** (formerly Humio) -- Real-time log analysis

Configure via the Log Shipping API or the web UI at `/settings/team/log-shipping`.

## CLI Timing Headers

The CLI endpoint (`POST /v1/:vendor/cli`) returns timing breakdown in response headers for performance monitoring:

| Header | Description |
|---|---|
| `X-Auth-Ms` | Time spent on authentication and credential resolution |
| `X-Session-Ms` | Time spent acquiring an MCP session with the vendor |
| `X-Vendor-Ms` | Time spent waiting for the vendor container response |
| `X-Total-Ms` | Total end-to-end time |

These headers are useful for diagnosing latency issues and understanding where time is spent in the request pipeline.

## Privacy Considerations

- **No prompt content**: The system never sees or stores the user's prompt, conversation history, or AI model output
- **No tool arguments**: API call parameters (e.g., search queries, ticket IDs) are not logged
- **No response content**: Data returned by vendor APIs is not stored
- **Metadata only**: The audit log is limited to who used what tool, when, and how long it took
- **Encrypted at rest**: The PostgreSQL database storing audit logs should be configured with encryption at rest (enabled by default on Azure Flexible Server)
- **Access controlled**: Only Pro plan admins/owners can access audit data
- **Auto-cleanup**: 90-day retention with automatic purge
