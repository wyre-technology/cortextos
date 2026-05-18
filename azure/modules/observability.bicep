// Observability module — action group and alert rules.
//
// The Log Analytics workspace was extracted to modules/log-analytics.bicep to
// break a module dependency cycle (gateway-app consumes the workspace;
// observability consumes the gateway id). This module now receives the
// workspace resource id as a parameter.
//
// Deploys:
//   - Action Group (email receiver + optional Rootly webhook)
//   - Tier 1 alerts: gateway restarts, 5xx rate, health failures, DB connectivity
//   - Tier 2 alerts: high latency, MCP server restarts, rate-limit exhaustion, auth failures
//   - Infra-perf alerts: gateway CPU / memory / replica saturation
//   - Resource-group monthly cost budget
//
// Scope note: the conduit Bicep owns the gateway + the managed environment, not
// the vendor MCP fleet (gwp-* container apps deploy via their own pipelines).
// The infra-perf alerts here are gateway-only for that reason.

@description('Azure region')
param location string

@description('Resource name prefix (e.g. mcpgw-prod)')
param prefix string

@description('Email address for alert notifications (empty disables email receiver wiring)')
param alertEmail string = ''

@description('Gateway container app resource ID (scope for restart metric alert)')
param gatewayId string

@description('Log Analytics workspace resource ID (scope for scheduled-query alert rules)')
param workspaceId string

@description('Key Vault resource ID — target for the security audit-log diagnostic setting (QW-3). Empty disables the KV diagnostic-setting + KV access alert wiring.')
param keyVaultId string = ''

@secure()
@description('Rootly Azure Monitor webhook URL (contains a secret query param). Supplied at deploy time from Key Vault secret rootly-azuremonitor-webhook-url — never a literal in git. When set, alert + budget notifications also POST to Rootly alongside email; empty == email-only.')
param rootlyWebhookUrl string = ''

@description('Monthly cost budget for the resource group, in USD.')
param monthlyBudget int = 1200

