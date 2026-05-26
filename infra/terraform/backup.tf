# Incremental disk snapshots created by Azure Backup land here, separate from
# the main RG so lifecycle and permissions are clearly scoped.
resource "azurerm_resource_group" "snapshots" {
  name     = "${local.name_prefix}-snapshots-rg"
  location = var.location
  tags     = merge(local.common_tags, { role = "disk-snapshots" })
}
