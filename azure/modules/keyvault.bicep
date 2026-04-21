// Key Vault module
//
// Hosts Auth0, Stripe, and other secrets referenced by the gateway container app.
// Secret *values* are provisioned out-of-band (CLI / portal) — this module only
// creates the vault. The gateway app references secret URIs at deploy time.

@description('Azure region')
param location string

@description('Key Vault name')
param name string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    sku: { family: 'A', name: 'standard' }
  }
}

output id string = keyVault.id
output name string = keyVault.name
output vaultUri string = keyVault.properties.vaultUri
