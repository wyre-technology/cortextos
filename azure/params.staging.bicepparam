// Staging Bicep parameters — staging.conduit.wyre.ai
//
// Used by .github/workflows/deploy.yml when the staging environment is
// targeted. Secrets (masterKey/jwtSecret/pgPassword/ghcrToken) come from the
// staging GitHub environment and are passed through `--parameters` overrides
// at deploy time, so they are intentionally absent here.
//
// MASTER_KEY note: the staging environment's MASTER_KEY must match
// mcp-gateway production's so the migrate-from-mcp-gateway.ts script can
// decrypt migrated credential rows. See
// docs/operations/mcp-gateway-cutover-runbook.md §5.1.

using './main.bicep'

param env = 'staging'
param customDomain = 'staging.conduit.wyre.ai'

// Container Apps creates the managed cert on first bind; the name below
// matches what Azure auto-generates for staging.conduit.wyre.ai. If a deploy
// reports the cert isn't found, copy the actual managed-cert resource name
// from the Container Apps env into this parameter.
param managedCertName = 'mc-mcpgw-staging-env-staging-conduit-wyre-ai'

param alertEmail = 'aaron@wyretechnology.com'
param deployRoleAssignment = false

// Vendor sidecars: start with the same set as production. Staging shares
// vendor container images by design, since the proxy code path is what we're
// validating against the migrated dataset.
// (vendors[] uses main.bicep's default — leave unset)

// Secrets (CI passes these via --parameters):
//   masterKey, jwtSecret, pgPassword, ghcrToken
// Optional:
//   microsoftClientId, microsoftClientSecret
// Image:
//   gatewayImage  — set by CI to ghcr.io/<repo>:sha-<short>
//   redeployTrigger — set by CI to the run id
