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
   current origin stays live until the switch. The full sequence is below
   (one controlled session, not stretched).

## conduit.wyre.ai cutover sequence — one controlled session

The new stack is already validated on its default `*.azurecontainerapps.io`
hostname; the asuid TXT (`asuid.conduit.wyre.ai`) is already in the wyre.ai
zone, so `conduit.wyre.ai` is on `conduit-prod-gateway`'s `customDomains` list
with `bindingType: Disabled`. The cutover provisions the cert and flips traffic
at Aaron's launch-window greenlight. Avoids two known traps documented inline.

1. **Aaron adds RECORD 2** (the cutover): on the wyre.ai Cloudflare zone,
   create CNAME `conduit` → `conduit-prod-gateway.<env-default-domain>`
   (currently `conduit-prod-gateway.kinddesert-88f38e67.eastus2.azurecontainerapps.io`).
   This both enables the ACME challenge for the managed cert AND repoints
   traffic — it IS the cutover. Verify resolution before step 2:
   `dig +short conduit.wyre.ai @1.1.1.1` should return the env's ingress IPs.
2. **Delete the auto-pending cert from the pre-bind attempt.** The Phase-B
   bind attempt created `mc-conduit-prod-e-conduit-wyre-ai-<NNNN>` (ACA
   appends a random suffix) in `Pending` state because the ACME challenge
   couldn't complete without RECORD 2. **Do not let that cert provision and
   bind itself** — its random-suffix name does not match the bicepparam's
   `managedCertName=mc-conduit-prod-env-conduit-wyre-ai`, so the next
   bicep deploy would fail on a customDomain binding referencing a
   nonexistent cert. Delete it (guarded — skips cleanly if a prior attempt
   already removed it or it was never created):
   ```
   NAME=$(az containerapp env certificate list -n conduit-prod-env \
     -g rg-conduit-prod \
     --query "[?starts_with(name,'mc-conduit-prod-e-conduit-wyre-ai-')].name" \
     -o tsv)
   if [ -n "$NAME" ]; then
     az containerapp env certificate delete --name "$NAME" \
       -n conduit-prod-env -g rg-conduit-prod --yes
   else
     echo "no auto-pending cert to delete — skipping step 2"
   fi
   ```
3. **Create the controlled-name managed cert** matching the bicepparam.
   HTTP-01 succeeds because RECORD 2 now points the domain at the env:
   ```
   az containerapp managed-certificate create \
     --name mc-conduit-prod-env-conduit-wyre-ai \
     --resource-group rg-conduit-prod --environment conduit-prod-env \
     --hostname conduit.wyre.ai --validation-method HTTP
   ```
4. **Bind that cert to `conduit.wyre.ai` on `conduit-prod-gateway`:**
   ```
   az containerapp hostname bind \
     --hostname conduit.wyre.ai \
     --name conduit-prod-gateway --resource-group rg-conduit-prod \
     --certificate mc-conduit-prod-env-conduit-wyre-ai
   ```
5. **Validate on the cut-over domain:**
   `curl https://conduit.wyre.ai/health` → `{"status":"ok"}`.
6. The next `conduit-prod` workflow deploy (the steady-state path) sees the
   existing custom-domain binding via the `Read existing gateway state` step
   and synthesizes no new binding — a clean no-op on the customDomain side.

### Cutover-day env-refresh — required KV secrets

The cutover-day deploy refreshes `conduit-prod-gateway` with **all required
config**, not just the image. The 2026-05-22 bicep-completeness pre-cutover
audit identified one new env coupling that landed post the original Phase-B
standup; verify present in `conduit-prod-kv` BEFORE the cutover redeploy:

