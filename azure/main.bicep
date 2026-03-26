// MCP Gateway — Azure Container Apps infrastructure
//
// Deploys:
//   - Key Vault (Auth0 secrets)
//   - Log Analytics workspace
//   - Container Apps Environment
//   - PostgreSQL Flexible Server
//   - Gateway container app (public HTTPS ingress, system-assigned identity)
//   - MCP server container apps (internal only, AUTH_MODE=gateway)

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Environment name suffix')
@allowed(['prod', 'staging', 'dev'])
param env string = 'prod'

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
@description('Microsoft Entra app client ID for M365 OAuth (optional until M365 OAuth is configured)')
param microsoftClientId string = ''

@secure()
@description('Microsoft Entra app client secret for M365 OAuth (optional until M365 OAuth is configured)')
param microsoftClientSecret string = ''

@description('Public hostname for the gateway')
param customDomain string = ''

@description('Managed certificate name in the Container Apps environment')
param managedCertName string = 'mc-mcpgw-prod-env-mcp-wyretechnolo-7568'

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

var prefix = 'mcpgw-${env}'
var pgServerName = '${prefix}-pg'
var pgDbName = 'gateway'
var pgUser = 'gatewayadmin'

var vendorEnvVars = [for vendor in vendors: {
  name: 'VENDOR_URL_${replace(toUpper(vendor.slug), '-', '_')}'
  value: 'http://${prefix}-${vendor.slug}'
}]

// ---------------------------------------------------------------------------
// Key Vault (Auth0 secrets stored out-of-band via CLI / portal)
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}-kv'
  location: location
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    sku: { family: 'A', name: 'standard' }
  }
}

