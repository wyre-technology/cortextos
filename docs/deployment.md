# Deployment Guide

The Wyre MCP Gateway deploys to Azure Container Apps using Terraform for infrastructure provisioning. This guide covers the full deployment pipeline.

## Infrastructure Overview

The Terraform configuration in `infrastructure/azure/` provisions:

| Resource | Terraform File | Purpose |
|---|---|---|
| Resource Group | `main.tf` | Container for all Azure resources |
| Virtual Network + Subnets | `networking.tf` | Network isolation |
| Container Apps Environment | `container-apps.tf` | Managed container orchestration |
| Container Registry (ACR) | `acr.tf` | Docker image storage |
| PostgreSQL Flexible Server | `database.tf` | Primary data store |
| Azure Key Vault | `keyvault.tf` | Secrets management |
| Redis Cache | `redis.tf` | Session/cache store |
| Log Analytics + App Insights | `monitoring.tf` | Observability |

## Prerequisites

- Azure CLI authenticated (`az login`)
- Terraform >= 1.5
- Docker with buildx
- Access to the GitHub Container Registry (`ghcr.io/wyre-technology/`)

## Environment Variables

### Gateway Application

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 8080) |
| `HOST` | No | Bind address (default: 0.0.0.0) |
| `BASE_URL` | Yes | Public URL (e.g., `https://mcp.wyre.ai`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `MASTER_KEY` | Yes | 64 hex chars (32 bytes) for credential encryption |
| `JWT_SECRET` | Yes | 64 hex chars (32 bytes) for JWT signing |
| `AUTH0_DOMAIN` | Yes | Auth0 domain (e.g., `wyre.us.auth0.com`) |
| `AUTH0_CLIENT_ID` | Yes | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | Yes | Auth0 application client secret |
| `AUTH0_CALLBACK_URL` | Yes | Auth0 callback URL (e.g., `https://mcp.wyre.ai/auth/callback`) |
| `STRIPE_SECRET_KEY` | No | Stripe API key for billing |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | No | Stripe price ID for Pro plan |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |
| `ACCESS_TOKEN_TTL` | No | Access token lifetime in seconds (default: 3600) |
| `REFRESH_TOKEN_TTL` | No | Refresh token lifetime in seconds (default: 2592000) |
| `AUTH_CODE_TTL` | No | Authorization code lifetime in seconds (default: 300) |
| `ALPHA_INVITE_CODES` | No | Comma-separated invite codes for Pro plan |
| `ADMIN_API_KEY` | No | API key for admin endpoints (e.g., waitlist export) |
| `MONITOR_WEBHOOK_URL` | No | Discord/Slack webhook for vendor health alerts |
| `MONITOR_INTERVAL_MS` | No | Vendor health check interval (default: 60000) |
| `WAITLIST_NOTIFY_URL` | No | Webhook URL for waitlist signup notifications |

### OAuth Vendor Credentials (Gateway-Level)

These are the gateway's own OAuth app credentials for vendors that use OAuth flows:

| Variable | Vendor |
|---|---|
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Xero |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | QuickBooks Online |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft 365 |

### Vendor Container URLs

Override default container URLs in production:

| Variable | Default |
|---|---|
| `VENDOR_URL_DATTO_RMM` | `http://datto-rmm-mcp:8080` |
| `VENDOR_URL_ITGLUE` | `http://itglue-mcp:8080` |
| `VENDOR_URL_AUTOTASK` | `http://autotask-mcp:8080` |
| ... | (one per vendor) |

## Terraform Variables

Key variables in `infrastructure/azure/variables.tf`:

### Basic

```hcl
variable "name"     { default = "mcp-gateway" }  # Resource name prefix
variable "location" { default = "eastus" }        # Azure region
```

### Container Apps

```hcl
variable "registry_cpu"    { default = 1.0 }    # CPU cores
variable "registry_memory" { default = "2Gi" }   # Memory
variable "min_replicas"    { default = 1 }
variable "max_replicas"    { default = 10 }
```

### PostgreSQL

```hcl
variable "postgres_sku_name"       { default = "B_Standard_B1ms" }
variable "postgres_storage_mb"     { default = 32768 }  # 32GB
variable "postgres_version"        { default = "16" }
variable "postgres_admin_username" { default = "mcpadmin" }
```

### Networking

```hcl
variable "vnet_address_space"           { default = ["10.0.0.0/16"] }
variable "container_apps_subnet_cidr"   { default = "10.0.0.0/23" }
variable "database_subnet_cidr"         { default = "10.0.2.0/24" }
variable "redis_subnet_cidr"            { default = "10.0.3.0/24" }
variable "private_endpoints_subnet_cidr" { default = "10.0.4.0/24" }
```

### Security

```hcl
variable "secret_key"             {}  # JWT signing key (auto-generated if empty)
variable "credential_master_key"  {}  # AES encryption key (auto-generated if empty)
```

### Custom Domain

```hcl
variable "custom_domain"                { default = "" }   # e.g., "mcp.wyre.ai"
variable "custom_domain_certificate_id" { default = "" }
```

## Deployment Steps

### 1. Initialize Terraform

```bash
cd infrastructure/azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
terraform init
```

### 2. Plan and Apply Infrastructure

```bash
terraform plan -out=plan.tfplan
terraform apply plan.tfplan
```

This provisions the resource group, networking, ACR, PostgreSQL, Key Vault, Redis, Container Apps Environment, and monitoring.

### 3. Build and Push Container Images

```bash
# Gateway
docker build -t <acr-name>.azurecr.io/mcp-gateway:latest .
docker push <acr-name>.azurecr.io/mcp-gateway:latest

# Vendor containers (example)
docker pull ghcr.io/wyre-technology/datto-rmm-mcp:latest
docker tag ghcr.io/wyre-technology/datto-rmm-mcp:latest <acr-name>.azurecr.io/datto-rmm-mcp:latest
docker push <acr-name>.azurecr.io/datto-rmm-mcp:latest
```

### 4. Configure Secrets in Key Vault

```bash
az keyvault secret set --vault-name <vault-name> --name master-key --value <64-hex-chars>
az keyvault secret set --vault-name <vault-name> --name jwt-secret --value <64-hex-chars>
az keyvault secret set --vault-name <vault-name> --name auth0-client-secret --value <secret>
az keyvault secret set --vault-name <vault-name> --name stripe-secret-key --value <secret>
```

### 5. Deploy Container Apps

The Terraform configuration creates Container App resources. To force a new revision after pushing a new image:

```bash
az containerapp update \
  --name mcp-gateway-registry \
  --resource-group mcp-gateway-rg \
  --set-env-vars "DEPLOY_SHA=$(date +%s)"
```

Note: Setting an env var to a new value forces a new revision. The env var change alone does not trigger a rebuild -- CI must push the image first.

### 6. Configure Custom Domain (Optional)

```bash
az containerapp hostname add \
  --name mcp-gateway-registry \
  --resource-group mcp-gateway-rg \
  --hostname mcp.wyre.ai
```

Then configure DNS and SSL certificate validation.

## Database Provisioning

The gateway auto-creates all required tables on startup via `initTables()` calls:

- `credentials` -- encrypted user credentials
- `org_credentials` -- encrypted org-level credentials
- `org_team_credentials` -- encrypted team-level credentials
- `service_client_credentials` -- encrypted service client credentials
- `oauth_sessions`, `auth_codes`, `refresh_tokens` -- OAuth state
- `orgs`, `org_members`, `org_invitations` -- organization management
- `org_teams`, `org_team_members` -- team management
- `org_server_access`, `org_team_server_access` -- server access grants
- `org_tool_allowlists` -- RBAC tool allowlists
- `org_service_clients` -- M2M service clients
- `request_log` -- audit trail
- `admin_audit_log` -- administrative actions
- `users` -- user profiles
- `waitlist` -- pre-launch signups
- `log_shipping_destinations` -- SIEM integration config

No manual migration scripts needed. Tables are created with `IF NOT EXISTS`.

## Container Registry Setup

### GitHub Container Registry (Development)

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
docker push ghcr.io/wyre-technology/<image>:latest
```

### Azure Container Registry (Production)

```bash
az acr login --name <acr-name>
docker push <acr-name>.azurecr.io/<image>:latest
```

The Container Apps use a User Assigned Identity for ACR pull authentication -- no password-based login needed at runtime.

## Key Networking Notes

- **Egress IP vs. Ingress IP**: The ACA environment's `staticIp` is for inbound traffic. Outbound requests (e.g., to Autotask API) use a different egress IP found in `properties.outboundIpAddresses`. When whitelisting with vendor APIs, use the egress IP.

- **Container-to-container communication**: All vendor containers in the same ACA environment communicate over the internal network. The gateway references them by service name (e.g., `http://datto-rmm-mcp:8080`).

## Local Development

```bash
# Start all services
docker compose up -d

# Start gateway in dev mode (hot reload)
npm run dev

# Run tests
npm test
```

The gateway connects to `postgres://gateway:gateway@localhost:5432/gateway` by default in local development.
