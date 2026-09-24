# Wiring the repository up.
#
# Every value here is read off the Azure resource that Terraform just made, so
# AZURE_CLIENT_ID cannot drift from the app registration it names. That is the
# whole reason these live in Terraform rather than in a `gh variable set`
# script: the two halves cannot get out of step.
#
# All variables, no secrets. OIDC means there is nothing long-lived to store,
# and a repository variable is readable by anyone who can read the repository —
# which is correct for these, since a client id and a tenant id are not secret.

locals {
  factory_variables = {
    FACTORY_PREVIEW_BACKEND = "azure"

    AZURE_CLIENT_ID       = azuread_application.factory.client_id
    AZURE_TENANT_ID       = data.azuread_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID = var.subscription_id

    AZURE_RESOURCE_GROUP            = azurerm_resource_group.preview.name
    AZURE_ACR_NAME                  = azurerm_container_registry.preview.name
    AZURE_CONTAINERAPPS_ENVIRONMENT = azurerm_container_app_environment.preview.name
    AZURE_PREVIEW_REPOSITORY        = var.github_repository
    AZURE_PREVIEW_PREFIX            = var.preview_prefix
    AZURE_PREVIEW_IDENTITY          = azurerm_user_assigned_identity.preview.id
  }
}

resource "github_actions_variable" "factory" {
  for_each = local.factory_variables

  repository    = var.github_repository
  variable_name = each.key
  value         = each.value
}
