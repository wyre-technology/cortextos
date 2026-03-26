# MCP Gateway - Azure Container Apps Deployment

This directory contains Terraform configuration for deploying the MCP Gateway Registry to Azure Container Apps.

## Architecture Overview

```
                                    Internet
                                        |
                                        v
                            +-------------------+
                            |  Azure Front Door |
                            |   (optional CDN)  |
                            +-------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
|                           Azure Container Apps Environment                         |
|  +---------------------------+    +---------------------------+                    |
|  |   Registry Container App  |    |  Auth Server Container    |                    |
|  |   - MCP Gateway Registry  |    |  - OAuth/Entra Auth       |                    |
|  |   - nginx reverse proxy   |    |  - JWT token service      |                    |
|  |   - Port 80/443           |    |  - Port 8888              |                    |
|  +---------------------------+    +---------------------------+                    |
+-----------------------------------------------------------------------------------+
                    |                           |
                    v                           v
    +---------------------------+   +---------------------------+
    |   Azure PostgreSQL        |   |   Azure Cache for Redis   |
    |   Flexible Server         |   |   - Rate limiting         |
    |   - Session storage       |   |   - Caching               |
    |   - Credential storage    |   |                           |
    +---------------------------+   +---------------------------+
                    |
                    v
    +---------------------------+
    |   Azure Key Vault         |
    |   - Secrets management    |
    |   - Connection strings    |
    |   - API keys              |
    +---------------------------+
```

## Prerequisites

1. **Azure CLI** installed and configured
2. **Terraform** >= 1.5.0
3. **Azure subscription** with appropriate permissions
4. **Service Principal** or Azure CLI authentication

### Required Azure Permissions

- Contributor role on the subscription or resource group
- Key Vault access policies
- Container Registry permissions

## Quick Start

### 1. Initialize Terraform

```bash
cd infrastructure/azure
terraform init
```

### 2. Create Configuration

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
```

### 3. Set Sensitive Variables

Set sensitive variables via environment:

```bash
export TF_VAR_postgres_admin_password="your-secure-db-password"
export TF_VAR_admin_password="your-secure-admin-password"
export TF_VAR_secret_key="your-64-char-secret-key"
export TF_VAR_entra_client_secret="your-entra-client-secret"
```

### 4. Plan and Apply

```bash
# Validate configuration
terraform validate

# Plan deployment
terraform plan -out=tfplan

# Apply deployment
terraform apply tfplan
```

## Configuration

### Basic Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `name` | Deployment name prefix | `mcp-gateway` |
| `location` | Azure region | `eastus` |
| `tags` | Resource tags | See example |

### Container Apps

| Variable | Description | Default |
|----------|-------------|---------|
| `registry_cpu` | CPU cores for registry | `1.0` |
| `registry_memory` | Memory for registry | `2Gi` |
| `min_replicas` | Minimum replicas | `1` |
| `max_replicas` | Maximum replicas | `10` |

### Database

| Variable | Description | Default |
|----------|-------------|---------|
| `postgres_sku_name` | PostgreSQL SKU | `B_Standard_B1ms` |
| `postgres_storage_mb` | Storage in MB | `32768` |
| `postgres_version` | PostgreSQL version | `16` |

### Authentication

The deployment supports Microsoft Entra ID (Azure AD) for authentication:

```hcl
auth_provider = "entra"
entra_tenant_id = "your-tenant-id"
entra_client_id = "your-client-id"
```

## Custom Domain Setup

To use a custom domain (e.g., `mcp.wyre.ai`):

### 1. Configure DNS

Add a CNAME record pointing to the Container App FQDN:

```
mcp.wyre.ai -> your-container-app.azurecontainerapps.io
```

### 2. Update Configuration

```hcl
custom_domain = "mcp.wyre.ai"
session_cookie_domain = ".wyre.ai"
```

### 3. Managed Certificate

Azure Container Apps can automatically provision and manage SSL certificates for custom domains.

## Outputs

After deployment, the following outputs are available:

```bash
# Get all outputs
terraform output

