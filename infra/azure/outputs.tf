output "resource_group" {
  description = "Delete this group and the whole preview estate is gone."
  value       = azurerm_resource_group.preview.name
}

output "registry_login_server" {
  description = "Where preview images are pushed. Matches previewImage() in factory/src/azure.ts."
  value       = azurerm_container_registry.preview.login_server
}

output "container_apps_environment" {
  value = azurerm_container_app_environment.preview.name
}

output "preview_identity_id" {
  description = "Resource id of the identity previews pull with. Becomes AZURE_PREVIEW_IDENTITY."
  value       = azurerm_user_assigned_identity.preview.id
}

output "client_id" {
  description = "The app registration Actions signs in as. Not a secret; there is no secret."
  value       = azuread_application.factory.client_id
}

output "tenant_id" {
  value = data.azuread_client_config.current.tenant_id
}

output "github_variables_set" {
  description = "The repository variables Terraform owns. Changing one by hand will be reverted on the next apply."
  value       = sort(keys(local.factory_variables))
}

# A preview app's hostname is assigned by Azure at create time and is not known
# until a pull request raises one, so there is no URL to output here. The URL
# lands on the PR's Deployment and in its factory block instead.
