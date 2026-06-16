# Staging environment setup — staging.conduit.wyre.ai

One-time setup for the staging environment that auto-deploys on every push to
`main`. Production stays manual.

## What's automated (already in the repo)

- `azure/params.staging.bicepparam` — staging-specific Bicep params (env name,
  custom domain, alert email)
- `.github/workflows/deploy.yml` — two deploy paths:
  - `staging` runs automatically when CI on `main` passes
  - `production` only runs on `workflow_dispatch` (gated by the `production`
    GitHub environment)

## What you have to do once

### 1. GitHub environments + secrets

Repo → Settings → Environments. Create two:

**`staging`** — no required reviewers. Add:
- Variables:
  - `AZURE_RESOURCE_GROUP` = `mcp-gateway-staging-rg`
- Secrets:
  - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (OIDC federated identity)
  - `MASTER_KEY` — must match mcp-gateway production's value (see
    `mcp-gateway-cutover-runbook.md` §5.1)
  - `JWT_SECRET` — fresh 64-hex value (does not need to match prod)
  - `PG_PASSWORD` — fresh, staging-only
  - `GHCR_TOKEN` — PAT with `read:packages`

**`production`** — required reviewers: at least one. Add the same variable +
secret set, with production values, and `AZURE_RESOURCE_GROUP =
mcp-gateway-prod-rg` (or whatever the existing prod RG is named).

### 2. Resource group

```sh
az group create --name mcp-gateway-staging-rg --location eastus
```

### 3. DNS

Cloudflare (or wherever `conduit.wyre.ai` lives):

```
staging.conduit.wyre.ai  CNAME  mcpgw-staging-gateway.<region>.azurecontainerapps.io
```

Replace `<region>.azurecontainerapps.io` with the FQDN that Bicep emits as
`gatewayFqdn` after the first deploy. Set proxy status to **DNS only** (grey
cloud); Container Apps handles TLS via the managed cert.

### 4. Auth0 tenant

**Staging and production use SEPARATE Auth0 tenants** (corrected 2026-06-16).
Earlier revisions of this doc described a single-tenant shared-application
pattern; that reflected an older substrate state and is no longer accurate.

- **conduit-staging** has its own Auth0 tenant. The `AUTH0_DOMAIN`,
  `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` configured under the `staging`
  GitHub environment must point at the staging tenant.
- **conduit-prod** has its own Auth0 tenant with a separate application,
  separate client credentials, and an independent allowed-URL list. The
  `production` GitHub environment carries the production-tenant credentials.

Per-tenant setup (do this once per environment in each tenant):

1. Auth0 dashboard → Applications → Conduit app → Settings → **Allowed Callback
   URLs**: add the environment's callback (`https://staging.conduit.wyre.ai/auth/callback`
   in the staging tenant; `https://conduit.wyre.ai/auth/callback` in the production tenant).
2. Same for **Allowed Logout URLs** if you use them.
3. Copy the tenant's `AUTH0_DOMAIN` + `AUTH0_CLIENT_ID` + `AUTH0_CLIENT_SECRET`
   into the matching GitHub environment's secrets.

Tenant separation gives staging its own user pool, application config, and
rule/action surface — changes there cannot reach production users.

## First deploy

Once the secrets and DNS are in place, the next push to `main` will trigger
CI → on success → staging deploy. Watch the Actions run, grab the `gatewayFqdn`
output from Bicep, and confirm the CNAME you created in step 3 points there.

If the managed cert in `params.staging.bicepparam` has a different name than
Container Apps actually generates, the deploy fails with a clear "managed
certificate not found" error. Copy the real name from the Container Apps env
in the portal and update `azure/params.staging.bicepparam:managedCertName`.

## Verifying

```sh
curl -sI https://staging.conduit.wyre.ai/health
# expect: HTTP/2 200
```

Once that's green, the staging environment is ready for the migration dry-run
in `mcp-gateway-cutover-runbook.md` §5.3.
