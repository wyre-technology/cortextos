terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Remote state: deferred to SP2b once we know which storage account / container
  # this lives in. For now state is local — fine for a single-operator bootstrap.
  # backend "azurerm" {}
}

provider "azurerm" {
  features {
    key_vault {
      # Block accidental destroy of vaults with content; we explicitly destroy
      # via `terraform destroy` only.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

# Cloudflare provider. The API token comes from the CLOUDFLARE_API_TOKEN env var
# (provider reads it automatically) — never hardcode or put it in tfvars.
# Token scopes required: Zone:DNS:Edit on wyre.ai + Account:Cloudflare Tunnel:Edit
# + Account:Access: Apps and Policies:Edit.
provider "cloudflare" {}

# All resources share this tag set. Each module file may add resource-specific
# tags via merge().
locals {
  common_tags = {
    project     = "cortextos"
    environment = var.environment
    managed_by  = "terraform"
    owner       = "wyre-technology"
  }

  # Resource name prefix: cortextos-prod-, cortextos-dev-, etc.
  name_prefix = "cortextos-${var.environment}"
}

resource "azurerm_resource_group" "main" {
  name     = "${local.name_prefix}-rg"
  location = var.location
  tags     = local.common_tags
}
