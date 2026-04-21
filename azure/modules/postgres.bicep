// PostgreSQL Flexible Server module
//
// Deploys a Flexible Server + single database + firewall rule allowing
// Azure services (Container Apps) to connect.

@description('Azure region')
param location string

@description('Flexible server name')
param serverName string

@description('Database name')
param dbName string = 'gateway'

@description('Administrator login')
param adminUser string = 'gatewayadmin'

@secure()
@description('Administrator password')
param adminPassword string

@description('SKU name (e.g. Standard_B1ms)')
param skuName string = 'Standard_B1ms'

@description('SKU tier (Burstable or GeneralPurpose)')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string = 'Burstable'

@description('Storage size in GB')
param storageSizeGB int = 32

@description('PostgreSQL major version')
param pgVersion string = '16'

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: pgVersion
    administratorLogin: adminUser
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource pgDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: pgServer
  name: dbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output serverName string = pgServer.name
output fqdn string = pgServer.properties.fullyQualifiedDomainName
output databaseName string = pgDatabase.name
output adminUser string = adminUser
