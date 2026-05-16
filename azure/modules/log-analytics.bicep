// Log Analytics workspace — dependency-free module.
//
// Previously the workspace was declared inside observability.bicep, which also
// defines alerts scoped to the gateway container app. That produced a module
// cycle: gateway-app.bicep consumes the workspace (customerId / sharedKey for
// appLogsConfiguration), while observability.bicep consumes the gateway's
// resource id (restart metric alert scope). Bicep rejected it (BCP080).
//
// Extracting the workspace gives a single-direction graph:
//   log-analytics  ->  gateway-app  ->  observability
//
// The resource name, API version, SKU and retention are kept identical to the
// previous declaration so this is a no-op against the live workspace.

@description('Azure region')
param location string

@description('Resource name prefix (e.g. mcpgw-prod)')
param prefix string

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

output workspaceId string = logAnalytics.id
output workspaceName string = logAnalytics.name
output customerId string = logAnalytics.properties.customerId
#disable-next-line outputs-should-not-contain-secrets
output primarySharedKey string = logAnalytics.listKeys().primarySharedKey
