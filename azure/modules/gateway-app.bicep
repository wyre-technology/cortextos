// Gateway Container App + managed environment
//
// Deploys the shared Container Apps Environment (used by vendor apps too)
// and the public-ingress gateway app with system-assigned identity.
//
// The secrets block includes Key Vault references for Auth0, Stripe, and
// alpha invite codes. Those secret *names* (auth0-domain, auth0-client-id,
// auth0-client-secret, stripe-*, alpha-invite-codes) are load-bearing —
// the env vars below reference them via secretRef and runtime config
// depends on their exact spelling.

@description('Azure region')
param location string

@description('Resource name prefix (e.g. mcpgw-prod)')
param prefix string

@description('Log Analytics workspace resource ID')
param logAnalyticsWorkspaceId string

@description('Log Analytics customer / workspace ID (GUID)')
param logAnalyticsCustomerId string

@secure()
@description('Log Analytics primary shared key')
param logAnalyticsSharedKey string

@description('Key Vault URI (https://<vault>.vault.azure.net/)')
param keyVaultUri string

@description('Gateway container image')
param gatewayImage string

@description('Public custom domain (empty to use default)')
param customDomain string = ''

@description('Managed certificate name in the environment')
param managedCertName string

@description('Redeploy trigger value (forces new revision)')
param redeployTrigger string = ''

@secure()
param masterKey string

@secure()
param jwtSecret string

@secure()
param ghcrToken string

@secure()
param microsoftClientId string = ''

@secure()
param microsoftClientSecret string = ''

@description('PostgreSQL FQDN')
param pgFqdn string

@description('PostgreSQL admin user')
param pgUser string

@secure()
@description('PostgreSQL admin password (used to compose DATABASE_URL secret)')
param pgPassword string

@description('PostgreSQL database name')
param pgDbName string

@description('Vendor definitions; used to emit VENDOR_URL_* env vars')
param vendors array

var vendorEnvVars = [for vendor in vendors: {
  name: 'VENDOR_URL_${replace(toUpper(vendor.slug), '-', '_')}'
  value: 'http://${prefix}-${vendor.slug}'
}]

// Shared Container Apps Environment
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

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
        customDomains: empty(customDomain) ? [] : [
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
        { name: 'database-url', value: 'postgres://${pgUser}:${pgPassword}@${pgFqdn}:5432/${pgDbName}?sslmode=require' }
        { name: 'ghcr-token', value: ghcrToken }
        {
          name: 'auth0-domain'
          keyVaultUrl: '${keyVaultUri}secrets/auth0-domain'
          identity: 'system'
        }
        {
          name: 'auth0-client-id'
          keyVaultUrl: '${keyVaultUri}secrets/auth0-client-id'
          identity: 'system'
        }
        {
          name: 'auth0-client-secret'
          keyVaultUrl: '${keyVaultUri}secrets/auth0-client-secret'
          identity: 'system'
        }
        {
          name: 'stripe-secret-key'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-secret-key'
          identity: 'system'
        }
        {
          name: 'stripe-webhook-secret'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-webhook-secret'
          identity: 'system'
        }
        {
          name: 'stripe-pro-price-id'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-pro-price-id'
          identity: 'system'
        }
        {
          name: 'alpha-invite-codes'
          keyVaultUrl: '${keyVaultUri}secrets/alpha-invite-codes'
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
            { name: 'BASE_URL', value: empty(customDomain) ? 'https://${prefix}-gateway.${containerEnv.properties.defaultDomain}' : 'https://${customDomain}' }
            { name: 'MASTER_KEY', secretRef: 'master-key' }
            { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'AUTH0_DOMAIN', secretRef: 'auth0-domain' }
            { name: 'AUTH0_CLIENT_ID', secretRef: 'auth0-client-id' }
            { name: 'AUTH0_CLIENT_SECRET', secretRef: 'auth0-client-secret' }
            { name: 'AUTH0_CALLBACK_URL', value: empty(customDomain) ? 'https://${prefix}-gateway.${containerEnv.properties.defaultDomain}/auth/callback' : 'https://${customDomain}/auth/callback' }
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

// logAnalyticsWorkspaceId is accepted for symmetry with observability linkage;
// reference it to silence unused-parameter warnings in strict lints.
output _logAnalyticsWorkspaceId string = logAnalyticsWorkspaceId

output containerEnvId string = containerEnv.id
output gatewayId string = gateway.id
output gatewayName string = gateway.name
output gatewayFqdn string = gateway.properties.configuration.ingress.fqdn
output gatewayPrincipalId string = gateway.identity.principalId
