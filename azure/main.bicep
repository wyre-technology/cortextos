// MCP Gateway — Azure Container Apps infrastructure (orchestrator)
//
// This file is intentionally thin: it wires together modules under ./modules/.
// Parameter names are preserved from the pre-modularization shape so existing
// deploy workflows (./.github/workflows/deploy.yml) keep working unchanged.
//
// Modules:
//   - modules/keyvault.bicep       Key Vault (Auth0 / Stripe secrets)
//   - modules/identity.bicep       Role assignment for gateway -> KV
//   - modules/postgres.bicep       PostgreSQL Flexible Server + DB + firewall
//   - modules/gateway-app.bicep    Container Apps Env + gateway app
//   - modules/vendor-app.bicep     Per-vendor MCP server container apps
//   - modules/observability.bicep  Log Analytics, action group, alerts

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters (names preserved — do not rename)
// ---------------------------------------------------------------------------

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Environment name suffix')
@allowed(['prod', 'staging', 'dev'])
param env string = 'prod'

@description('Resource name prefix (overrides default mcpgw-{env})')
param namePrefix string = ''

@description('Key Vault name override (KV names are globally unique)')
param kvName string = ''

@description('Gateway Docker image')
param gatewayImage string = 'ghcr.io/wyre-technology/mcp-gateway:latest'

@description('Unique value to force a new revision on docs-only deploys (e.g. Unix timestamp)')
param redeployTrigger string = ''

@secure()
@description('Master encryption key (64 hex chars)')
param masterKey string

@secure()
@description('JWT signing secret (64 hex chars)')
param jwtSecret string

@secure()
@description('PostgreSQL admin password')
param pgPassword string

@secure()
@description('GitHub Container Registry PAT with read:packages scope')
param ghcrToken string

@secure()
@description('Microsoft Entra app client ID for M365 OAuth (optional)')
param microsoftClientId string = ''

@secure()
@description('Microsoft Entra app client secret for M365 OAuth (optional)')
param microsoftClientSecret string = ''

@description('Public hostname for the gateway')
param customDomain string = ''

@description('Managed certificate name in the Container Apps environment')
param managedCertName string = 'mc-mcpgw-prod-env-mcp-wyretechnolo-7568'

@description('Email address for alert notifications')
param alertEmail string = ''

@description('Whether to deploy the Key Vault role assignment (set false if it already exists)')
param deployRoleAssignment bool = false

@description('MCP server vendors to deploy')
param vendors array = [
  { slug: 'datto-rmm', image: 'ghcr.io/wyre-technology/datto-rmm-mcp:latest' }
  { slug: 'itglue', image: 'ghcr.io/wyre-technology/itglue-mcp:latest' }
  { slug: 'autotask', image: 'ghcr.io/wyre-technology/autotask-mcp:latest' }
  { slug: 'syncro', image: 'ghcr.io/wyre-technology/syncro-mcp:latest' }
  { slug: 'atera', image: 'ghcr.io/wyre-technology/atera-mcp:latest' }
  { slug: 'superops', image: 'ghcr.io/wyre-technology/superops-mcp:latest' }
  { slug: 'liongard', image: 'ghcr.io/wyre-technology/liongard-mcp:latest' }
  { slug: 'halopsa', image: 'ghcr.io/wyre-technology/halopsa-mcp:latest' }
  { slug: 'ninjaone', image: 'ghcr.io/wyre-technology/ninjaone-mcp:latest' }
  { slug: 'connectwise-automate', image: 'ghcr.io/wyre-technology/connectwise-automate-mcp:latest' }
  { slug: 'connectwise-manage', image: 'ghcr.io/wyre-technology/connectwise-manage-mcp:latest' }
  { slug: 'salesbuildr', image: 'ghcr.io/wyre-technology/salesbuildr-mcp:latest' }
  { slug: 'hudu', image: 'ghcr.io/wyre-technology/hudu-mcp:latest' }
  { slug: 'rocketcyber', image: 'ghcr.io/wyre-technology/rocketcyber-mcp:latest' }
  { slug: 'm365', image: 'ghcr.io/wyre-technology/m365-mcp:latest' }
]

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

var prefix = empty(namePrefix) ? 'mcpgw-${env}' : namePrefix
var pgServerName = '${prefix}-pg'
var pgDbName = 'gateway'
var pgUser = 'gatewayadmin'
var resolvedKvName = empty(kvName) ? '${prefix}-kv' : kvName

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

module keyvault './modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    name: resolvedKvName
  }
}

module observability './modules/observability.bicep' = {
  name: 'observability'
  params: {
    location: location
    prefix: prefix
    alertEmail: alertEmail
    gatewayId: gatewayApp.outputs.gatewayId
  }
}

module postgres './modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    serverName: pgServerName
    dbName: pgDbName
    adminUser: pgUser
    adminPassword: pgPassword
  }
}

module gatewayApp './modules/gateway-app.bicep' = {
  name: 'gateway-app'
  params: {
    location: location
    prefix: prefix
    logAnalyticsWorkspaceId: observability.outputs.workspaceId
    logAnalyticsCustomerId: observability.outputs.customerId
    logAnalyticsSharedKey: observability.outputs.primarySharedKey
    keyVaultUri: keyvault.outputs.vaultUri
    gatewayImage: gatewayImage
    customDomain: customDomain
    managedCertName: managedCertName
    redeployTrigger: redeployTrigger
    masterKey: masterKey
    jwtSecret: jwtSecret
    ghcrToken: ghcrToken
    microsoftClientId: microsoftClientId
    microsoftClientSecret: microsoftClientSecret
    pgFqdn: postgres.outputs.fqdn
    pgUser: postgres.outputs.adminUser
    pgPassword: pgPassword
    pgDbName: postgres.outputs.databaseName
    vendors: vendors
  }
}

module identity './modules/identity.bicep' = {
  name: 'identity'
  params: {
    keyVaultId: keyvault.outputs.id
    keyVaultName: keyvault.outputs.name
    principalId: gatewayApp.outputs.gatewayPrincipalId
    deployRoleAssignment: deployRoleAssignment
  }
}

module vendorApps './modules/vendor-app.bicep' = {
  name: 'vendor-apps'
  params: {
    location: location
    prefix: prefix
    containerEnvId: gatewayApp.outputs.containerEnvId
    ghcrToken: ghcrToken
    vendors: vendors
  }
}

// ---------------------------------------------------------------------------
// Outputs (preserved from pre-modularization shape)
// ---------------------------------------------------------------------------

output gatewayFqdn string = gatewayApp.outputs.gatewayFqdn
output gatewayUrl string = 'https://${customDomain}'
output pgFqdn string = postgres.outputs.fqdn
output keyVaultUri string = keyvault.outputs.vaultUri
output mcpServerNames array = vendorApps.outputs.mcpServerNames
