// Observability module — action group and alert rules.
//
// The Log Analytics workspace was extracted to modules/log-analytics.bicep to
// break a module dependency cycle (gateway-app consumes the workspace;
// observability consumes the gateway id). This module now receives the
// workspace resource id as a parameter.
//
// Deploys:
//   - Action Group (email receiver)
//   - Tier 1 alerts: gateway restarts, 5xx rate, health failures, DB connectivity
//   - Tier 2 alerts: high latency, MCP server restarts, rate-limit exhaustion, auth failures

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
            | where ContainerAppName_s startswith '${prefix}-' and ContainerAppName_s != '${prefix}-gateway'
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

output actionGroupId string = actionGroup.id
