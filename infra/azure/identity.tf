# The credential GitHub Actions signs in with — and the point is that it is not
# a credential at all. There is no client secret anywhere in this file, in the
# state, or in the repository. Actions mints a short-lived OIDC token, Entra ID
# trusts it because of the federated credentials below, and exchanges it for an
# access token scoped to one resource group.

data "azuread_client_config" "current" {}

resource "azuread_application" "factory" {
  display_name = "factory-preview-${var.github_repository}"
  owners       = [data.azuread_client_config.current.object_id]

  description = "GitHub Actions OIDC for ${local.repository} preview environments. No secret; see infra/azure/."
}

resource "azuread_service_principal" "factory" {
  client_id = azuread_application.factory.client_id
  owners    = [data.azuread_client_config.current.object_id]
}

# One credential per token shape Actions will present. The subject is matched
# exactly — a token from any other repository, branch or event type does not
# match anything here and is refused.
locals {
  federated_subjects = {
    # build-setup.yml (labeled, synchronize) and build-teardown.yml (closed)
    # all run on pull_request events, which present this single subject
    # regardless of branch. This is the one that matters in normal operation.
    pull_request = "repo:${local.repository}:pull_request"

    # build-setup.yml's workflow_dispatch retry path, dispatched from the
    # default branch. See "A preview did not come up" in the runbook.
    main_branch = "repo:${local.repository}:ref:refs/heads/main"
  }
}

resource "azuread_application_federated_identity_credential" "factory" {
  for_each = local.federated_subjects

  application_id = azuread_application.factory.id
  display_name   = "github-${each.key}"
  description    = "GitHub Actions OIDC — ${each.value}"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = each.value
}

# Contributor on the resource group, and nothing wider.
#
# It covers both things CI does: create, update and delete Container Apps, and
# run `az acr build` (ACR Tasks needs Contributor on the registry, which is
# inherited from the group). What Contributor explicitly cannot do is create
# role assignments — which is why the pull identity above is granted AcrPull
# here, at build time, rather than by CI at deploy time.
resource "azurerm_role_assignment" "factory_contributor" {
  scope                = azurerm_resource_group.preview.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.factory.object_id
}

# Attaching a user-assigned identity to a Container App is an operation *on the
# identity*, so Contributor on the group is not enough on its own.
resource "azurerm_role_assignment" "factory_identity_operator" {
  scope                = azurerm_user_assigned_identity.preview.id
  role_definition_name = "Managed Identity Operator"
  principal_id         = azuread_service_principal.factory.object_id
}
