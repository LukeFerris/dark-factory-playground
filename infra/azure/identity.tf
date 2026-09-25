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

# The subject prefix GitHub actually mints, which is not the one the docs lead
# you to write.
#
# The obvious form is `repo:<owner>/<repo>:…`. GitHub now defaults new
# repositories to *immutable* subjects instead, interpolating the numeric owner
# and repository ids: `repo:<owner>@<owner_id>/<repo>@<repo_id>:…`. Entra
# matches the subject as an exact string, so a credential written the obvious
# way matches nothing and every sign-in fails with AADSTS700213.
#
# Matching what is minted is also the better of the two. The names in a subject
# are re-registrable — rename the repository and whoever claims the old name
# inherits the trust. The ids are not, so the immutable form says "this exact
# repository" rather than "whatever currently answers to this name".
#
# Whether a repository does this is visible at
#   gh api repos/<owner>/<repo>/actions/oidc/customization/sub
# as `use_immutable_subject`. Read the ids from GitHub rather than pasting them
# so the two cannot drift.
data "github_repository" "factory" {
  full_name = local.repository
}

data "github_user" "owner" {
  username = var.github_owner
}

# One credential per token shape Actions will present. The subject is matched
# exactly — a token from any other repository, branch or event type does not
# match anything here and is refused.
locals {
  subject_prefix = "repo:${var.github_owner}@${data.github_user.owner.id}/${var.github_repository}@${data.github_repository.factory.repo_id}"

  federated_subjects = {
    # build-teardown.yml, which runs on `pull_request: closed`. Every
    # pull_request event presents this single subject regardless of branch.
    pull_request = "${local.subject_prefix}:pull_request"

    # Everything that raises a preview. build-start.yml and build-turn.yml
    # both deploy in a `preview` job of their own, and neither runs on a
    # pull_request event: build-start is a workflow_dispatch from the default
    # branch, and build-turn is either that or an issue_comment, which Actions
    # also runs against the default branch. build-setup.yml's manual retry is
    # the third. All three therefore present this subject and nothing else.
    #
    # This is the one that matters in normal operation. It used to be the
    # retry-only path, back when previews were raised by pull request events.
    main_branch = "${local.subject_prefix}:ref:refs/heads/main"
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
