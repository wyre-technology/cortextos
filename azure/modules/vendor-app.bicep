// Vendor MCP server Container Apps (internal ingress only)
//
// Each vendor in `vendors` gets one Container App with AUTH_MODE=gateway.

@description('Azure region')
param location string

@description('Resource name prefix (e.g. mcpgw-prod)')
param prefix string

@description('Container Apps Environment resource ID')
param containerEnvId string

@secure()
@description('GHCR pull token')
param ghcrToken string

@description('Vendor definitions: [{ slug, image }]')
param vendors array

resource mcpServers 'Microsoft.App/containerApps@2024-03-01' = [
  for vendor in vendors: {
    name: '${prefix}-${vendor.slug}'
    location: location
    properties: {
      managedEnvironmentId: containerEnvId
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

output mcpServerNames array = [for (vendor, i) in vendors: mcpServers[i].name]