- **`control-plane-secret`** (from PR #211 / `relay-control-plane-client.ts`).
  Shared HMAC secret between the gateway and the on-prem relay. The gateway
  reads `CONTROL_PLANE_SECRET` env var (KV-backed via `gateway-app.bicep`); the
  relay signs requests with the same value from its own credential store.
  Symmetric — both ends must read the SAME value. Provisioned 2026-05-22 into
  both `conduit-prod-kv` and `mcpgw-staging-kv`; a missing secret = relay
  calls silently fail (null === null skip-path in the client).

  Verify: `az keyvault secret show --vault-name conduit-prod-kv --name
  control-plane-secret --query name -o tsv` should print `control-plane-secret`.

(If a future PR introduces another required env var, extend this section as
part of the same PR. Cutover-day is not the place to discover env wiring gaps.)

### Why path (b) (controlled-name cert) not path (a) (update bicepparam to the auto-suffix name)

Baking a non-reproducible `-3474` random suffix into IaC means every future
re-bind generates a different suffix and the bicepparam drifts. Keep
bicep-as-source-of-truth: the cert name is what the bicepparam declares; the
cert resource matches. Path (a) is the fallback only if a path-(b)
ACME/ordering constraint surfaces mid-cutover (in which case flag it).

## migrate.ts on first boot

The gateway runs `migrate.ts` (001-031) on first boot against the **fresh,
empty** `conduit-prod-pg` database — a non-event, the designed clean-slate
path. This is exactly the migration that is *unsafe* against the live
mcp-gateway DB and *safe* here.

### ⚠ pg_trgm extension allow-list — REQUIRED before the first deploy

Migration `012_impersonation_and_audit.sql` runs `CREATE EXTENSION IF NOT
EXISTS pg_trgm`. A **fresh Azure Database for PostgreSQL Flexible Server
allow-lists NO extensions** — `azure.extensions` is empty by default — so
`CREATE EXTENSION pg_trgm` is rejected, migration 012 fails, `migrate.ts`
throws, and the gateway **crashloops (exit 1)**. Observed on the 2026-05-20
Phase-B standup.

Fix — set the allow-list on `conduit-prod-pg`:
```
az postgres flexible-server parameter set \
  --resource-group rg-conduit-prod --server-name conduit-prod-pg \
  --name azure.extensions --value PG_TRGM
```
`azure.extensions` is a dynamic parameter (no server restart). After setting
it, restart the gateway revision so `migrate.ts` re-runs. The
`Deploy Bicep (conduit-prod)` step in `.github/workflows/deploy.yml` already
does this `parameter set` (idempotent) before every deploy — so a deploy via
the workflow is self-healing; only an interactive first deploy must do it by
hand. **`pg_trgm` is the only extension the conduit migrations need** — if a
future migration adds another `CREATE EXTENSION`, extend the allow-list value.

### Gateway identity → Key Vault (the secretRef chicken-and-egg)

`gateway-app.bicep` gives the gateway a **system-assigned** identity and
declares its 18 app-config secrets as `keyVaultUrl`-backed Container App
secret refs (`identity: 'system'`). `identity.bicep` has
`deployRoleAssignment = false`, so the Bicep does **not** grant the gateway
identity Key Vault access — and it could not usefully do so anyway: the
identity does not exist until the gateway Container App is created, and the
revision tries to resolve the KV secrets as part of that same creation.

So the first deploy leaves the gateway revision stuck `Activating` (KV secrets
unresolvable). After the first deploy, grant the gateway's system identity
`Key Vault Secrets User` on `conduit-prod-kv` and restart the revision:
```
PRINCIPAL=$(az containerapp show -n conduit-prod-gateway -g rg-conduit-prod \
  --query identity.principalId -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL" \
  --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" \
  --scope "$(az keyvault show -n conduit-prod-kv -g rg-conduit-prod --query id -o tsv)"
az containerapp revision restart -n conduit-prod-gateway -g rg-conduit-prod \
  --revision "$(az containerapp show -n conduit-prod-gateway -g rg-conduit-prod --query properties.latestRevisionName -o tsv)"
```
This is a one-time grant — the role assignment persists, so subsequent deploys
need no repeat.

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
