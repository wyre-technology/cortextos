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
