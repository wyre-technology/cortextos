# Incremental disk snapshots created by Azure Backup land here, separate from
# the main RG so lifecycle and permissions are clearly scoped.
resource "azurerm_resource_group" "snapshots" {
  name     = "${local.name_prefix}-snapshots-rg"
  location = var.location
  tags     = merge(local.common_tags, { role = "disk-snapshots" })
}

resource "azurerm_data_protection_backup_vault" "main" {
  name                = "${local.name_prefix}-bvault"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  datastore_type      = "VaultStore"
  redundancy          = "LocallyRedundant"

  identity {
    type = "SystemAssigned"
  }

  tags = local.common_tags
}

resource "azurerm_data_protection_backup_policy_disk" "daily" {
  name     = "${local.name_prefix}-disk-daily"
  vault_id = azurerm_data_protection_backup_vault.main.id

  # Daily snapshot at the configured time.
  backup_repeating_time_intervals = ["R/${var.backup_time_utc}/P1D"]
  default_retention_duration      = "P${var.backup_retention_days}D"

  # Snapshots are created in the snapshot RG.
  time_zone = "UTC"
}
