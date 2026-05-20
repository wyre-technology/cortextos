// conduit-prod vendor fleet — option-a Piece 1
//
// Provisions the conduit-prod vendor MCP sidecar fleet: one internal-ingress
// Container App per vendor, into an EXISTING managed environment
// (`conduit-prod-env`, stood up in Phase B).
//
// WHY THIS IS A SEPARATE TEMPLATE (not part of azure/main.bicep):
//   main.bicep deploys the conduit gateway stack and states "the conduit Bicep
//   does not own the vendor MCP fleet." That stays true — the GATEWAY template
//   does not own the fleet. THIS template owns the conduit-prod fleet, deployed
//   on its own. Keeping it separate keeps a gateway deploy lean (a gateway
//   redeploy does not re-reconcile ~33 vendor apps) and mirrors the existing
//   architecture, where the mcp-gateway `gwp-*` fleet is separate from the
//   gateway Bicep.
//
// NAMING — load-bearing. Each app is named exactly `<slug>-mcp`. conduit's
// `src/credentials/vendor-config.ts` declares each sidecar vendor's default
// `containerUrl` as `http://<slug>-mcp:8080`; naming the apps `<slug>-mcp`
// means the conduit-prod gateway resolves every vendor via that default with
// ZERO per-vendor `VENDOR_URL_*` env — no gateway-app.bicep change needed.
//
// VENDOR SECRETS: none. The fleet is BYOC — vendor API credentials are
// per-request headers injected by the gateway, never stored in the vendor
// container. Each app needs only the GHCR pull credential.

targetScope = 'resourceGroup'

@description('Azure region for the vendor apps')
param location string = resourceGroup().location

@description('Name of the EXISTING managed environment to deploy the fleet into (conduit-prod-env)')
param containerEnvName string = 'conduit-prod-env'

@secure()
@description('GitHub Container Registry PAT with read:packages — pulls the vendor MCP images')
param ghcrToken string

@description('CPU per vendor container (cores)')
param cpu string = '0.25'

@description('Memory per vendor container')
param memory string = '0.5Gi'

@description('''
The vendor fleet. One entry per internal-sidecar vendor in
src/credentials/vendor-config.ts (the entries whose containerUrl is
http://<slug>-mcp:8080). Each:
  slug  — the vendor-config.ts slug; the app is named `<slug>-mcp`.
  image — the digest-pinned image, ghcr.io/wyre-technology/<slug>-mcp@sha256:...
''')
param vendors array

// The managed environment is provisioned out-of-band (Phase B). Reference it.
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerEnvName
}

// One internal-ingress Container App per vendor. `gateway` AUTH_MODE: vendor
// containers trust the gateway to inject per-request credentials; ingress is
// internal so only the conduit-prod gateway (same environment) can reach them.
resource vendorApps 'Microsoft.App/containerApps@2024-03-01' = [
  for v in vendors: {
    name: '${v.slug}-mcp'
    location: location
    properties: {
      managedEnvironmentId: containerEnv.id
      configuration: {
        activeRevisionsMode: 'Single'
        ingress: {
          external: false
          targetPort: 8080
          transport: 'http'
          allowInsecure: false
        }
        registries: [
          {
            server: 'ghcr.io'
            username: 'wyre-technology'
            passwordSecretRef: 'ghcr-token'
          }
        ]
        secrets: [
          {
            name: 'ghcr-token'
            value: ghcrToken
          }
        ]
      }
      template: {
        containers: [
          {
            name: 'mcp'
            image: v.image
            resources: {
              cpu: json(cpu)
              memory: memory
            }
            env: [
              { name: 'AUTH_MODE', value: 'gateway' }
              { name: 'MCP_TRANSPORT', value: 'http' }
              { name: 'MCP_HTTP_PORT', value: '8080' }
              { name: 'PORT', value: '8080' }
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

@description('Names of the provisioned vendor apps — feeds the completeness gate.')
output vendorAppNames array = [for v in vendors: '${v.slug}-mcp']

@description('Internal FQDNs of the provisioned vendor apps.')
output vendorFqdns array = [for (v, i) in vendors: vendorApps[i].properties.configuration.ingress.fqdn]
