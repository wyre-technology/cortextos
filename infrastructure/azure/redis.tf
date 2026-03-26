# =============================================================================
# MCP Gateway - Azure Cache for Redis Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# Redis Cache
# -----------------------------------------------------------------------------

resource "azurerm_redis_cache" "main" {
  name                          = "${var.name}-redis-${local.resource_suffix}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  capacity                      = var.redis_capacity
  family                        = var.redis_family
  sku_name                      = var.redis_sku_name
  non_ssl_port_enabled          = false
  minimum_tls_version           = "1.2"
  public_network_access_enabled = false

  redis_configuration {
    # Enable RDB persistence for Basic/Standard SKUs
    rdb_backup_enabled = var.redis_sku_name == "Premium" ? true : false

    # Memory management
    maxmemory_policy = "volatile-lru"

    # Disable AOF for better performance (use RDB for persistence)
    aof_backup_enabled = false
  }

  # Patch schedule for maintenance
  patch_schedule {
    day_of_week    = "Sunday"
    start_hour_utc = 2
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Private Endpoint for Redis
# -----------------------------------------------------------------------------

resource "azurerm_private_endpoint" "redis" {
  name                = "${var.name}-redis-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id

  private_service_connection {
    name                           = "${var.name}-redis-psc"
    private_connection_resource_id = azurerm_redis_cache.main.id
    subresource_names              = ["redisCache"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis.id]
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Redis Firewall Rules (only for Premium tier with VNet)
# -----------------------------------------------------------------------------

# Note: For Basic and Standard tiers, private endpoints provide network isolation.
# Premium tier can additionally use firewall rules and VNet integration.
