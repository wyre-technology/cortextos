# =============================================================================
# MCP Gateway - Azure Key Vault Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# Random Password Generation (for secrets not provided)
# -----------------------------------------------------------------------------

resource "random_password" "secret_key" {
  count   = var.secret_key == "" ? 1 : 0
  length  = 64
  special = true
}

resource "random_password" "admin_password" {
  count   = var.admin_password == "" ? 1 : 0
  length  = 32
  special = true
}

resource "random_password" "postgres_password" {
  count   = var.postgres_admin_password == "" ? 1 : 0
  length  = 32
  special = true
}

resource "random_password" "credential_master_key" {
  count   = var.credential_master_key == "" ? 1 : 0
  length  = 32
  special = false
}

# -----------------------------------------------------------------------------
# Key Vault
# -----------------------------------------------------------------------------

resource "azurerm_key_vault" "main" {
  name                = "${var.name}-kv-${local.resource_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  # Soft delete and purge protection for production
  soft_delete_retention_days = 7
  purge_protection_enabled   = false # Set to true in production

  # Network rules - allow Azure services and the VNet
  network_acls {
    default_action             = "Deny"
    bypass                     = "AzureServices"
    ip_rules                   = []
    virtual_network_subnet_ids = [azurerm_subnet.container_apps.id]
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Key Vault Access Policy - Terraform Service Principal
# -----------------------------------------------------------------------------

resource "azurerm_key_vault_access_policy" "terraform" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = data.azurerm_client_config.current.object_id

  secret_permissions = [
    "Get",
    "List",
    "Set",
    "Delete",
    "Purge",
    "Recover",
  ]

  key_permissions = [
    "Get",
    "List",
    "Create",
    "Delete",
  ]
}

# -----------------------------------------------------------------------------
# Key Vault Access Policy - Container Apps Managed Identity
# -----------------------------------------------------------------------------

resource "azurerm_key_vault_access_policy" "container_apps" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_user_assigned_identity.container_apps.principal_id

  secret_permissions = [
    "Get",
    "List",
  ]
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------

resource "azurerm_key_vault_secret" "secret_key" {
  name         = "secret-key"
  value        = var.secret_key != "" ? var.secret_key : random_password.secret_key[0].result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "admin_password" {
  name         = "admin-password"
  value        = var.admin_password != "" ? var.admin_password : random_password.admin_password[0].result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "postgres_password" {
  name         = "postgres-password"
  value        = var.postgres_admin_password != "" ? var.postgres_admin_password : random_password.postgres_password[0].result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "credential_master_key" {
  name         = "credential-master-key"
  value        = var.credential_master_key != "" ? var.credential_master_key : random_password.credential_master_key[0].result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "postgres_connection_string" {
  name         = "postgres-connection-string"
  value        = "postgresql://${var.postgres_admin_username}:${urlencode(azurerm_key_vault_secret.postgres_password.value)}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgres_database_name}?sslmode=require"
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [
    azurerm_key_vault_access_policy.terraform,
    azurerm_postgresql_flexible_server.main,
  ]
}

resource "azurerm_key_vault_secret" "redis_connection_string" {
  name         = "redis-connection-string"
  value        = "rediss://:${azurerm_redis_cache.main.primary_access_key}@${azurerm_redis_cache.main.hostname}:${azurerm_redis_cache.main.ssl_port}"
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [
    azurerm_key_vault_access_policy.terraform,
    azurerm_redis_cache.main,
  ]
}

# Store Entra ID secrets if provided
resource "azurerm_key_vault_secret" "entra_client_secret" {
  count        = var.entra_client_secret != "" ? 1 : 0
  name         = "entra-client-secret"
  value        = var.entra_client_secret
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_key_vault_access_policy.terraform]
}

# Store federation token if provided
resource "azurerm_key_vault_secret" "federation_token" {
  count        = var.federation_static_token != "" ? 1 : 0
  name         = "federation-static-token"
  value        = var.federation_static_token
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_key_vault_access_policy.terraform]
}

# -----------------------------------------------------------------------------
# Private Endpoint for Key Vault
# -----------------------------------------------------------------------------

resource "azurerm_private_endpoint" "keyvault" {
  name                = "${var.name}-kv-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${var.name}-kv-psc"
    private_connection_resource_id = azurerm_key_vault.main.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "keyvault-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.keyvault.id]
  }

  tags = local.common_tags
}
