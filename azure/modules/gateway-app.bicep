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

@description('Managed environment name. Defaults to {prefix}-env; override to match an environment provisioned out-of-band (e.g. mcpgw-prod-env-v2).')
param containerEnvName string = ''

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

@description('Existing custom-domain bindings on the gateway container app, passed through from the deploy workflow so they survive subsequent deploys. Each entry: {name, certificateId, bindingType}. The deploy workflow reads this via `az containerapp show ... --query properties.configuration.ingress.customDomains`. Empty on first deploy. Restores the 2ea4d56 preservation fix that regressed out of main.')
param existingCustomDomains array = []

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

@description('Comma-separated host allowlist (e.g. mcp.wyre.ai,mcp.wyretechnology.com)')
param allowedHosts string = ''

@description('Comma-separated admin email addresses')
param adminEmails string = ''

@description('Thread (Microsoft Teams) application ID')
param threadAppId string = ''

@description('Comma-separated Entra tenant IDs trusted for admin access')
param entraTrustedTenantIds string = ''

@description('PostgreSQL FQDN')
param pgFqdn string

@description('PostgreSQL admin user')
param pgUser string

@secure()
@description('PostgreSQL admin password (used to compose DATABASE_URL secret)')
param pgPassword string

@description('PostgreSQL database name')
param pgDbName string

@description('Existing VENDOR_URL_* env vars on the gateway container app, passed through from the deploy workflow so they survive subsequent deploys. The conduit Bicep does not own the vendor fleet — vendor MCP container apps (gwp-*) are deployed by per-vendor release pipelines, and the gateway is wired to them out-of-band. The deploy workflow reads the live VENDOR_URL_* env entries via `az containerapp show` and passes them through here. Empty on first deploy.')
param existingVendorEnv array = []

// Shared Container Apps Environment
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: empty(containerEnvName) ? '${prefix}-env' : containerEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
    // Mirror the live mcpgw-prod-env-v2 environment: the Consumption profile
    // plus a Dedicated-D8 workload profile. Declaring these so a deploy does
    // not strip the Dedicated profile or the peer-traffic settings.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
      {
        name: 'Dedicated-D8'
        workloadProfileType: 'D8'
        minimumCount: 1
        maximumCount: 3
      }
    ]
    peerAuthentication: {
      mtls: {
        enabled: false
      }
    }
    peerTrafficConfiguration: {
      encryption: {
        enabled: false
      }
    }
  }
}

