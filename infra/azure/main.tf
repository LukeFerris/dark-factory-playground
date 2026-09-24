# The preview estate: everything a pull request needs to become a running site,
# and nothing else. One resource group, so `az group delete` is a complete
# uninstall.
#
# What is deliberately NOT here: the preview apps themselves. Those are created
# per pull request by `factory preview-up` and destroyed by `factory
# preview-down`, because their lifecycle is a PR's, not an estate's. Terraform
# owns the things that outlive any one card.

locals {
  # ACR names must be globally unique and allow no hyphens. Deriving the suffix
  # from the subscription id rather than random_string keeps the name stable
  # across re-runs and state rebuilds — a new name would orphan every image.
  # coalesce() skips empty strings as well as nulls, so an unset variable falls
  # through to the generated name.
  registry_name = coalesce(var.registry_name, "acrfactory${substr(sha1(var.subscription_id), 0, 8)}")

  repository = "${var.github_owner}/${var.github_repository}"
}

resource "azurerm_resource_group" "preview" {
  name     = var.resource_group_name
  location = var.location
}

# Basic is the cheapest tier that supports ACR Tasks, which is what `az acr
# build` uses. admin_enabled stays false: the pull is by managed identity, so
# there is no registry username and password to leak.
resource "azurerm_container_registry" "preview" {
  name                = local.registry_name
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  sku                 = "Basic"
  admin_enabled       = false
}

# Container Apps can run without a log destination, but then a preview that
# fails to start says nothing about why. This is the cheapest way to be able to
# answer "the page is blank, what happened".
resource "azurerm_log_analytics_workspace" "preview" {
  name                = "log-factory-preview"
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
}

resource "azurerm_container_app_environment" "preview" {
  name                       = var.environment_name
  resource_group_name        = azurerm_resource_group.preview.name
  location                   = azurerm_resource_group.preview.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.preview.id
}

# The identity each preview app pulls its image with.
#
# The alternative is `--registry-identity system`, where Azure creates the
# app's identity at create time and then has to grant it AcrPull — which means
# the CI principal must itself be able to create role assignments, i.e. hold
# User Access Administrator. Granting AcrPull once, here, to an identity that
# already exists keeps that power out of CI entirely.
resource "azurerm_user_assigned_identity" "preview" {
  name                = "uami-factory-preview"
  resource_group_name = azurerm_resource_group.preview.name
  location            = azurerm_resource_group.preview.location
}

resource "azurerm_role_assignment" "preview_pull" {
  scope                = azurerm_container_registry.preview.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.preview.principal_id
}
