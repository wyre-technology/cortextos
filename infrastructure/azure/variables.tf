# =============================================================================
# MCP Gateway - Azure Container Apps Variables
# =============================================================================

# -----------------------------------------------------------------------------
# Basic Configuration
# -----------------------------------------------------------------------------

variable "name" {
  description = "Name of the deployment (used as prefix for all resources)"
  type        = string
  default     = "mcp-gateway"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name))
    error_message = "Name must be 3-20 characters, lowercase alphanumeric and hyphens, starting with a letter."
  }
}

variable "location" {
  description = "Azure region for deployment"
  type        = string
  default     = "eastus"
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    environment = "production"
    project     = "mcp-gateway"
  }
}

# -----------------------------------------------------------------------------
# Networking Configuration
# -----------------------------------------------------------------------------

variable "vnet_address_space" {
  description = "Address space for the Virtual Network"
  type        = list(string)
  default     = ["10.0.0.0/16"]
}

variable "container_apps_subnet_cidr" {
  description = "CIDR for Container Apps subnet (requires /23 minimum)"
  type        = string
  default     = "10.0.0.0/23"
}

variable "database_subnet_cidr" {
  description = "CIDR for PostgreSQL Flexible Server subnet"
  type        = string
  default     = "10.0.2.0/24"
}

variable "redis_subnet_cidr" {
  description = "CIDR for Redis Cache subnet"
  type        = string
  default     = "10.0.3.0/24"
}

variable "private_endpoints_subnet_cidr" {
  description = "CIDR for private endpoints subnet"
  type        = string
  default     = "10.0.4.0/24"
}

# -----------------------------------------------------------------------------
# Custom Domain Configuration
# -----------------------------------------------------------------------------

variable "custom_domain" {
  description = "Custom domain for the MCP Gateway (e.g., mcp.wyre.ai). Leave empty for Azure-provided domain."
  type        = string
  default     = ""
}

variable "custom_domain_certificate_id" {
  description = "ID of the managed certificate for custom domain (created separately or via DNS validation)"
  type        = string
  default     = ""
}

