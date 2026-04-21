// Identity / role assignment module
//
// Grants the gateway's system-assigned managed identity the
// "Key Vault Secrets User" role so it can resolve secretRef URIs.
//
// NOTE: Deploying this requires the deploying principal to have
// "User Access Administrator" or "Owner" on the resource group.
// Set deployRoleAssignment=false on the parent to skip when it already exists.

@description('Key Vault resource ID (scope for role assignment)')
param keyVaultId string

@description('Key Vault name (used to resolve existing resource for scope)')
param keyVaultName string

@description('Principal ID of the gateway managed identity')
param principalId string

@description('Whether to actually deploy the role assignment')
param deployRoleAssignment bool = false

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignment) {
  name: guid(keyVaultId, principalId, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