# Specific outputs
terraform output registry_url
terraform output acr_login_server
terraform output deployment_commands
```

### Key Outputs

| Output | Description |
|--------|-------------|
| `registry_url` | Full URL of the MCP Gateway |
| `acr_login_server` | Container Registry login server |
| `postgres_server_fqdn` | PostgreSQL server FQDN |
| `key_vault_uri` | Key Vault URI for secrets |

## Deploying Container Images

### Initial Image Push

After infrastructure is created, push your container images:

```bash
# Login to ACR
az acr login --name $(terraform output -raw acr_name)

# Build and push registry image
docker build -t $(terraform output -raw acr_login_server)/registry:latest -f docker/Dockerfile.registry .
docker push $(terraform output -raw acr_login_server)/registry:latest

# Build and push auth server image
docker build -t $(terraform output -raw acr_login_server)/auth-server:latest -f docker/Dockerfile.auth .
docker push $(terraform output -raw acr_login_server)/auth-server:latest
```

### Update Container Images

To update the container images, push new images and restart the Container Apps:

```bash
# Push new images
docker push $(terraform output -raw acr_login_server)/registry:latest

# Restart Container App to pull new image
az containerapp revision restart \
  --name mcp-gateway-registry \
  --resource-group $(terraform output -raw resource_group_name)
```

## Monitoring

### Application Insights

Application Insights is automatically configured for monitoring. Access the dashboard via Azure Portal.

### Log Analytics

Query logs using Log Analytics:

```kusto
// Container App logs
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "mcp-gateway-registry"
| order by TimeGenerated desc
| take 100

// Request metrics
ContainerAppSystemLogs_CL
| where TimeGenerated > ago(1h)
| summarize count() by bin(TimeGenerated, 5m), Level_s
```

### Alerts

Alert rules are automatically configured for:
- Container App error rates
- PostgreSQL CPU and storage usage
- Redis memory usage
- Response time thresholds

## Security

### Network Security

- PostgreSQL is deployed in a private subnet
- Redis uses private endpoints
- Key Vault is protected with network rules
- Container Apps use VNet integration

### Secret Management

All secrets are stored in Azure Key Vault:
- Database connection strings
- API keys and tokens
- Admin credentials

### Identity

Container Apps use managed identity for:
- Key Vault access
- Container Registry pulls

## Cost Optimization

### Development Environment

For development, use:
- `postgres_sku_name = "B_Standard_B1ms"` (burstable)
- `redis_sku_name = "Basic"` with `redis_capacity = 0`
- `min_replicas = 1`, `max_replicas = 3`

### Production Environment

For production, consider:
- `postgres_sku_name = "GP_Standard_D2s_v3"` (general purpose)
- `redis_sku_name = "Standard"` or `"Premium"`
- Zone redundancy enabled
- Higher replica counts

## Troubleshooting

### Container App Not Starting

1. Check Container App logs:
```bash
az containerapp logs show \
  --name mcp-gateway-registry \
  --resource-group mcp-gateway-rg \
  --follow
```

2. Verify Key Vault access:
```bash
az keyvault secret show \
  --vault-name mcp-gateway-kv-xxx \
  --name secret-key
```

### Database Connection Issues

1. Verify network connectivity
2. Check PostgreSQL firewall rules
3. Validate connection string in Key Vault

### Redis Connection Issues

1. Check private endpoint status
2. Verify SSL/TLS configuration
3. Check Redis cache status

## Cleanup

To destroy all resources:

```bash
terraform destroy
```

**Warning**: This will delete all resources including databases and stored data.

## Related Documentation

- [Azure Container Apps Documentation](https://learn.microsoft.com/en-us/azure/container-apps/)
- [Azure Database for PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/)
- [Azure Cache for Redis](https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/)
- [Azure Key Vault](https://learn.microsoft.com/en-us/azure/key-vault/)
