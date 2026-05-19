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

// Target the EXISTING managed environment. main.bicep resolves the env name as
// `empty(containerEnvName) ? '${prefix}-env' : containerEnvName` — left unset,
// staging would resolve to the bicep-canonical `mcpgw-staging-env` and a deploy
// would CREATE a new managed environment and re-home the gateway onto it (a
// high-blast-radius migration with a custom-domain/cert rebind). The live
// staging stack runs on the hand-built `mcpgw-staging-env-v2`; pinning it here
// keeps a deploy a true in-place revision bump. Mirrors the production deploy,
// which already pins `containerEnvName=mcpgw-prod-env-v2`. Canonicalising the
// `-v2` name is a separate, deliberate, scheduled migration.
param containerEnvName = 'mcpgw-staging-env-v2'

// Hostname allowlist. main.bicep defaults allowedHosts to '' — unset, the
// gateway gets ALLOWED_HOSTS='' which config.ts splits to an EMPTY allowlist,
// so getRequestBaseUrl() cannot match the request Host and falls back to its
// hardcoded 'http://localhost:8080' literal — producing a malformed
// double-scheme OAuth callback (https://http://localhost:8080/...) that breaks
// Microsoft/Entra sign-in. Set the staging host as a BARE host, no scheme:
// getRequestBaseUrl matches the Host against this list and builds
// `${proto}://${host}` itself. The production deploy passes allowedHosts
// inline; staging just never set it.
param allowedHosts = 'staging.conduit.wyre.ai'

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

// Image:
//   gatewayImage  — set by CI to ghcr.io/<repo>:sha-<short>
//   redeployTrigger — set by CI to the run id
