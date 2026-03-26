# =============================================================================
# MCP Gateway - Azure Monitoring Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# Log Analytics Workspace
# -----------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${var.name}-logs-${local.resource_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Application Insights
# -----------------------------------------------------------------------------

resource "azurerm_application_insights" "main" {
  count               = var.enable_monitoring ? 1 : 0
  name                = "${var.name}-appinsights"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Action Group for Alerts
# -----------------------------------------------------------------------------

resource "azurerm_monitor_action_group" "main" {
  count               = var.enable_monitoring && var.alert_email != "" ? 1 : 0
  name                = "${var.name}-alerts"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = "mcpalerts"

  email_receiver {
    name          = "admin"
    email_address = var.alert_email
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Alert Rules
# -----------------------------------------------------------------------------

# Container App Error Rate Alert
resource "azurerm_monitor_metric_alert" "container_app_errors" {
  count               = var.enable_monitoring && var.alert_email != "" ? 1 : 0
  name                = "${var.name}-registry-errors"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.registry.id]
  description         = "Alert when registry container app has high error rate"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Requests"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 100

    dimension {
      name     = "statusCodeCategory"
      operator = "Include"
      values   = ["5xx"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }

  tags = local.common_tags
}

# PostgreSQL CPU Alert
resource "azurerm_monitor_metric_alert" "postgres_cpu" {
  count               = var.enable_monitoring && var.alert_email != "" ? 1 : 0
  name                = "${var.name}-postgres-cpu"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Alert when PostgreSQL CPU exceeds 80%"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }

  tags = local.common_tags
}

# PostgreSQL Storage Alert
resource "azurerm_monitor_metric_alert" "postgres_storage" {
  count               = var.enable_monitoring && var.alert_email != "" ? 1 : 0
  name                = "${var.name}-postgres-storage"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Alert when PostgreSQL storage exceeds 80%"
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT1H"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "storage_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }

  tags = local.common_tags
}

# Redis Cache Memory Alert
resource "azurerm_monitor_metric_alert" "redis_memory" {
  count               = var.enable_monitoring && var.alert_email != "" ? 1 : 0
  name                = "${var.name}-redis-memory"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_redis_cache.main.id]
  description         = "Alert when Redis memory usage exceeds 80%"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.Cache/redis"
    metric_name      = "usedmemorypercentage"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }

  tags = local.common_tags
}

# Container App Response Time Alert
resource "azurerm_monitor_metric_alert" "response_time" {
  count               = var.enable_monitoring && var.alert_email != "" ? 1 : 0
  name                = "${var.name}-response-time"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.registry.id]
  description         = "Alert when response time exceeds 5 seconds"
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RequestDuration"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 5000 # 5 seconds in milliseconds
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Diagnostic Settings
# -----------------------------------------------------------------------------

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "${var.name}-postgres-diag"
  target_resource_id         = azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "redis" {
  name                       = "${var.name}-redis-diag"
  target_resource_id         = azurerm_redis_cache.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "ConnectedClientList"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "keyvault" {
  name                       = "${var.name}-keyvault-diag"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}