// Grant the gateway's managed identity "Key Vault Secrets User" (4633458b-...)
// NOTE: This requires the deploying principal to have "User Access Administrator"
// or "Owner" role on the resource group. Set deployRoleAssignment=false to skip
// if the assignment already exists from a prior deployment.
@description('Whether to deploy the Key Vault role assignment (set false if it already exists)')
param deployRoleAssignment bool = false

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignment) {
  name: guid(keyVault.id, gateway.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Log Analytics
// ---------------------------------------------------------------------------

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// Container Apps Environment
// ---------------------------------------------------------------------------

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server
// ---------------------------------------------------------------------------

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: pgServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: pgUser
    administratorLoginPassword: pgPassword
    storage: {
      storageSizeGB: 32
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
  name: pgDbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure services (Container Apps) to connect
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---------------------------------------------------------------------------
// Gateway container app (public ingress)
// ---------------------------------------------------------------------------

resource gateway 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-gateway'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
        customDomains: [
          {
            name: customDomain
            certificateId: '${containerEnv.id}/managedCertificates/${managedCertName}'
            bindingType: 'SniEnabled'
          }
        ]
      }
      registries: [
        {
          server: 'ghcr.io'
          username: 'wyre-technology'
          passwordSecretRef: 'ghcr-token'
        }
      ]
      secrets: [
        { name: 'master-key', value: masterKey }
        { name: 'jwt-secret', value: jwtSecret }
        { name: 'database-url', value: 'postgres://${pgUser}:${pgPassword}@${pgServer.properties.fullyQualifiedDomainName}:5432/${pgDbName}?sslmode=require' }
        { name: 'ghcr-token', value: ghcrToken }
        {
          name: 'auth0-domain'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/auth0-domain'
          identity: 'system'
        }
        {
          name: 'auth0-client-id'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/auth0-client-id'
          identity: 'system'
        }
        {
          name: 'auth0-client-secret'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/auth0-client-secret'
          identity: 'system'
        }
        {
          name: 'stripe-secret-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/stripe-secret-key'
          identity: 'system'
        }
        {
          name: 'stripe-webhook-secret'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/stripe-webhook-secret'
          identity: 'system'
        }
        {
          name: 'stripe-pro-price-id'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/stripe-pro-price-id'
          identity: 'system'
        }
        {
          name: 'alpha-invite-codes'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/alpha-invite-codes'
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: gatewayImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat([
            { name: 'PORT', value: '8080' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'BASE_URL', value: 'https://${customDomain}' }
            { name: 'MASTER_KEY', secretRef: 'master-key' }
            { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'AUTH0_DOMAIN', secretRef: 'auth0-domain' }
            { name: 'AUTH0_CLIENT_ID', secretRef: 'auth0-client-id' }
            { name: 'AUTH0_CLIENT_SECRET', secretRef: 'auth0-client-secret' }
            { name: 'AUTH0_CALLBACK_URL', value: 'https://${customDomain}/auth/callback' }
            { name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key' }
            { name: 'STRIPE_WEBHOOK_SECRET', secretRef: 'stripe-webhook-secret' }
            { name: 'STRIPE_PRO_PRICE_ID', secretRef: 'stripe-pro-price-id' }
            { name: 'ALPHA_INVITE_CODES', secretRef: 'alpha-invite-codes' }
            { name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }
            { name: 'MICROSOFT_CLIENT_SECRET', value: microsoftClientSecret }
            { name: 'REDEPLOY_TRIGGER', value: redeployTrigger }
          ], vendorEnvVars)
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MCP server container apps (internal only)
// ---------------------------------------------------------------------------

resource mcpServers 'Microsoft.App/containerApps@2024-03-01' = [
  for vendor in vendors: {
    name: '${prefix}-${vendor.slug}'
    location: location
    properties: {
      managedEnvironmentId: containerEnv.id
      configuration: {
        ingress: {
          external: false
          targetPort: 8080
          transport: 'http'
        }
        registries: [
          {
            server: 'ghcr.io'
            username: 'wyre-technology'
            passwordSecretRef: 'ghcr-token'
          }
        ]
        secrets: [
          { name: 'ghcr-token', value: ghcrToken }
        ]
      }
      template: {
        containers: [
          {
            name: vendor.slug
            image: vendor.image
            resources: {
              cpu: json('0.25')
              memory: '0.5Gi'
            }
            env: [
              { name: 'AUTH_MODE', value: 'gateway' }
              { name: 'PORT', value: '8080' }
            ]
            probes: [
              {
                type: 'Liveness'
                httpGet: { path: '/health', port: 8080 }
                initialDelaySeconds: 10
                periodSeconds: 30
              }
            ]
          }
        ]
        scale: {
          minReplicas: 1
          maxReplicas: 1
        }
      }
    }
  }
]

// ---------------------------------------------------------------------------
// Monitoring — Action Group
// ---------------------------------------------------------------------------

@description('Email address for alert notifications')
param alertEmail string = ''

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-alerts'
  location: 'global'
  properties: {
    groupShortName: 'mcpgw-eng'
    enabled: true
    emailReceivers: [
      {
        name: 'Engineering'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Gateway container restarts (> 2 in 5 min)
// ---------------------------------------------------------------------------

resource alertGatewayRestarts 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-gateway-restarts'
  location: 'global'
  properties: {
    description: 'Gateway container restarted more than 2 times in 5 minutes'
    severity: 1
    enabled: true
    scopes: [gateway.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'RestartCount'
          metricName: 'RestartCount'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 2
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — 5xx error rate (> 5% of requests over 5 min)
// ---------------------------------------------------------------------------

resource alertGateway5xx 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-gateway-5xx-rate'
  location: location
  properties: {
    description: 'More than 5% of gateway requests returned 5xx over 5 minutes'
    severity: 1
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":5' or Log_s has '"res":{"statusCode":5'
            | summarize errors = count() by bin(TimeGenerated, 5m)
            | where errors > 10
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Health endpoint failures (from system logs)
// ---------------------------------------------------------------------------

resource alertHealthFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-health-failures'
  location: location
  properties: {
    description: 'Gateway health probe failed 3+ times in 5 minutes — possible outage'
    severity: 0
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Reason_s == 'Unhealthy' or Reason_s == 'FailedHealthCheck'
            | summarize failures = count() by bin(TimeGenerated, 5m)
            | where failures >= 3
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — PostgreSQL connection failures
// ---------------------------------------------------------------------------

resource alertDbConnectivity 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-db-connectivity'
  location: location
  properties: {
    description: 'PostgreSQL connection errors detected in gateway logs'
    severity: 1
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has 'ECONNREFUSED' or Log_s has 'connection terminated' or Log_s has 'connect_timeout' or Log_s has 'too many connections'
            | summarize errors = count() by bin(TimeGenerated, 5m)
            | where errors >= 3
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — High response latency (P95 > 5s)
// ---------------------------------------------------------------------------

resource alertHighLatency 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-high-latency'
  location: location
  properties: {
    description: 'Gateway P95 response time exceeded 5 seconds over 5 minutes'
    severity: 2
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"responseTime"'
            | extend parsed = parse_json(Log_s)
            | extend responseTime = todouble(parsed.responseTime)
            | where isnotnull(responseTime)
            | summarize p95 = percentile(responseTime, 95) by bin(TimeGenerated, 5m)
            | where p95 > 5000
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — MCP server container restarts (any vendor)
// ---------------------------------------------------------------------------

resource alertMcpServerRestarts 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-mcp-server-restarts'
  location: location
  properties: {
    description: 'An MCP vendor server container restarted more than 2 times in 5 minutes'
    severity: 2
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s startswith '${prefix}-' and ContainerAppName_s != '${prefix}-gateway'
            | where Reason_s == 'BackOff' or Reason_s == 'CrashLoopBackOff' or Reason_s has 'restart'
            | summarize restarts = count() by ContainerAppName_s, bin(TimeGenerated, 5m)
            | where restarts > 2
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Rate limit exhaustion (> 50 429s in 1hr)
// ---------------------------------------------------------------------------

resource alertRateLimits 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-rate-limit-exhaustion'
  location: location
  properties: {
    description: 'More than 50 rate-limited (429) responses in 1 hour — possible abuse or undersized limits'
    severity: 2
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":429' or Log_s has '"res":{"statusCode":429'
            | summarize count429 = count()
            | where count429 > 50
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Auth failure spike (> 20 401/403 in 5 min)
// ---------------------------------------------------------------------------

resource alertAuthFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-auth-failures'
  location: location
  properties: {
    description: 'More than 20 authentication failures (401/403) in 5 minutes — possible attack or misconfigured client'
    severity: 2
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":401' or Log_s has '"statusCode":403'
              or Log_s has '"res":{"statusCode":401' or Log_s has '"res":{"statusCode":403'
            | summarize authFailures = count() by bin(TimeGenerated, 5m)
            | where authFailures > 20
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output gatewayFqdn string = gateway.properties.configuration.ingress.fqdn
output gatewayUrl string = 'https://${customDomain}'
output pgFqdn string = pgServer.properties.fullyQualifiedDomainName
output keyVaultUri string = keyVault.properties.vaultUri
output mcpServerNames array = [for (vendor, i) in vendors: mcpServers[i].name]
