# =============================================================================
# MCP Gateway - Azure Container Apps Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# User Assigned Identity for Container Apps
# -----------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "container_apps" {
  name                = "${var.name}-identity"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Container Apps Environment
# -----------------------------------------------------------------------------

resource "azurerm_container_app_environment" "main" {
  name                           = "${var.name}-env"
  location                       = azurerm_resource_group.main.location
  resource_group_name            = azurerm_resource_group.main.name
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id       = azurerm_subnet.container_apps.id
  internal_load_balancer_enabled = false
  zone_redundancy_enabled        = false # Enable for production

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Registry Container App
# -----------------------------------------------------------------------------

resource "azurerm_container_app" "registry" {
  name                         = "${var.name}-registry"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.container_apps.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.container_apps.id
  }

  template {
    container {
      name   = "registry"
      image  = local.registry_image
      cpu    = var.registry_cpu
      memory = var.registry_memory

      # Environment variables
      env {
        name  = "REGISTRY_URL"
        value = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${azurerm_container_app.registry.latest_revision_fqdn}"
      }

      env {
        name  = "AUTH_SERVER_URL"
        value = "http://localhost:8888"
      }

      env {
        name  = "AUTH_SERVER_EXTERNAL_URL"
        value = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${azurerm_container_app.registry.latest_revision_fqdn}"
      }

      env {
        name        = "SECRET_KEY"
        secret_name = "secret-key"
      }

      env {
        name  = "ADMIN_USER"
        value = var.admin_user
      }

      env {
        name        = "ADMIN_PASSWORD"
        secret_name = "admin-password"
      }

      env {
        name        = "CREDENTIAL_MASTER_KEY"
        secret_name = "credential-master-key"
      }

      # Database configuration
      env {
        name        = "DATABASE_URL"
        secret_name = "postgres-connection-string"
      }

      # Redis configuration
      env {
        name        = "REDIS_URL"
        secret_name = "redis-connection-string"
      }

      # Storage backend
      env {
        name  = "STORAGE_BACKEND"
        value = var.storage_backend
      }

      # Session configuration
      env {
        name  = "SESSION_COOKIE_SECURE"
        value = tostring(var.session_cookie_secure)
      }

      env {
        name  = "SESSION_COOKIE_DOMAIN"
        value = var.session_cookie_domain
      }

      # Auth provider configuration
      env {
        name  = "AUTH_PROVIDER"
        value = var.auth_provider
      }

      env {
        name  = "ENTRA_ENABLED"
        value = var.auth_provider == "entra" ? "true" : "false"
      }

      env {
        name  = "ENTRA_TENANT_ID"
        value = var.entra_tenant_id
      }

      env {
        name  = "ENTRA_CLIENT_ID"
        value = var.entra_client_id
      }

      dynamic "env" {
        for_each = var.entra_client_secret != "" ? [1] : []
        content {
          name        = "ENTRA_CLIENT_SECRET"
          secret_name = "entra-client-secret"
        }
      }

      # Embeddings configuration
      env {
        name  = "EMBEDDINGS_PROVIDER"
        value = var.embeddings_provider
      }

      env {
        name  = "EMBEDDINGS_MODEL_NAME"
        value = var.embeddings_model_name
      }

      env {
        name  = "EMBEDDINGS_MODEL_DIMENSIONS"
        value = tostring(var.embeddings_model_dimensions)
      }

      # Security scanning
      env {
        name  = "SECURITY_SCAN_ENABLED"
        value = tostring(var.security_scan_enabled)
      }

      env {
        name  = "SECURITY_SCAN_ON_REGISTRATION"
        value = tostring(var.security_scan_on_registration)
      }

      env {
        name  = "SECURITY_BLOCK_UNSAFE_SERVERS"
        value = tostring(var.security_block_unsafe_servers)
      }

      env {
        name  = "SECURITY_ANALYZERS"
        value = var.security_analyzers
      }

      # Federation
      env {
        name  = "REGISTRY_ID"
        value = var.registry_id
      }

      env {
        name  = "FEDERATION_STATIC_TOKEN_AUTH_ENABLED"
        value = tostring(var.federation_static_token_auth_enabled)
      }

      # Health probe
      liveness_probe {
        transport = "HTTP"
        port      = 7860
        path      = "/health"

        initial_delay    = 30
        interval_seconds = 30
        timeout          = 10
        failure_count_threshold = 3
      }

      readiness_probe {
        transport = "HTTP"
        port      = 7860
        path      = "/health"

        interval_seconds = 10
        timeout          = 5
        failure_count_threshold = 3
      }
    }

    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    http_scale_rule {
      name                = "http-scaling"
      concurrent_requests = "100"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  secret {
    name                = "secret-key"
    key_vault_secret_id = azurerm_key_vault_secret.secret_key.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  secret {
    name                = "admin-password"
    key_vault_secret_id = azurerm_key_vault_secret.admin_password.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  secret {
    name                = "credential-master-key"
    key_vault_secret_id = azurerm_key_vault_secret.credential_master_key.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  secret {
    name                = "postgres-connection-string"
    key_vault_secret_id = azurerm_key_vault_secret.postgres_connection_string.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  secret {
    name                = "redis-connection-string"
    key_vault_secret_id = azurerm_key_vault_secret.redis_connection_string.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  dynamic "secret" {
    for_each = var.entra_client_secret != "" ? [1] : []
    content {
      name                = "entra-client-secret"
      key_vault_secret_id = azurerm_key_vault_secret.entra_client_secret[0].id
      identity            = azurerm_user_assigned_identity.container_apps.id
    }
  }

  tags = local.common_tags

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_key_vault_access_policy.container_apps,
    azurerm_postgresql_flexible_server_database.mcp_registry,
    azurerm_redis_cache.main,
  ]
}

# -----------------------------------------------------------------------------
# Auth Server Container App
# -----------------------------------------------------------------------------

resource "azurerm_container_app" "auth_server" {
  name                         = "${var.name}-auth-server"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.container_apps.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.container_apps.id
  }

  template {
    container {
      name   = "auth-server"
      image  = local.auth_server_image
      cpu    = var.auth_server_cpu
      memory = var.auth_server_memory

      env {
        name  = "REGISTRY_URL"
        value = local.custom_domain_enabled ? "https://${var.custom_domain}" : "https://${azurerm_container_app.registry.latest_revision_fqdn}"
      }

      env {
        name        = "SECRET_KEY"
        secret_name = "secret-key"
      }

      env {
        name  = "ADMIN_USER"
        value = var.admin_user
      }

      env {
        name        = "ADMIN_PASSWORD"
        secret_name = "admin-password"
      }

      # Storage backend
      env {
        name  = "STORAGE_BACKEND"
        value = var.storage_backend
      }

      # Database connection
      env {
        name        = "DATABASE_URL"
        secret_name = "postgres-connection-string"
      }

      # Auth provider configuration
      env {
        name  = "AUTH_PROVIDER"
        value = var.auth_provider
      }

      env {
        name  = "ENTRA_ENABLED"
        value = var.auth_provider == "entra" ? "true" : "false"
      }

      env {
        name  = "ENTRA_TENANT_ID"
        value = var.entra_tenant_id
      }

      env {
        name  = "ENTRA_CLIENT_ID"
        value = var.entra_client_id
      }

      dynamic "env" {
        for_each = var.entra_client_secret != "" ? [1] : []
        content {
          name        = "ENTRA_CLIENT_SECRET"
          secret_name = "entra-client-secret"
        }
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8888
        path      = "/health"

        initial_delay    = 10
        interval_seconds = 30
        timeout          = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport = "HTTP"
        port      = 8888
        path      = "/health"

        interval_seconds = 10
        timeout          = 5
        failure_count_threshold = 3
      }
    }

    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    http_scale_rule {
      name                = "http-scaling"
      concurrent_requests = "100"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8888
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  secret {
    name                = "secret-key"
    key_vault_secret_id = azurerm_key_vault_secret.secret_key.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  secret {
    name                = "admin-password"
    key_vault_secret_id = azurerm_key_vault_secret.admin_password.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  secret {
    name                = "postgres-connection-string"
    key_vault_secret_id = azurerm_key_vault_secret.postgres_connection_string.id
    identity            = azurerm_user_assigned_identity.container_apps.id
  }

  dynamic "secret" {
    for_each = var.entra_client_secret != "" ? [1] : []
    content {
      name                = "entra-client-secret"
      key_vault_secret_id = azurerm_key_vault_secret.entra_client_secret[0].id
      identity            = azurerm_user_assigned_identity.container_apps.id
    }
  }

  tags = local.common_tags

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_key_vault_access_policy.container_apps,
    azurerm_postgresql_flexible_server_database.mcp_registry,
  ]
}

# -----------------------------------------------------------------------------
# Custom Domain Configuration (optional)
# -----------------------------------------------------------------------------

resource "azurerm_container_app_custom_domain" "registry" {
  count                                      = local.custom_domain_enabled ? 1 : 0
  name                                       = var.custom_domain
  container_app_id                           = azurerm_container_app.registry.id
  container_app_environment_certificate_id   = var.custom_domain_certificate_id
  certificate_binding_type                   = "SniEnabled"
}
