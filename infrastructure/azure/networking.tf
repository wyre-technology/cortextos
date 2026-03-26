# =============================================================================
# MCP Gateway - Azure Networking Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# Virtual Network
# -----------------------------------------------------------------------------

resource "azurerm_virtual_network" "main" {
  name                = "${var.name}-vnet"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = var.vnet_address_space

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Subnets
# -----------------------------------------------------------------------------

# Container Apps Environment requires a dedicated subnet with /23 minimum
resource "azurerm_subnet" "container_apps" {
  name                 = "${var.name}-container-apps-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.container_apps_subnet_cidr]

  delegation {
    name = "container-apps-delegation"

    service_delegation {
      name = "Microsoft.App/environments"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }
}

# PostgreSQL Flexible Server subnet
resource "azurerm_subnet" "database" {
  name                 = "${var.name}-database-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.database_subnet_cidr]

  delegation {
    name = "postgresql-delegation"

    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }

  service_endpoints = ["Microsoft.Storage"]
}

# Redis Cache subnet (for Premium tier with VNet integration)
resource "azurerm_subnet" "redis" {
  name                 = "${var.name}-redis-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.redis_subnet_cidr]
}

# Private endpoints subnet
resource "azurerm_subnet" "private_endpoints" {
  name                 = "${var.name}-private-endpoints-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.private_endpoints_subnet_cidr]

  private_endpoint_network_policies = "Disabled"
}

# -----------------------------------------------------------------------------
# Network Security Groups
# -----------------------------------------------------------------------------

resource "azurerm_network_security_group" "container_apps" {
  name                = "${var.name}-container-apps-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  # Allow HTTPS inbound
  security_rule {
    name                       = "AllowHTTPS"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # Allow HTTP for health probes
  security_rule {
    name                       = "AllowHTTP"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = local.common_tags
}

resource "azurerm_network_security_group" "database" {
  name                = "${var.name}-database-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  # Allow PostgreSQL from Container Apps subnet
  security_rule {
    name                       = "AllowPostgresFromContainerApps"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefix      = var.container_apps_subnet_cidr
    destination_address_prefix = "*"
  }

  # Deny all other inbound
  security_rule {
    name                       = "DenyAllInbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# NSG Associations
# -----------------------------------------------------------------------------

resource "azurerm_subnet_network_security_group_association" "container_apps" {
  subnet_id                 = azurerm_subnet.container_apps.id
  network_security_group_id = azurerm_network_security_group.container_apps.id
}

resource "azurerm_subnet_network_security_group_association" "database" {
  subnet_id                 = azurerm_subnet.database.id
  network_security_group_id = azurerm_network_security_group.database.id
}

# -----------------------------------------------------------------------------
# Private DNS Zones
# -----------------------------------------------------------------------------

resource "azurerm_private_dns_zone" "postgres" {
  name                = "privatelink.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name

  tags = local.common_tags
}

resource "azurerm_private_dns_zone" "redis" {
  name                = "privatelink.redis.cache.windows.net"
  resource_group_name = azurerm_resource_group.main.name

  tags = local.common_tags
}

resource "azurerm_private_dns_zone" "keyvault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = azurerm_resource_group.main.name

  tags = local.common_tags
}

resource "azurerm_private_dns_zone" "acr" {
  name                = "privatelink.azurecr.io"
  resource_group_name = azurerm_resource_group.main.name

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Private DNS Zone VNet Links
# -----------------------------------------------------------------------------

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${var.name}-postgres-dns-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false

  tags = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "redis" {
  name                  = "${var.name}-redis-dns-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.redis.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false

  tags = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "keyvault" {
  name                  = "${var.name}-keyvault-dns-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.keyvault.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false

  tags = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "acr" {
  name                  = "${var.name}-acr-dns-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.acr.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false

  tags = local.common_tags
}
