// Staging Bicep parameters — staging.conduit.wyre.ai
//
// Used by .github/workflows/deploy.yml when the staging environment is
// targeted. The four @secure params (masterKey/jwtSecret/pgPassword/ghcrToken)
// are assigned below via readEnvironmentVariable() — a .bicepparam file must
// self-assign every required (non-defaulted) param of its `using` target, or
// compilation fails with BCP258. CLI `--parameters key=value` overrides can
// only override params a bicepparam already assigns; they cannot fill omitted
// ones. deploy.yml supplies the values as step env: vars from the staging
// GitHub environment secrets MASTER_KEY/JWT_SECRET/PG_PASSWORD/GHCR_TOKEN.
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

// Secrets — assigned from deploy.yml step env: vars (sourced from the staging
// GitHub environment secrets). readEnvironmentVariable() throws at compile
// time on an UNSET var; it returns '' for a var that is set-but-empty. In CI
// the env: block always defines these, so an unset GitHub secret resolves to
// '' — deploy.yml's "Assert staging deploy secrets present" step rejects that
// empty case before the deploy runs.
param masterKey = readEnvironmentVariable('MASTER_KEY')
param jwtSecret = readEnvironmentVariable('JWT_SECRET')
param pgPassword = readEnvironmentVariable('PG_PASSWORD')
param ghcrToken = readEnvironmentVariable('GHCR_TOKEN')

// Optional (main.bicep defaults to ''):
//   microsoftClientId, microsoftClientSecret
// Image:
//   gatewayImage  — set by CI to ghcr.io/<repo>:sha-<short>
//   redeployTrigger — set by CI to the run id
