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
//   - modules/log-analytics.bicep  Log Analytics workspace (no dependencies)
//   - modules/gateway-app.bicep    Container Apps Env + gateway app
//   - modules/observability.bicep  Action group + alert rules
//
// The conduit Bicep does not own the vendor MCP fleet. Vendor container apps
// (gwp-*) are deployed by their own per-vendor release pipelines; the gateway's
// VENDOR_URL_* env is preserved across deploys via existingVendorEnv.

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

@description('Managed environment name override. Defaults to {prefix}-env; set to match an environment provisioned out-of-band (e.g. mcpgw-prod-env-v2).')
param containerEnvName string = ''

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

@description('Comma-separated host allowlist for the gateway')
param allowedHosts string = ''

@description('Comma-separated admin email addresses')
param adminEmails string = ''

@description('Thread (Microsoft Teams) application ID')
param threadAppId string = ''

@description('Comma-separated Entra tenant IDs trusted for admin access')
param entraTrustedTenantIds string = ''

@description('Public hostname for the gateway')
param customDomain string = ''

@description('Managed certificate name in the Container Apps environment')
param managedCertName string = 'mc-mcpgw-prod-env-mcp-wyretechnolo-7568'

@description('Email address for alert notifications')
param alertEmail string = ''

@secure()
@description('Rootly Azure Monitor webhook URL (contains a secret query param). Supplied at deploy time from Key Vault secret rootly-azuremonitor-webhook-url — never a literal in git.')
param rootlyWebhookUrl string = ''

@description('Resource-group monthly cost budget in USD')
param monthlyBudget int = 1200

@description('Whether to deploy the Key Vault role assignment (set false if it already exists)')
param deployRoleAssignment bool = false

// The conduit Bicep does not own the vendor fleet. Vendor MCP container apps
// (gwp-*) are deployed by their own per-vendor release pipelines, and the
// gateway's VENDOR_URL_* env vars are wired to them. The deploy workflow reads
// the live VENDOR_URL_* set off the gateway and passes it through as
// existingVendorEnv so a deploy preserves it.
@description('Existing custom-domain bindings, read off the live gateway by the deploy workflow and passed through to preserve them.')
param existingCustomDomains array = []

@description('Existing VENDOR_URL_* env vars, read off the live gateway by the deploy workflow and passed through to preserve them.')
param existingVendorEnv array = []

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

module logAnalytics './modules/log-analytics.bicep' = {
  name: 'log-analytics'
  params: {
    location: location
    prefix: prefix
  }
}

module observability './modules/observability.bicep' = {
  name: 'observability'
  params: {
    location: location
    prefix: prefix
    alertEmail: alertEmail
    gatewayId: gatewayApp.outputs.gatewayId
    workspaceId: logAnalytics.outputs.workspaceId
    rootlyWebhookUrl: rootlyWebhookUrl
    monthlyBudget: monthlyBudget
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
    containerEnvName: containerEnvName
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    logAnalyticsCustomerId: logAnalytics.outputs.customerId
    logAnalyticsSharedKey: logAnalytics.outputs.primarySharedKey
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
    allowedHosts: allowedHosts
    adminEmails: adminEmails
    threadAppId: threadAppId
    entraTrustedTenantIds: entraTrustedTenantIds
    pgFqdn: postgres.outputs.fqdn
    pgUser: postgres.outputs.adminUser
    pgPassword: pgPassword
    pgDbName: postgres.outputs.databaseName
    existingCustomDomains: existingCustomDomains
    existingVendorEnv: existingVendorEnv
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

// ---------------------------------------------------------------------------
// Outputs (preserved from pre-modularization shape)
// ---------------------------------------------------------------------------

output gatewayFqdn string = gatewayApp.outputs.gatewayFqdn
output gatewayUrl string = 'https://${customDomain}'
output pgFqdn string = postgres.outputs.fqdn
output keyVaultUri string = keyvault.outputs.vaultUri
