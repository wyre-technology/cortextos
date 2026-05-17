# Grafana — Conduit monitoring dashboards

Version-controlled Grafana dashboard models for the Conduit MCP gateway,
imported into the `mcpgw-prod-grafana` Azure Managed Grafana instance.

## `conduit-monitoring.json` — Conduit Gateway: Cost & Infra Performance

Infra-performance + cost dashboard. The metric panels mirror the alert set in
`azure/modules/observability.bicep` so the dashboard and the alerts tell one
consistent story:

| Panel | Source | Mirrors alert |
|---|---|---|
| CPU usage | Azure Monitor metric `UsageNanoCores` | `gateway-cpu-high` |
| Memory working set | Azure Monitor metric `WorkingSetBytes` | `gateway-memory-high` |
| Replica count | Azure Monitor metric `Replicas` | `gateway-replicas-maxed` / `-starved` |
| Container restarts | Azure Monitor metric `RestartCount` | `gateway-restarts` |
| HTTP 5xx | Log Analytics KQL | `gateway-5xx-rate` |
| P95 latency | Log Analytics KQL | `high-latency` |
| Auth failures | Log Analytics KQL | `auth-failures` |
| Cost (text) | — | `mcpgw-prod-monthly-budget` |

### Parameterization

The dashboard is data-source- and resource-agnostic by design:

- `${DS_AZURE_MONITOR}` — the Azure Monitor data source is chosen at import
  time. No hardcoded data-source UID, so the file is portable across Grafana
  instances.
- `subscription` / `resourceGroup` / `gatewayApp` / `logAnalytics` — template
  variables. Defaults point at the current `mcp-gateway-prod` /
  `mcpgw-prod-gateway` stack. **After the June `rg-conduit-prod` stand-up,
  re-point all four** — no JSON edit to the panels needed. If `rg-conduit-prod`
  lands in a *different* subscription, `subscription` must be re-pointed too;
  if it stays in the same subscription, only the other three change.

### Import

Azure Managed Grafana — import via the portal (Dashboards → New → Import →
upload `conduit-monitoring.json`), or via the Grafana API:

```bash
# Requires a Grafana Editor (or higher) role on mcpgw-prod-grafana.
az grafana dashboard create \
  --name mcpgw-prod-grafana \
  --definition @azure/grafana/conduit-monitoring.json \
  --overwrite
```

On import, select the Azure Monitor data source when prompted for
`${DS_AZURE_MONITOR}`.

> **v1 status:** this JSON is authored against the Grafana 12.x schema and the
> Azure Monitor data-source query model, but is render-validated against the
> live `mcpgw-prod-grafana` instance as the final step of the import (it
> requires a Grafana Editor role). Treat a first import as the validation pass.
