# =============================================================================
# MCP Gateway - Azure Container Registry Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# Container Registry
# -----------------------------------------------------------------------------

resource "azurerm_container_registry" "main" {
  name                          = "${replace(var.name, "-", "")}acr${local.resource_suffix}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Premium" # Required for private endpoints
  admin_enabled                 = false
  public_network_access_enabled = true # Set to false after initial image push

  # Geo-replication (optional for production)
  # georeplications {
  #   location                = "westus"
  #   zone_redundancy_enabled = true
  # }

  # Network rules
  network_rule_set {
    default_action = "Allow" # Set to "Deny" after initial setup
  }

  # Encryption with customer-managed key (optional)
  # encryption {
  #   enabled            = true
  #   key_vault_key_id   = azurerm_key_vault_key.acr.id
  #   identity_client_id = azurerm_user_assigned_identity.acr_encryption.client_id
  # }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# ACR Role Assignment - Container Apps Identity
# -----------------------------------------------------------------------------

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.container_apps.principal_id
}

# -----------------------------------------------------------------------------
# Private Endpoint for ACR
# -----------------------------------------------------------------------------

resource "azurerm_private_endpoint" "acr" {
  name                = "${var.name}-acr-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${var.name}-acr-psc"
    private_connection_resource_id = azurerm_container_registry.main.id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.acr.id]
  }

  tags = local.common_tags
}
