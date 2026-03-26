# =============================================================================
# MCP Gateway - Azure Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# Resource Group
# -----------------------------------------------------------------------------

output "resource_group_name" {
  description = "Name of the resource group"
  value       = azurerm_resource_group.main.name
}

output "resource_group_location" {
  description = "Location of the resource group"
  value       = azurerm_resource_group.main.location
}

# -----------------------------------------------------------------------------
# Container Registry
# -----------------------------------------------------------------------------

output "acr_login_server" {
  description = "Login server for Azure Container Registry"
  value       = azurerm_container_registry.main.login_server
}

output "acr_name" {
  description = "Name of the Azure Container Registry"
  value       = azurerm_container_registry.main.name
}

# -----------------------------------------------------------------------------
# Container Apps
# -----------------------------------------------------------------------------

output "container_app_environment_id" {
  description = "ID of the Container Apps Environment"
  value       = azurerm_container_app_environment.main.id
}

output "registry_fqdn" {
  description = "FQDN of the MCP Gateway Registry"
  value       = azurerm_container_app.registry.latest_revision_fqdn
}

output "registry_url" {
  description = "Full URL of the MCP Gateway Registry"
  value       = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${azurerm_container_app.registry.latest_revision_fqdn}"
}

output "auth_server_fqdn" {
  description = "FQDN of the Auth Server"
  value       = azurerm_container_app.auth_server.latest_revision_fqdn
}

output "auth_server_url" {
  description = "Full URL of the Auth Server"
  value       = "https://${azurerm_container_app.auth_server.latest_revision_fqdn}"
}

# -----------------------------------------------------------------------------
# Database
# -----------------------------------------------------------------------------

output "postgres_server_fqdn" {
  description = "FQDN of the PostgreSQL Flexible Server"
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgres_database_name" {
  description = "Name of the PostgreSQL database"
  value       = azurerm_postgresql_flexible_server_database.mcp_registry.name
}

# -----------------------------------------------------------------------------
# Redis
# -----------------------------------------------------------------------------

output "redis_hostname" {
  description = "Hostname of the Redis Cache"
  value       = azurerm_redis_cache.main.hostname
}

output "redis_ssl_port" {
  description = "SSL port of the Redis Cache"
  value       = azurerm_redis_cache.main.ssl_port
}

# -----------------------------------------------------------------------------
# Key Vault
# -----------------------------------------------------------------------------

output "key_vault_uri" {
  description = "URI of the Key Vault"
  value       = azurerm_key_vault.main.vault_uri
}

output "key_vault_name" {
  description = "Name of the Key Vault"
  value       = azurerm_key_vault.main.name
}

# -----------------------------------------------------------------------------
# Monitoring
# -----------------------------------------------------------------------------

output "log_analytics_workspace_id" {
  description = "ID of the Log Analytics Workspace"
  value       = azurerm_log_analytics_workspace.main.id
}

output "application_insights_instrumentation_key" {
  description = "Instrumentation Key for Application Insights"
  value       = var.enable_monitoring ? azurerm_application_insights.main[0].instrumentation_key : null
  sensitive   = true
}

output "application_insights_connection_string" {
  description = "Connection String for Application Insights"
  value       = var.enable_monitoring ? azurerm_application_insights.main[0].connection_string : null
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "vnet_id" {
  description = "ID of the Virtual Network"
  value       = azurerm_virtual_network.main.id
}

output "container_apps_subnet_id" {
  description = "ID of the Container Apps subnet"
  value       = azurerm_subnet.container_apps.id
}

# -----------------------------------------------------------------------------
# Identity
# -----------------------------------------------------------------------------

output "container_apps_identity_principal_id" {
  description = "Principal ID of the Container Apps managed identity"
  value       = azurerm_user_assigned_identity.container_apps.principal_id
}

output "container_apps_identity_client_id" {
  description = "Client ID of the Container Apps managed identity"
  value       = azurerm_user_assigned_identity.container_apps.client_id
}

# -----------------------------------------------------------------------------
# CI/CD Helper Outputs
# -----------------------------------------------------------------------------

output "deployment_commands" {
  description = "Commands for deploying container images"
  value = {
    login_acr = "az acr login --name ${azurerm_container_registry.main.name}"
    build_registry = "docker build -t ${azurerm_container_registry.main.login_server}/registry:latest -f docker/Dockerfile.registry ."
    push_registry = "docker push ${azurerm_container_registry.main.login_server}/registry:latest"
    build_auth = "docker build -t ${azurerm_container_registry.main.login_server}/auth-server:latest -f docker/Dockerfile.auth ."
    push_auth = "docker push ${azurerm_container_registry.main.login_server}/auth-server:latest"
  }
}