variable "dns_zone_resource_group" {
  description = "Resource group containing the Azure DNS zone (if using Azure DNS for custom domain)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Container Images
# -----------------------------------------------------------------------------

variable "registry_image_uri" {
  description = "Container image URI for the registry service"
  type        = string
  default     = ""
}

variable "auth_server_image_uri" {
  description = "Container image URI for the auth server service"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Container Apps Configuration
# -----------------------------------------------------------------------------

variable "registry_cpu" {
  description = "CPU cores for registry container (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)"
  type        = number
  default     = 1.0
}

variable "registry_memory" {
  description = "Memory for registry container in Gi"
  type        = string
  default     = "2Gi"
}

variable "auth_server_cpu" {
  description = "CPU cores for auth server container"
  type        = number
  default     = 0.5
}

variable "auth_server_memory" {
  description = "Memory for auth server container in Gi"
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Minimum number of replicas for Container Apps"
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum number of replicas for Container Apps"
  type        = number
  default     = 10
}

# -----------------------------------------------------------------------------
# PostgreSQL Configuration
# -----------------------------------------------------------------------------

variable "postgres_sku_name" {
  description = "SKU name for PostgreSQL Flexible Server (e.g., B_Standard_B1ms, GP_Standard_D2s_v3)"
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "Storage size for PostgreSQL in MB"
  type        = number
  default     = 32768 # 32GB
}

variable "postgres_version" {
  description = "PostgreSQL version"
  type        = string
  default     = "16"
}

variable "postgres_admin_username" {
  description = "PostgreSQL admin username"
  type        = string
  default     = "mcpadmin"
  sensitive   = true
}

variable "postgres_admin_password" {
  description = "PostgreSQL admin password (if not provided, a random password will be generated)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "postgres_database_name" {
  description = "Name of the PostgreSQL database"
  type        = string
  default     = "mcp_registry"
}

# -----------------------------------------------------------------------------
# Redis Configuration
# -----------------------------------------------------------------------------

variable "redis_sku_name" {
  description = "SKU name for Redis Cache (Basic, Standard, Premium)"
  type        = string
  default     = "Basic"
}

variable "redis_family" {
  description = "Redis family (C for Basic/Standard, P for Premium)"
  type        = string
  default     = "C"
}

variable "redis_capacity" {
  description = "Redis cache capacity (0-6 for Basic/Standard, 1-5 for Premium)"
  type        = number
  default     = 0
}

# -----------------------------------------------------------------------------
# Authentication Configuration
# -----------------------------------------------------------------------------

variable "auth_provider" {
  description = "Authentication provider: 'keycloak', 'entra', 'cognito'"
  type        = string
  default     = "entra"

  validation {
    condition     = contains(["keycloak", "entra", "cognito"], var.auth_provider)
    error_message = "Auth provider must be one of: keycloak, entra, cognito."
  }
}

variable "entra_tenant_id" {
  description = "Azure AD (Entra ID) Tenant ID"
  type        = string
  default     = ""
}

variable "entra_client_id" {
  description = "Azure AD (Entra ID) Application Client ID"
  type        = string
  default     = ""
}

variable "entra_client_secret" {
  description = "Azure AD (Entra ID) Application Client Secret"
  type        = string
  default     = ""
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Security Configuration
# -----------------------------------------------------------------------------

variable "secret_key" {
  description = "Secret key for JWT signing (if not provided, a random key will be generated)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_user" {
  description = "Admin username for the registry"
  type        = string
  default     = "admin"
}

variable "admin_password" {
  description = "Admin password for the registry (if not provided, a random password will be generated)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "credential_master_key" {
  description = "Master key for credential encryption (if not provided, a random key will be generated)"
  type        = string
  default     = ""
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Session Cookie Configuration
# -----------------------------------------------------------------------------

variable "session_cookie_secure" {
  description = "Enable secure flag on session cookies (HTTPS-only)"
  type        = bool
  default     = true
}

variable "session_cookie_domain" {
  description = "Domain for session cookies (e.g., '.wyre.ai' for cross-subdomain)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Storage Backend Configuration
# -----------------------------------------------------------------------------

variable "storage_backend" {
  description = "Storage backend: 'mongodb-ce' (Cosmos DB with MongoDB API) or 'documentdb' (Cosmos DB)"
  type        = string
  default     = "mongodb-ce"

  validation {
    condition     = contains(["mongodb-ce", "documentdb"], var.storage_backend)
    error_message = "Storage backend must be either 'mongodb-ce' or 'documentdb'."
  }
}

# -----------------------------------------------------------------------------
# Embeddings Configuration
# -----------------------------------------------------------------------------

variable "embeddings_provider" {
  description = "Embeddings provider: 'sentence-transformers' or 'litellm'"
  type        = string
  default     = "sentence-transformers"
}

variable "embeddings_model_name" {
  description = "Name of the embeddings model"
  type        = string
  default     = "all-MiniLM-L6-v2"
}

variable "embeddings_model_dimensions" {
  description = "Dimension of the embeddings model"
  type        = number
  default     = 384
}

# -----------------------------------------------------------------------------
# Security Scanning Configuration
# -----------------------------------------------------------------------------

variable "security_scan_enabled" {
  description = "Enable security scanning for MCP servers"
  type        = bool
  default     = true
}

variable "security_scan_on_registration" {
  description = "Automatically scan servers on registration"
  type        = bool
  default     = true
}

variable "security_block_unsafe_servers" {
  description = "Block servers that fail security scans"
  type        = bool
  default     = true
}

variable "security_analyzers" {
  description = "Security analyzers to use (comma-separated: yara, llm, api)"
  type        = string
  default     = "yara"
}

# -----------------------------------------------------------------------------
# Federation Configuration
# -----------------------------------------------------------------------------

variable "registry_id" {
  description = "Unique identifier for this registry in federation"
  type        = string
  default     = ""
}

variable "federation_static_token_auth_enabled" {
  description = "Enable static token auth for federation endpoints"
  type        = bool
  default     = false
}

variable "federation_static_token" {
  description = "Static token for federation API access"
  type        = string
  default     = ""
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Monitoring Configuration
# -----------------------------------------------------------------------------

variable "enable_monitoring" {
  description = "Enable Application Insights and monitoring"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Number of days to retain logs in Log Analytics"
  type        = number
  default     = 30
}

variable "alert_email" {
  description = "Email address for alert notifications"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Branding Configuration
# -----------------------------------------------------------------------------

variable "brand_name" {
  description = "Brand name displayed in the platform UI and notifications"
  type        = string
  default     = "Wyre Technology"
}

variable "domain" {
  description = "Primary domain for the platform (e.g., mcp.wyretechnology.com)"
  type        = string
}

# -----------------------------------------------------------------------------
# Feature Flags
# -----------------------------------------------------------------------------

variable "feature_dashboard" {
  description = "Enable the dashboard feature"
  type        = bool
  default     = true
}

variable "feature_prompt_capture" {
  description = "Enable the prompt capture feature"
  type        = bool
  default     = true
}
