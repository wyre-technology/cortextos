// Subscription-scoped monthly cost budget.
//
// Separate from main.bicep: a Microsoft.Consumption/budgets resource at
// subscription scope cannot be created by a resource-group deployment. This
// file is deployed on its own via `az deployment sub create` — see the
// "Deploy subscription budget" step in .github/workflows/deploy.yml.
//
// The RG-scoped budget ($1,200/mo) lives in azure/modules/observability.bicep
// and covers mcp-gateway-prod. This one is the wider safety net: the whole
// subscription's monthly spend.
//
// Requires the deploy service principal to hold the "Cost Management
// Contributor" role at subscription scope.

targetScope = 'subscription'

@description('Monthly cost budget for the entire subscription, in USD.')
param monthlyBudget int = 3000

@description('Budget period start date — must be the first of a month. Defaults to the current month (a Monthly-timegrain budget requires a start date within the current period).')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Resource ID of the action group that budget-breach notifications route to (e.g. the mcpgw-prod-alerts action group).')
param actionGroupId string

resource subscriptionBudget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'wyre-subscription-monthly-budget'
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
        contactGroups: [actionGroupId]
      }
      Actual_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: []
        contactGroups: [actionGroupId]
      }
      Forecasted_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: []
        contactGroups: [actionGroupId]
      }
    }
  }
}

output budgetName string = subscriptionBudget.name
