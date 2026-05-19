// Conduit dedicated PROD stack — parameters for the OWN-RG conduit-prod stack.
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │  TEMPLATES ONLY — NOT WIRED INTO ANY WORKFLOW, NOT DEPLOYED YET.     │
// │  Merging this file stands nothing up. The conduit-prod stack is      │
// │  deployed only by the explicit Phase-B steps in CONDUIT-PROD-DEPLOY  │
// │  .md, after staging is confirmed working. Aaron's call — do not      │
// │  deploy ahead of that.                                              │
// └─────────────────────────────────────────────────────────────────────┘
//
// WHY THIS FILE EXISTS — the World-A defect
// -----------------------------------------
// conduit's `production` deploy path in deploy.yml passes NO namePrefix, so
// `main.bicep` resolves `prefix = 'mcpgw-prod'` and the deploy targets the
// resource group in `vars.AZURE_RESOURCE_GROUP` (= mcp-gateway-prod). A
// conduit `production` deploy therefore REDEPLOYS the live mcp-gateway prod
// stack in place and runs migrate.ts against the live mcp-gateway DB. This
// param file is the fix: it sets `namePrefix = 'conduit-prod'` so the stack
// is a clean, separate set of resources — deployed into its own resource
// group (`rg-conduit-prod`), never touching any `mcpgw-prod-*` resource.
//
// The conduit Bicep is ALREADY prefix-parameterized end to end (main.bicep
// `var prefix`, every module takes `prefix`/`name`). No template surgery was
// needed — only this parameter file plus the dedicated RG. See
// azure/CONDUIT-PROD-DEPLOY.md for the full Phase-B runbook.

using './main.bicep'

// namePrefix is the whole point: resources become conduit-prod-pg,
// conduit-prod-kv, conduit-prod-env, conduit-prod-gateway, conduit-prod-logs,
// etc. — NOT mcpgw-prod-*. This is what isolates the stack from mcp-gateway.
param namePrefix = 'conduit-prod'
param env = 'prod'

// conduit.wyre.ai is the only hostname that moves to this stack. mcp.wyre.ai
// and staging.conduit.wyre.ai stay on their existing stacks, untouched.
param customDomain = 'conduit.wyre.ai'
param allowedHosts = 'conduit.wyre.ai'

// Container Apps auto-generates the managed cert on first bind; the name
// below is what Azure generates for conduit.wyre.ai on the conduit-prod-env
// managed environment. FIRST DEPLOY: the cert does not exist yet — see the
// CONDUIT-PROD-DEPLOY.md "first-deploy custom-domain bind" note (deploy once
// without customDomain, then bind). If a later deploy reports the cert isn't
// found, copy the actual managed-cert resource name from the Container Apps
// environment into this parameter.
param managedCertName = 'mc-conduit-prod-env-conduit-wyre-ai'

// Carried over from the legacy production inline params in deploy.yml.
param adminEmails = 'aaron@wyretechnology.com,tyork@wyretechnology.com'
param threadAppId = '19ea2482-5f02-41c1-b723-220ecdaefde5'
param entraTrustedTenantIds = 'd92c73a4-ccc2-4277-8c5d-73c2849adfa4'
param alertEmail = 'engineering@wyretechnology.com'

// RG-scoped monthly cost budget for rg-conduit-prod (the subscription-scoped
// budget is separate — azure/subscription-budget.bicep). $1,200 matches the
// existing mcp-gateway-prod RG budget; revisit once conduit-prod spend is
// observed.
param monthlyBudget = 1200

// First deploy of a brand-new stack: no custom domains or vendor env to
// preserve yet. The deploy workflow normally reads these off the live
// gateway; on a first-ever deploy they are empty.
param existingCustomDomains = []
param existingVendorEnv = []

param deployRoleAssignment = false

// Secrets — assigned via readEnvironmentVariable(). A .bicepparam file must
// self-assign every required (non-defaulted) param of its `using` target or
// compilation fails with BCP258; CLI `--parameters` overrides cannot fill
// omitted params. The Phase-B deploy (azure/CONDUIT-PROD-DEPLOY.md §4-7)
// exports these as env vars before running `az deployment group create`:
//   MASTER_KEY  — generate FRESH (empty conduit-prod DB, nothing to decrypt)
//   JWT_SECRET  — generate FRESH
//   PG_PASSWORD — generate FRESH (new Postgres admin password)
//   GHCR_TOKEN  — copy existing
// A missing env var fails the deploy loudly at compile time, not as a blank.
param masterKey = readEnvironmentVariable('MASTER_KEY')
param jwtSecret = readEnvironmentVariable('JWT_SECRET')
param pgPassword = readEnvironmentVariable('PG_PASSWORD')
param ghcrToken = readEnvironmentVariable('GHCR_TOKEN')

// rootlyWebhookUrl (main.bicep defaults to '') — fetched from the conduit-prod
// Key Vault at deploy time and passed as a `--parameters` override.
// Image (set by CI):
//   gatewayImage    — ghcr.io/wyre-technology/conduit:sha-<short>
//   redeployTrigger — the workflow run id
