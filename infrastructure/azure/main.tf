# MCP Gateway Registry - Azure Container Apps Deployment
# This Terraform configuration deploys the MCP Gateway to Azure Container Apps

terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.90.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 2.47.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }

  # Remote state configuration - uncomment and configure for production
  # backend "azurerm" {
  #   resource_group_name  = "tfstate-rg"
  #   storage_account_name = "tfstatemcpgateway"
  #   container_name       = "tfstate"
  #   key                  = "mcp-gateway.tfstate"
  # }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "azuread" {}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "azurerm_client_config" "current" {}

data "azuread_client_config" "current" {}

# -----------------------------------------------------------------------------
# Resource Group
# -----------------------------------------------------------------------------

resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Random String for Unique Names
# -----------------------------------------------------------------------------

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

# -----------------------------------------------------------------------------
# Locals
# -----------------------------------------------------------------------------

locals {
  resource_suffix = random_string.suffix.result

  # Container image tags
  registry_image = var.registry_image_uri != "" ? var.registry_image_uri : "mcpgateway/registry:latest"
  auth_server_image = var.auth_server_image_uri != "" ? var.auth_server_image_uri : "mcpgateway/auth-server:latest"

  # Domain configuration
  custom_domain_enabled = var.custom_domain != ""

  # Common tags
  common_tags = merge(var.tags, {
    "managed-by" = "terraform"
    "project"    = "mcp-gateway"
  })
}