@description('Budget period start date — must be the first of a month. Defaults to the current month.')
param budgetStartDate string = utcNow('yyyy-MM-01')

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-alerts'
  location: 'global'
  properties: {
    groupShortName: 'mcpgw-eng'
    enabled: true
    emailReceivers: [
      {
        name: 'Engineering'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
    // Rootly webhook receiver — wired only when rootlyWebhookUrl is supplied.
    // Empty array == email-only, the current default.
    webhookReceivers: empty(rootlyWebhookUrl) ? [] : [
      {
        name: 'Rootly'
        serviceUri: rootlyWebhookUrl
        useCommonAlertSchema: true
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Gateway container restarts (> 2 in 5 min)
// ---------------------------------------------------------------------------

resource alertGatewayRestarts 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-gateway-restarts'
  location: 'global'
  properties: {
    description: 'Gateway container restarted more than 2 times in 5 minutes'
    severity: 1
    enabled: true
    scopes: [gatewayId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'RestartCount'
          metricName: 'RestartCount'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 2
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — 5xx error rate
// ---------------------------------------------------------------------------

resource alertGateway5xx 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-gateway-5xx-rate'
  location: location
  properties: {
    description: 'More than 5% of gateway requests returned 5xx over 5 minutes'
    severity: 1
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":5' or Log_s has '"res":{"statusCode":5'
            | summarize errors = count() by bin(TimeGenerated, 5m)
            | where errors > 10
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Health endpoint failures
// ---------------------------------------------------------------------------

resource alertHealthFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-health-failures'
  location: location
  properties: {
    description: 'Gateway health probe failed 3+ times in 5 minutes — possible outage'
    severity: 0
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Reason_s == 'Unhealthy' or Reason_s == 'FailedHealthCheck'
            | summarize failures = count() by bin(TimeGenerated, 5m)
            | where failures >= 3
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — PostgreSQL connection failures
// ---------------------------------------------------------------------------

resource alertDbConnectivity 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-db-connectivity'
  location: location
  properties: {
    description: 'PostgreSQL connection errors detected in gateway logs'
    severity: 1
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has 'ECONNREFUSED' or Log_s has 'connection terminated' or Log_s has 'connect_timeout' or Log_s has 'too many connections'
            | summarize errors = count() by bin(TimeGenerated, 5m)
            | where errors >= 3
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — High latency (P95 > 5s)
// ---------------------------------------------------------------------------

resource alertHighLatency 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-high-latency'
  location: location
  properties: {
    description: 'Gateway P95 response time exceeded 5 seconds over 5 minutes'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"responseTime"'
            | extend parsed = parse_json(Log_s)
            | extend responseTime = todouble(parsed.responseTime)
            | where isnotnull(responseTime)
            | summarize p95 = percentile(responseTime, 95) by bin(TimeGenerated, 5m)
            | where p95 > 5000
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — MCP server restarts
//
// Conduit's vendor MCP container apps use the 'gwp-' name prefix (gwp-cipp,
// gwp-autotask, … — 40 of them). That prefix is distinct from the gateway
// (mcpgw-prod-gateway) and from the legacy mcp-gateway sidecars (mcpgw-prod-*),
// so the query filters on 'gwp-'. Filtering on '${prefix}-' (mcpgw-prod-)
// matched the legacy sidecars and never the conduit vendor fleet — a
// silent-blind monitor for conduit until this fix.
// ---------------------------------------------------------------------------

resource alertMcpServerRestarts 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-mcp-server-restarts'
  location: location
  properties: {
    description: 'An MCP vendor server container restarted more than 2 times in 5 minutes'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s startswith 'gwp-'
            | where Reason_s == 'BackOff' or Reason_s == 'CrashLoopBackOff' or Reason_s has 'restart'
            | summarize restarts = count() by ContainerAppName_s, bin(TimeGenerated, 5m)
            | where restarts > 2
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Vendor MCP container CPU / memory saturation (fleet-wide)
//
// One log-search alert covering the whole gwp-* vendor fleet (~40 container
// apps). It is a LOG alert, not a metric alert, on purpose: Azure does not
// support multi-resource metric alerts for Microsoft.App/containerApps (the
// metric-alert multi-resource allowlist excludes Container Apps), so the
// only one-rule-for-the-fleet shape is a workspace-scoped scheduled query.
//
// Data path: each gwp-* container app has an AllMetrics diagnostic setting
// routing its platform metrics to this workspace's AzureMetrics table. That
// diagnostic setting is applied by the shared deploy workflow
// (wyre-technology/.github -> mcp-server-deploy.yml) — see the companion PR.
// Until that setting exists on a given CA, that CA simply contributes no
// rows here: the alert fails safe (no coverage, never a false alarm).
//
// Thresholds mirror the gateway alerts: CPU > 80%, memory > 85%.
// ---------------------------------------------------------------------------

resource alertVendorResourceSaturation 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-vendor-resource-saturation'
  location: location
  properties: {
    description: 'A vendor MCP container app sustained CPU > 80% or memory > 85% over 15 minutes'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            AzureMetrics
            | where ResourceProvider == 'MICROSOFT.APP'
            | where Resource startswith 'GWP-'
            | where MetricName in ('CpuPercentage', 'MemoryPercentage')
            | summarize avgValue = avg(Average) by Resource, MetricName, bin(TimeGenerated, 15m)
            | where (MetricName == 'CpuPercentage' and avgValue > 80)
                 or (MetricName == 'MemoryPercentage' and avgValue > 85)
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Rate limit exhaustion
// ---------------------------------------------------------------------------

resource alertRateLimits 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-rate-limit-exhaustion'
  location: location
  properties: {
    description: 'More than 50 rate-limited (429) responses in 1 hour — possible abuse or undersized limits'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":429' or Log_s has '"res":{"statusCode":429'
            | summarize count429 = count()
            | where count429 > 50
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Auth failure spike
// ---------------------------------------------------------------------------

resource alertAuthFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-auth-failures'
  location: location
  properties: {
    description: 'More than 20 authentication failures (401/403) in 5 minutes — possible attack or misconfigured client'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":401' or Log_s has '"statusCode":403'
              or Log_s has '"res":{"statusCode":401' or Log_s has '"res":{"statusCode":403'
            | summarize authFailures = count() by bin(TimeGenerated, 5m)
            | where authFailures > 20
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---------------------------------------------------------------------------
// Infra-perf — Gateway CPU saturation (> 80% of allocation, 15 min)
// ---------------------------------------------------------------------------

resource alertGatewayCpu 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-gateway-cpu-high'
  location: 'global'
  properties: {
    description: 'Gateway CPU above 80% of its allocation, sustained over 15 minutes'
    severity: 2
    enabled: true
    scopes: [gatewayId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'CpuHigh'
          metricName: 'CpuPercentage'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
}

// ---------------------------------------------------------------------------
// Infra-perf — Gateway memory saturation (> 85% of allocation, 15 min)
// ---------------------------------------------------------------------------

resource alertGatewayMemory 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-gateway-memory-high'
  location: 'global'
  properties: {
    description: 'Gateway memory above 85% of its allocation, sustained over 15 minutes'
    severity: 2
    enabled: true
    scopes: [gatewayId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'MemoryHigh'
          metricName: 'MemoryPercentage'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
}

// ---------------------------------------------------------------------------
// Infra-perf — Gateway replicas maxed (>= maxReplicas of 3, sustained 30 min)
// ---------------------------------------------------------------------------

resource alertGatewayReplicasMaxed 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-gateway-replicas-maxed'
  location: 'global'
  properties: {
    description: 'Gateway pinned at its 3-replica maximum for 30 minutes — sustained load, no headroom to scale'
    severity: 2
    enabled: true
    scopes: [gatewayId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ReplicasMaxed'
          metricName: 'Replicas'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThanOrEqual'
          threshold: 3
          timeAggregation: 'Minimum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
}

// ---------------------------------------------------------------------------
// Infra-perf — Gateway replicas starved (< minReplicas of 1, 10 min)
// ---------------------------------------------------------------------------

resource alertGatewayReplicasStarved 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-gateway-replicas-starved'
  location: 'global'
  properties: {
    description: 'Gateway running below its 1-replica minimum for 10 minutes — likely unhealthy, not a scale event'
    severity: 1
    enabled: true
    scopes: [gatewayId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ReplicasStarved'
          metricName: 'Replicas'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
}

// ---------------------------------------------------------------------------
// Cost — Resource-group monthly budget
// ---------------------------------------------------------------------------
// 80% Actual / 100% Actual / 100% Forecasted, all routed to the action group so
// budget breaches surface on the same path as infra alerts.

// ===========================================================================
// Security alerting — QW-3 / QW-4 / QW-5
//
// Quick-wins from the 2026-05-18 security-monitoring posture assessment
// (task_1779129094851). These raise SECURITY alerting on the same Azure
// Monitor rails the operational alerts above already use. They complement —
// they do not replace — Microsoft Defender for Key Vault and Defender for
// Resource Manager (enabled subscription-side the same day): Defender does
// the ML-anomaly detection, these give a deterministic, owned, in-IaC catch
// that routes to the same action group / Rootly path as every other alert.
// ===========================================================================

// QW-3 — Key Vault audit-log diagnostic setting.
// Routes the Key Vault AuditEvent log (every secret/key access) into the Log
// Analytics workspace, so KV access is retained, queryable for forensics, and
// alertable. The vault holds the platform's crown-jewel secrets; before this
// its access log was not in the workspace at all.
resource targetKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (!empty(keyVaultId)) {
  name: last(split(keyVaultId, '/'))
}

resource keyVaultAuditDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(keyVaultId)) {
  name: 'kv-audit-to-law'
  scope: targetKeyVault
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'AuditEvent', enabled: true }
      { category: 'AzurePolicyEvaluationDetails', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// QW-3 — Key Vault denied-access alert.
// Any forbidden (403) operation against the vault — a secret/key access that
// was rejected — is high signal on a credential store and fires immediately.
// Defender for Key Vault catches the subtle anomaly patterns; this catches the
// blunt one (denied access) deterministically. Depends on the diagnostic
// setting above; until KV logs flow the AzureDiagnostics rows simply do not
// exist and the rule is a no-op.
resource alertKeyVaultDeniedAccess 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (!empty(keyVaultId)) {
  name: '${prefix}-sec-keyvault-denied-access'
  location: location
  properties: {
    description: 'A forbidden (403) access to the Key Vault — denied secret/key operation on the credential store'
    severity: 1
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where ResourceProvider == 'MICROSOFT.KEYVAULT'
            | where Category == 'AuditEvent'
            | where httpStatusCode_d == 403
            | summarize denied = count() by bin(TimeGenerated, 15m)
            | where denied > 0
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// QW-4 — Activity-Log security alerts.
// Control-plane tampering detection: an attacker (or a mistake) that grants a
// role, opens the Key Vault, or swaps a container image shows up in the Azure
// Activity Log. These activityLogAlerts fire on the successful administrative
// operation and route to the same action group. Scoped to this resource group.
resource alertSecRbacChange 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: '${prefix}-sec-rbac-change'
  location: 'global'
  properties: {
    enabled: true
    scopes: [resourceGroup().id]
    description: 'An RBAC role assignment was created or removed in the resource group'
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        { field: 'status', equals: 'Succeeded' }
        {
          anyOf: [
            { field: 'operationName', equals: 'Microsoft.Authorization/roleAssignments/write' }
            { field: 'operationName', equals: 'Microsoft.Authorization/roleAssignments/delete' }
          ]
        }
      ]
    }
    actions: {
      actionGroups: [
        { actionGroupId: actionGroup.id }
      ]
    }
  }
}

resource alertSecKeyVaultChange 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: '${prefix}-sec-keyvault-change'
  location: 'global'
  properties: {
    enabled: true
    scopes: [resourceGroup().id]
    description: 'A Key Vault configuration or access-policy change in the resource group'
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        { field: 'status', equals: 'Succeeded' }
        {
          anyOf: [
            { field: 'operationName', equals: 'Microsoft.KeyVault/vaults/write' }
            { field: 'operationName', equals: 'Microsoft.KeyVault/vaults/accessPolicies/write' }
            { field: 'operationName', equals: 'Microsoft.KeyVault/vaults/delete' }
          ]
        }
      ]
    }
    actions: {
      actionGroups: [
        { actionGroupId: actionGroup.id }
      ]
    }
  }
}

resource alertSecContainerAppChange 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: '${prefix}-sec-containerapp-change'
  location: 'global'
  properties: {
    enabled: true
    scopes: [resourceGroup().id]
    description: 'A Container App was created or updated — image / ingress / config change in the resource group'
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        { field: 'status', equals: 'Succeeded' }
        { field: 'operationName', equals: 'Microsoft.App/containerApps/write' }
      ]
    }
    actions: {
      actionGroups: [
        { actionGroupId: actionGroup.id }
      ]
    }
  }
}

// QW-5 — Low-and-slow auth-failure detector.
// alertAuthFailures (above) catches a 5-minute spike (> 20 401/403). It
// structurally cannot see credential spraying paced to stay under that bar.
// This rule sums 401/403 over a 6-hour window: a sustained-elevated failure
// rate that never spikes is the classic slow-spray signature. The two alerts
// are complementary — spike vs slow-burn — not redundant.
resource alertAuthFailuresSlowBurn 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-sec-auth-failures-slow-burn'
  location: location
  properties: {
    description: 'More than 100 authentication failures (401/403) over 6 hours — sustained low-and-slow credential spraying that stays under the 5-minute spike threshold'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT1H'
    windowSize: 'PT6H'
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == '${prefix}-gateway'
            | where Log_s has '"statusCode":401' or Log_s has '"statusCode":403'
              or Log_s has '"res":{"statusCode":401' or Log_s has '"res":{"statusCode":403'
            | summarize slowBurn = count()
            | where slowBurn > 100
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

resource costBudget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${prefix}-monthly-budget'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${budgetStartDate}T00:00:00Z'
    }
    notifications: {
      Actual_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: []
        contactGroups: [actionGroup.id]
      }
      Actual_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: []
        contactGroups: [actionGroup.id]
      }
      Forecasted_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: []
        contactGroups: [actionGroup.id]
      }
    }
  }
}

output actionGroupId string = actionGroup.id
