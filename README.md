# MCP Gateway Platform

White-label AI tool gateway for managed service providers. Connects Claude Desktop, Claude Code, and other MCP clients to any vendor's API through a centralized, multi-tenant OAuth 2.1 proxy with encrypted credential storage.

## What It Does

```
Claude Desktop/Code
    |
    +-- (1) Connect via OAuth 2.1 + PKCE
    |       -> Browser opens branded credential form
    |       -> User enters vendor API credentials
    |       -> Gateway encrypts + stores, issues tokens
    |
    +-- (2) Make tool calls (MCP or CLI)
            -> Validates JWT, decrypts credentials
            -> Injects vendor-specific auth headers
            -> Proxies to vendor MCP container
            -> Logs call in audit trail
            -> Returns results
```

## Key Capabilities

- **Multi-tenant organizations** — Orgs, teams, members with owner/admin/member roles
- **Encrypted credential hierarchy** — Personal → team → org credential resolution, AES-256-GCM
- **Tool-level RBAC** — Per-vendor, per-role tool allowlists
- **Audit logging** — Every tool call logged with optional argument + prompt capture
- **CLI wrapper** — REST endpoint that bypasses MCP handshake (~40% token savings)
- **Usage dashboards** — Analytics, per-vendor breakdown, token savings tracking
- **Log shipping** — Forward audit logs to Loki, Graylog, or LogScale
- **White-label branding** — All UI branding configurable via `BRAND_*` env vars
- **Configurable plans** — Data-driven plan catalog (vendor limits, rate limits, features)
- **Feature flags** — Conditionally enable billing, waitlist, dashboard, prompt capture

## Vendor-Agnostic

The platform ships with **no pre-configured vendors**. Vendors are added during customer onboarding based on discovery:

1. Identify the customer's tool stack
2. Add vendor MCP server containers (existing GHCR images or custom builds)
3. Configure credential fields in `src/credentials/vendor-config.ts`
4. Deploy — the gateway handles auth, encryption, proxying, and audit

See [docs/vendor-integration.md](docs/vendor-integration.md) for the full guide.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env — set MASTER_KEY, JWT_SECRET, DATABASE_URL, AUTH0_* at minimum

# Development
npm run dev

# Build and run
npm run build
npm start
```

### Docker Compose

```bash
# Start gateway + PostgreSQL
docker compose up --build
```

Gateway runs on `http://localhost:8080`. PostgreSQL on `localhost:5432`.

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the complete reference.

### Brand Customization

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAND_NAME` | `Wyre Technology` | Company name in UI |
| `BRAND_ISSUES_URL` | GitHub issues | Support/bug report URL |
| `BRAND_PRIMARY_COLOR` | `#2563eb` | Accent color |
| `BRAND_LOGO_URL` | `/assets/logo.svg` | Logo image URL |

### Plan Catalog

Override the default free/pro plans via `PLAN_CATALOG` env var (JSON array) or use the admin API to set plans per org.

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `FEATURE_DASHBOARD` | `true` | Usage analytics dashboard |
| `FEATURE_PROMPT_CAPTURE` | `true` | Prompt/argument capture in audit logs |
| `STRIPE_SECRET_KEY` | — | Set to enable Stripe billing (optional) |
| `WAITLIST_NOTIFY_URL` | — | Set to enable waitlist signup page |

## Architecture

```
src/
  index.ts                      # Fastify entry point
  config.ts                     # Environment configuration + feature flags
  brand/                        # White-label brand configuration
  auth/                         # Auth0 OIDC login/callback/logout
  audit/                        # Request + admin audit logging
  billing/                      # Plan catalog, billing gate, Stripe (optional)
  credentials/                  # Vendor config + encrypted credential CRUD
  dashboard/                    # Usage analytics + token savings
  log-shipping/                 # Loki, Graylog, LogScale adapters
  monitoring/                   # Vendor health monitoring
  oauth/                        # OAuth 2.1 authorization server
  org/                          # Organizations, teams, members, RBAC
  profile/                      # User profile management
  proxy/                        # MCP proxy, CLI router, credential injection
  waitlist/                     # Waitlist signup (optional)
  web/                          # Settings UI templates + layout
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System diagram, components, data flow |
| [Onboarding Guide](docs/onboarding-guide.md) | MSP customer onboarding workflow |
| [API Reference](docs/api-reference.md) | All endpoints with examples |
| [Vendor Integration](docs/vendor-integration.md) | Adding new vendor MCP servers |
| [Deployment](docs/deployment.md) | Azure deployment + Terraform |
| [White Label](docs/white-label.md) | Brand configuration |
| [Prompt Capture](docs/prompt-capture.md) | Audit log prompt capture |
| [CLI Wrapper](docs/cli-wrapper.md) | CLI endpoint + token savings |

## Security

- **Credential encryption**: AES-256-GCM with per-scope PBKDF2 key derivation
- **OAuth 2.1**: PKCE with S256 code challenge (mandatory)
- **JWT access tokens**: HS256 signed, configurable TTL
- **Refresh token rotation**: Old token revoked on every use
- **Role-based access**: Owner/admin/member roles with per-vendor tool allowlists
- **Audit trail**: Every tool call logged, optional argument + prompt capture

## License

Apache-2.0
