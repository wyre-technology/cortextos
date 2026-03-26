# =============================================================================
# MCP Gateway - Azure Database for PostgreSQL Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# PostgreSQL Flexible Server
# -----------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "${var.name}-postgres-${local.resource_suffix}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  delegated_subnet_id           = azurerm_subnet.database.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  version                       = var.postgres_version
  administrator_login           = var.postgres_admin_username
  administrator_password        = var.postgres_admin_password != "" ? var.postgres_admin_password : random_password.postgres_password[0].result
  sku_name                      = var.postgres_sku_name
  storage_mb                    = var.postgres_storage_mb
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  auto_grow_enabled             = true
  public_network_access_enabled = false
  zone                          = "1"

  # High availability configuration (optional - enables zone redundancy)
  # Uncomment for production deployments
  # high_availability {
  #   mode                      = "ZoneRedundant"
  #   standby_availability_zone = "2"
  # }

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }

  tags = local.common_tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    ignore_changes = [
      # Ignore changes to zone for existing deployments
      zone,
    ]
  }
}

# -----------------------------------------------------------------------------
# PostgreSQL Database
# -----------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server_database" "mcp_registry" {
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# -----------------------------------------------------------------------------
# PostgreSQL Firewall Rules (if needed for debugging)
# -----------------------------------------------------------------------------

# Allow Azure services (optional - for debugging from Azure Portal)
# resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
#   name             = "AllowAzureServices"
#   server_id        = azurerm_postgresql_flexible_server.main.id
#   start_ip_address = "0.0.0.0"
#   end_ip_address   = "0.0.0.0"
# }

# -----------------------------------------------------------------------------
# PostgreSQL Server Configuration
# -----------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server_configuration" "log_connections" {
  name      = "log_connections"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

resource "azurerm_postgresql_flexible_server_configuration" "log_disconnections" {
  name      = "log_disconnections"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

resource "azurerm_postgresql_flexible_server_configuration" "log_checkpoints" {
  name      = "log_checkpoints"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

resource "azurerm_postgresql_flexible_server_configuration" "connection_throttling" {
  name      = "connection_throttle.enable"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

# Optimize for application workload
resource "azurerm_postgresql_flexible_server_configuration" "max_connections" {
  name      = "max_connections"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "100"
}

resource "azurerm_postgresql_flexible_server_configuration" "shared_buffers" {
  name      = "shared_buffers"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "128000" # ~128MB
}