// Container Apps Environment diagnostic setting — routes the environment metrics
// stream to Log Analytics. Console/system logs already route via the env's
// appLogsConfiguration above; this adds AllMetrics so platform metrics are
// queryable alongside the logs.
resource envDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${prefix}-env-diagnostics'
  scope: containerEnv
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
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
        // Preserve EVERY pre-existing custom-domain binding as-is — including
        // the one for `customDomain` itself. The deploy workflow reads the
        // current bindings via az CLI (name + bindingType + certificateId) and
        // passes them as existingCustomDomains; each entry's certificateId
        // already points at the correct cert, whether that is a managed cert
        // (managedCertificates/) or an uploaded one (certificates/).
        //
        // The managed-cert binding for `customDomain` is synthesized ONLY on a
        // first-ever bind — i.e. when `customDomain` is not already present in
        // existingCustomDomains. If it IS already bound, synthesizing would
        // replace the working binding with a certificateId built on an ASSUMED
        // managedCertificates/ sub-resource that need not exist (staging's env
        // carries an uploaded certificates/ cert, not a managedCertificates/
        // one) — which fails the bind and drops the domain's HTTPS.
        customDomains: concat(
          (empty(customDomain) || contains(map(existingCustomDomains, d => d.name), customDomain)) ? [] : [
            {
              name: customDomain
              certificateId: '${containerEnv.id}/managedCertificates/${managedCertName}'
              bindingType: 'SniEnabled'
            }
          ],
          existingCustomDomains
        )
      }
      registries: [
        {
          server: 'ghcr.io'
          username: 'wyre-technology'
          passwordSecretRef: 'ghcr-token'
        }
      ]
      // Order mirrors the live prod gateway's secrets array so a deploy is a
      // clean no-op. admin-api-key is KV-referenced — resolved from THIS
      // stack's own Key Vault (`${prefix}-kv`, via keyVaultUri), not a
      // hard-coded vault. The live gateway stores it inline; the resolved
      // value is identical and the KV-ref avoids threading another
      // deploy-time secret param.
      secrets: [
        { name: 'master-key', value: masterKey }
        { name: 'jwt-secret', value: jwtSecret }
        {
          name: 'admin-api-key'
          keyVaultUrl: '${keyVaultUri}secrets/admin-api-key'
          identity: 'system'
        }
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
          name: 'stripe-credits-1000-price-id'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-credits-1000-price-id'
          identity: 'system'
        }
        {
          name: 'stripe-credits-2500-price-id'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-credits-2500-price-id'
          identity: 'system'
        }
        {
          name: 'stripe-credits-5000-price-id'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-credits-5000-price-id'
          identity: 'system'
        }
        {
          name: 'alpha-invite-codes'
          keyVaultUrl: '${keyVaultUri}secrets/alpha-invite-codes'
          identity: 'system'
        }
        {
          name: 'azure-ad-client-id'
          keyVaultUrl: '${keyVaultUri}secrets/azure-ad-client-id'
          identity: 'system'
        }
        {
          name: 'azure-ad-client-secret'
          keyVaultUrl: '${keyVaultUri}secrets/azure-ad-client-secret'
          identity: 'system'
        }
        {
          name: 'azure-ad-tenant-id'
          keyVaultUrl: '${keyVaultUri}secrets/azure-ad-tenant-id'
          identity: 'system'
        }
        {
          name: 'stripe-business-price-id'
          keyVaultUrl: '${keyVaultUri}secrets/stripe-business-price-id'
          identity: 'system'
        }
        {
          name: 'slack-sales-webhook-url'
          keyVaultUrl: '${keyVaultUri}secrets/slack-sales-webhook-url'
          identity: 'system'
        }
        {
          // Rootly vendor-down webhook URL — consumed by VendorMonitor
          // (src/monitoring/rootly.ts) as ROOTLY_WEBHOOK_URL. The URL carries
          // a secret query param, so it is a KV reference resolved at runtime
          // by the gateway's managed identity — never inline.
          name: 'rootly-webhook-url'
          keyVaultUrl: '${keyVaultUri}secrets/rootly-vendor-webhook-url'
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
            { name: 'ALLOWED_HOSTS', value: allowedHosts }
            { name: 'MASTER_KEY', secretRef: 'master-key' }
            { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
            { name: 'ADMIN_API_KEY', secretRef: 'admin-api-key' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'AUTH0_DOMAIN', secretRef: 'auth0-domain' }
            { name: 'AUTH0_CLIENT_ID', secretRef: 'auth0-client-id' }
            { name: 'AUTH0_CLIENT_SECRET', secretRef: 'auth0-client-secret' }
            { name: 'AUTH0_CALLBACK_URL', value: empty(customDomain) ? 'https://${prefix}-gateway.${containerEnv.properties.defaultDomain}/auth/callback' : 'https://${customDomain}/auth/callback' }
            { name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key' }
            { name: 'STRIPE_WEBHOOK_SECRET', secretRef: 'stripe-webhook-secret' }
            { name: 'STRIPE_PRO_PRICE_ID', secretRef: 'stripe-pro-price-id' }
            { name: 'STRIPE_CREDITS_1000_PRICE_ID', secretRef: 'stripe-credits-1000-price-id' }
            { name: 'STRIPE_CREDITS_2500_PRICE_ID', secretRef: 'stripe-credits-2500-price-id' }
            { name: 'STRIPE_CREDITS_5000_PRICE_ID', secretRef: 'stripe-credits-5000-price-id' }
            { name: 'ALPHA_INVITE_CODES', secretRef: 'alpha-invite-codes' }
            { name: 'AZURE_AD_CLIENT_ID', secretRef: 'azure-ad-client-id' }
            { name: 'AZURE_AD_CLIENT_SECRET', secretRef: 'azure-ad-client-secret' }
            { name: 'AZURE_AD_TENANT_ID', secretRef: 'azure-ad-tenant-id' }
            { name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }
            { name: 'MICROSOFT_CLIENT_SECRET', value: microsoftClientSecret }
            { name: 'QBO_CLIENT_ID', value: '' }
            { name: 'QBO_CLIENT_SECRET', value: '' }
            { name: 'XERO_CLIENT_ID', value: '' }
            { name: 'XERO_CLIENT_SECRET', value: '' }
            { name: 'HUBSPOT_CLIENT_ID', value: '' }
            { name: 'HUBSPOT_CLIENT_SECRET', value: '' }
            { name: 'LOOPS_API_KEY', value: '' }
            { name: 'THREAD_APP_ID', value: threadAppId }
            { name: 'ADMIN_EMAILS', value: adminEmails }
            { name: 'ENTRA_TRUSTED_TENANT_IDS', value: entraTrustedTenantIds }
            { name: 'REDEPLOY_TRIGGER', value: redeployTrigger }
          ], existingVendorEnv, [
            // Live env order places these after the VENDOR_URL_* block.
            { name: 'STRIPE_BUSINESS_PRICE_ID', secretRef: 'stripe-business-price-id' }
            { name: 'SLACK_SALES_WEBHOOK_URL', secretRef: 'slack-sales-webhook-url' }
            // VendorMonitor pages Rootly on vendor-container down/recovery.
            // Unset == logged no-op (src/monitoring/rootly.ts), so this is
            // safe to add ahead of any Rootly-side config.
            { name: 'ROOTLY_WEBHOOK_URL', secretRef: 'rootly-webhook-url' }
          ])
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
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
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
