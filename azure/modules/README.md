# Azure Bicep modules

`azure/main.bicep` is a thin orchestrator. Each file below owns one slice of the
stack. Parameter names at the top-level of `main.bicep` are intentionally frozen
so existing deploy workflows (`.github/workflows/deploy.yml`) keep working.

## Modules

| File | Responsibility | Key outputs |
| --- | --- | --- |
| `keyvault.bicep` | Key Vault (RBAC-enabled). Secret *values* live out-of-band; the vault here is just the container. | `id`, `name`, `vaultUri` |
| `identity.bicep` | `Key Vault Secrets User` role assignment for the gateway's system-assigned MI. Gated by `deployRoleAssignment`. | — |
| `postgres.bicep` | PostgreSQL Flexible Server + `gateway` database + `AllowAzureServices` firewall rule. SKU is parameterized (`skuName` / `skuTier`). | `fqdn`, `adminUser`, `databaseName` |
| `gateway-app.bicep` | Shared Container Apps Environment + public-ingress gateway app. Owns the Key Vault secret references (`auth0-*`, `stripe-*`, `alpha-invite-codes`) and env-var wiring. | `containerEnvId`, `gatewayId`, `gatewayFqdn`, `gatewayPrincipalId` |
| `vendor-app.bicep` | Per-vendor internal Container Apps (`AUTH_MODE=gateway`). Consumes `containerEnvId` from the gateway module. | `mcpServerNames` |
| `observability.bicep` | Log Analytics workspace, action group, and all metric / scheduled-query alerts (gateway restarts, 5xx rate, health failures, DB connectivity, latency, MCP restarts, rate limits, auth failures). | `workspaceId`, `customerId`, `primarySharedKey`, `actionGroupId` |

## Dependency flow

```
keyvault ──┐
           ├──> identity (needs gateway principalId)
postgres ──┤
           ├──> gateway-app ──> vendor-app
observability ─┘                    │
         ^                          │
         └──────── gatewayId <──────┘   (alert scope)
```

`observability` is declared before `gateway-app` at the module level but depends
on `gatewayApp.outputs.gatewayId` for the restart metric alert scope — Bicep
resolves module ordering from output references, so the explicit source order
in `main.bicep` is not significant.

## Load-bearing bits (do not rename without coordination)

- Key Vault secret names: `auth0-domain`, `auth0-client-id`, `auth0-client-secret`, `stripe-secret-key`, `stripe-webhook-secret`, `stripe-pro-price-id`, `alpha-invite-codes`. The `secretRef` env vars on the gateway container reference these exact names.
- `AUTH0_DOMAIN` → `secretRef: auth0-domain` wiring in `gateway-app.bicep` resolves to whatever value the out-of-band secret currently holds; changing the name here silently breaks Auth0 login.
- Top-level parameter names in `main.bicep` (`namePrefix`, `kvName`, `gatewayImage`, `masterKey`, `jwtSecret`, `pgPassword`, `ghcrToken`, `customDomain`, `managedCertName`, `alertEmail`, `deployRoleAssignment`, `vendors`, `env`, `redeployTrigger`) are consumed by CI — treat them as a public interface.
