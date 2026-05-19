# Conduit dedicated PROD stack — deploy runbook (Phase B)

> **STATUS: TEMPLATES READY, NOT DEPLOYED.** `azure/params.conduit-prod.bicepparam`
> is merged and deploy-ready. The actual stand-up below is **held** until
> staging (`staging.conduit.wyre.ai`) is confirmed working — Aaron's call. Do
> not run any step in this document ahead of that confirmation.

## Why this stack exists — the World-A defect

conduit's `production` deploy path in `.github/workflows/deploy.yml` passes no
`namePrefix`, so `main.bicep` resolves `prefix = 'mcpgw-prod'` and the deploy
targets `vars.AZURE_RESOURCE_GROUP` (= `mcp-gateway-prod`). A conduit
`production` deploy therefore **redeploys the live mcp-gateway prod stack in
place** and runs `migrate.ts` against the live mcp-gateway database.

The fix is to give conduit prod its own stack: `namePrefix = 'conduit-prod'`,
deployed into a dedicated resource group `rg-conduit-prod`. The conduit Bicep
is already prefix-parameterized end to end — `params.conduit-prod.bicepparam`
is the entire template change. This is the first increment of the full
conduit RG migration; nothing here is throwaway.

## What is and isn't touched

| Hostname | Stack | Phase B effect |
|---|---|---|
| `mcp.wyre.ai` | `mcpgw-prod-gateway` / `mcp-gateway-prod` | **Untouched** — Phase B only writes to `rg-conduit-prod`. |
| `staging.conduit.wyre.ai` | `mcpgw-staging-gateway` | **Untouched** — prod-only change. |
| `conduit.wyre.ai` | (no Azure CA bound today) | **Moves** — blue-green onto the new conduit-prod gateway. |

## Dependencies (must clear before Phase B)

| # | Dependency | Owner |
|---|---|---|
| a | **conduit-prod Key Vault secrets** — 18 secrets, all copyable from `mcpgw-prod-kv` (see list below). | Aaron / secrets vault |
| b | **`conduit.wyre.ai` Cloudflare origin** — what it points at today; decides whether the cutover is additive or a controlled switch. | Aaron / CF zone |
| c | **Deploy SP `Contributor` on `rg-conduit-prod`** + `Key Vault Secrets User` on the new KV. The deploy SP currently has Contributor on `mcp-gateway-prod` only. | Aaron / Azure RBAC |

## Phase B steps

1. **Create the resource group.** `az group create -n rg-conduit-prod -l eastus2`
2. **Grant the deploy SP** `Contributor` on `rg-conduit-prod` and
   `Key Vault Secrets User` on the conduit-prod KV (dependency c).
3. **Populate the conduit-prod Key Vault** with the 18 secrets (dependency a).
4. **What-if dry run — observe the disjointness before the real deploy.**
   First export the four secret env vars — `params.conduit-prod.bicepparam`
   reads them via `readEnvironmentVariable()` (a `.bicepparam` must self-assign
   every required param; `--parameters` overrides cannot fill omitted ones):
   ```
   export MASTER_KEY=...   # generate FRESH (empty conduit-prod DB)
   export JWT_SECRET=...   # generate FRESH
   export PG_PASSWORD=...  # generate FRESH (new Postgres admin password)
   export GHCR_TOKEN=...   # copy existing read:packages PAT
   ```
   Then run
   `az deployment group what-if --resource-group rg-conduit-prod --template-file azure/main.bicep --parameters azure/params.conduit-prod.bicepparam rootlyWebhookUrl=<from-KV>`.
   On the empty `rg-conduit-prod` it must list every resource as a **Create**
   inside `rg-conduit-prod` and show **zero** changes to any `mcp-gateway-prod`
   resource — the observed proof of the name disjointness the templates are
   designed for. Do not proceed if what-if reports any `mcpgw-prod-*` touch.
5. **First deploy — without the custom domain.** The managed cert for
   `conduit.wyre.ai` does not exist until the domain is bound, and the bind
   references the cert by resource ID. Break the chicken-and-egg by deploying
   once with `customDomain` empty (override `customDomain=''`), letting the
   `conduit-prod-gateway` CA come up on its `*.azurecontainerapps.io` default
   hostname.
6. **Bind `conduit.wyre.ai`** to `conduit-prod-gateway` and let Container Apps
   provision the managed cert (`mc-conduit-prod-env-conduit-wyre-ai`).
7. **Second deploy — with the custom domain.** Re-run with the bicepparam
   as-is (`customDomain = 'conduit.wyre.ai'`); the bind now resolves.
8. **Validate** the new stack end to end on its default hostname / the bound
   domain before any cutover: health endpoint, OAuth callback, a vendor proxy
   call, `schema_migrations` shows 001-030 applied to the *fresh* conduit DB.
9. **Cutover `conduit.wyre.ai`** — re-point the Cloudflare origin to the new
   conduit-prod gateway. Blue-green: the new stack is validated first, the
   current origin stays live until the switch.

## migrate.ts on first boot

The gateway runs `migrate.ts` (001-030) on first boot against the **fresh,
empty** `conduit-prod-pg` database — a non-event, the designed clean-slate
path. This is exactly the migration that is *unsafe* against the live
mcp-gateway DB and *safe* here.

## conduit-prod Key Vault — 18 secrets (copy from `mcpgw-prod-kv`)

```
admin-api-key                    auth0-domain
auth0-client-id                  auth0-client-secret
stripe-secret-key                stripe-webhook-secret
stripe-pro-price-id              stripe-credits-1000-price-id
stripe-credits-2500-price-id     stripe-credits-5000-price-id
stripe-business-price-id         alpha-invite-codes
azure-ad-client-id               azure-ad-client-secret
azure-ad-tenant-id               slack-sales-webhook-url
rootly-vendor-webhook-url        rootly-azuremonitor-webhook-url
```

**Not KV — deploy-param secrets** (conduit-repo GitHub Actions secrets):
`MASTER_KEY` (generate fresh — empty DB, nothing to decrypt), `JWT_SECRET`
(fresh), `PG_PASSWORD` (fresh), `GHCR_TOKEN` (copy existing). `database-url`
is constructed by `main.bicep` from the Postgres module outputs.

## Wiring the deploy path

Phase B steps 5/7 also add a `conduit-prod` deploy path to
`.github/workflows/deploy.yml` — a bicepparam-file step like the staging one,
pointing at `./azure/params.conduit-prod.bicepparam` and
`resourceGroupName: rg-conduit-prod`. That ~15-line workflow change is
deliberately **not** in the templates-only PR: it is reviewed as the first
commit of Phase B execution, in the context of an actual deploy, so a merge
of the templates can never be mistaken for wiring up a deploy.
