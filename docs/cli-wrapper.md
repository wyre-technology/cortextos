# CLI Wrapper

The CLI endpoint provides a simplified REST API for executing MCP tool calls without the overhead of the full MCP JSON-RPC protocol. It is designed for scripts, automation, and lightweight integrations.

## Endpoints

### POST /v1/:vendor/cli

Execute a single tool call.

**Authentication:** Bearer JWT (from OAuth 2.1 flow or client_credentials grant)

**Request:**
```json
{
  "tool": "datto_list_devices",
  "args": {
    "siteId": "123"
  }
}
```

**Response (success):**
```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[{\"id\": 1, \"hostname\": \"WS-001\", ...}]"
      }
    ]
  }
}
```

**Response (tool error):**
```json
{
  "error": "No devices found matching the criteria"
}
```

**HTTP Status Codes:**
| Code | Meaning |
|---|---|
| 200 | Success |
| 400 | Missing required field (`tool`) |
| 401 | Authentication required or invalid token |
| 403 | No credentials for vendor, or tool not permitted by allowlist |
| 422 | Tool execution error (vendor returned an error) |
| 429 | Rate limit exceeded |
| 500 | Internal proxy error |
| 502 | Vendor MCP server returned an error |

### GET /v1/:vendor/cli/schema

Get CLI-friendly tool definitions for a vendor. Returns tools as flat command/flag structures instead of nested JSON Schema.

**Authentication:** Bearer JWT

**Response:**
```json
{
  "vendor": "datto-rmm",
  "vendorName": "Datto RMM",
  "commands": [
    {
      "command": "list-devices",
      "description": "List all devices monitored by Datto RMM",
      "flags": [
        {
          "name": "siteId",
          "type": "string",
          "required": false,
          "description": "Filter by site ID"
        },
        {
          "name": "deviceType",
          "type": "string",
          "required": false,
          "description": "Filter by device type"
        }
      ]
    },
    {
      "command": "list-sites",
      "description": "List all sites",
      "flags": []
    }
  ]
}
```

## How It Works

### Request Flow

```
1. Client sends POST /v1/datto-rmm/cli
   { "tool": "datto_list_devices", "args": { "siteId": "123" } }

2. Gateway verifies JWT, resolves credentials
   (same auth + credential injection as MCP proxy)

3. Tool allowlist check
   (if org has an allowlist for this vendor/role)

4. Session pool provides a pre-initialized MCP session

5. Gateway sends JSON-RPC tools/call to vendor container:
   { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
     "params": { "name": "datto_list_devices", "arguments": { "siteId": "123" } } }

6. Vendor container response parsed (SSE or JSON)

7. Plain JSON result returned to client
```

### Session Pooling

The key performance optimization is the `McpSessionPool`. The MCP protocol requires a 3-step handshake before any tool calls:

1. `initialize` (client -> server)
2. `notifications/initialized` (client -> server)
3. `tools/list` (client -> server, to discover available tools)

Only after this handshake can the client send `tools/call`. The session pool maintains pre-initialized sessions per vendor, indexed by vendor slug and credential headers. When a CLI request arrives, it reuses an existing session instead of repeating the handshake.

If a session becomes stale (vendor container restarted, session expired), the pool automatically evicts it and creates a fresh one on retry.

### Result Caching

For read-only tools, the CLI endpoint includes an in-memory result cache with:

- **Per-scope isolation**: Cache keys are scoped by `team:id`, `org:id`, or `user:id`
- **In-flight deduplication**: Concurrent identical requests share a single vendor call
- **Write invalidation**: Write operations automatically invalidate related cache entries
- **Configurable TTL**: Per-vendor, per-tool TTL configuration via `VENDOR_TOOL_CONFIG`

## Token Savings

The CLI endpoint reduces token consumption by approximately 40% compared to using the MCP protocol directly. The savings come from:

### 1. No MCP Protocol Overhead

The full MCP protocol sends JSON-RPC envelopes, capabilities negotiation, and session management messages. The CLI endpoint strips this down to `{ "tool": "...", "args": {...} }`.

### 2. Compact Schema Format

The CLI schema endpoint (`/cli/schema`) converts MCP tool definitions from verbose JSON Schema into flat flag lists:

**MCP format (verbose):**
```json
{
  "name": "datto_list_devices",
  "description": "List all devices monitored by Datto RMM...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "siteId": {
        "type": "string",
        "description": "Filter by site ID"
      }
    },
    "required": []
  }
}
```

**CLI format (compact):**
```json
{
  "command": "list-devices",
  "description": "List all devices monitored by Datto RMM...",
  "flags": [
    { "name": "siteId", "type": "string", "required": false, "description": "Filter by site ID" }
  ]
}
```

### 3. Tool Name Normalization

MCP tool names like `datto_list_devices` are converted to CLI-friendly kebab-case: `list-devices`. This is cosmetic but helps when tools are presented to users or LLMs.

### 4. No Streaming Overhead

MCP responses may use SSE (Server-Sent Events) transport. The CLI endpoint parses SSE internally and returns a single JSON response, eliminating SSE framing tokens from the client's perspective.

## Rate Limiting

Rate limits are applied per user, per vendor:

| Plan | Limit |
|---|---|
| Free | 100 requests/hour/vendor |
| Pro | 1,000 requests/hour/vendor |

The rate limit key is `{userId}:{vendor}:cli`.

## Timing Headers

Every response includes timing breakdown headers:

| Header | Description |
|---|---|
| `X-Auth-Ms` | JWT verification + credential resolution time |
| `X-Session-Ms` | MCP session acquisition time (cache hit = ~0ms) |
| `X-Vendor-Ms` | Vendor container response time |
| `X-Total-Ms` | Total request time |

Example: `X-Auth-Ms: 12, X-Session-Ms: 2, X-Vendor-Ms: 340, X-Total-Ms: 354`

## Usage Examples

### Bash / curl

> **Note:** The examples below use specific vendor names (e.g., `datto-rmm`, `itglue`, `autotask`) for illustration. Replace with the vendors configured in your deployment.

```bash
TOKEN="eyJ..."

# List Datto RMM devices
curl -s -X POST https://gateway.example.com/v1/datto-rmm/cli \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "datto_list_devices"}' | jq '.result'

# Get tool schema
curl -s https://gateway.example.com/v1/datto-rmm/cli/schema \
  -H "Authorization: Bearer $TOKEN" | jq '.commands[].command'

# Search IT Glue configurations
curl -s -X POST https://gateway.example.com/v1/itglue/cli \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "search_configurations", "args": {"filter": "hostname:WS-001"}}' | jq
```

### Service Client Authentication

```bash
# Get a token via client_credentials grant
TOKEN=$(curl -s -X POST https://gateway.example.com/oauth/token \
  -d "grant_type=client_credentials" \
  -d "client_id=svc_abc123" \
  -d "client_secret=xyz789" \
  -d "scope=mcp:all" | jq -r '.access_token')

# Use the token for CLI calls
curl -s -X POST https://gateway.example.com/v1/autotask/cli \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool": "autotask_search_tickets", "args": {"status": "Open"}}'
```
