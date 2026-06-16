// Resource-group monthly cost budget for rg-conduit-prod — ONE-TIME deploy.
//
// Moved OUT of the per-deploy main.bicep path (WYREAI-174). A
// Microsoft.Consumption/budgets startDate is IMMUTABLE: re-deploying the budget
// with observability.bicep's default budgetStartDate = utcNow('yyyy-MM-01')
// fails ("400 Start date of budgets cannot be updated. Please delete and create
// a new budget.") on the first conduit-prod redeploy of any month after the
// budget was created — which broke the 9e96f73 / #419 deploy. conduit-prod now
// sets observability deployCostBudget=false, and this standalone file owns the
// budget. Mirrors the same one-time-deploy pattern as subscription-budget.bicep.
//
// Deploy once (and only when the budget needs (re)creating — e.g. after a
// `az consumption budget delete`, or to change the amount):
//
//   az deployment group create \
//     --resource-group rg-conduit-prod \
//     --name conduit-prod-budget \
//     --template-file ./azure/conduit-prod-budget.bicep
//
// Because the startDate is immutable, change the amount by deleting first:
//   az consumption budget delete -g rg-conduit-prod -n conduit-prod-monthly-budget
// then re-deploying this. Steady-state conduit-prod app deploys never touch it.

targetScope = 'resourceGroup'

@description('Resource name prefix — matches the conduit-prod stack so the budget name is conduit-prod-monthly-budget (the existing budget).')
param prefix string = 'conduit-prod'

@description('Monthly cost budget for rg-conduit-prod, in USD. Keep in sync with params.conduit-prod.bicepparam monthlyBudget.')
param monthlyBudget int = 1200

@description('Budget period start date — must be the first of a month. Defaults to the current month. NOTE: immutable once set; to change it you must delete the existing budget first.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Name of the existing action group that budget-breach notifications route to. Created by the conduit-prod stack (observability.bicep) as <prefix>-alerts.')
param actionGroupName string = 'conduit-prod-alerts'

// Reference the existing action group in this RG to route notifications to the
// same path as every other conduit-prod alert (no need to pass a full id).
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' existing = {
  name: actionGroupName
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

output budgetName string = costBudget.name
