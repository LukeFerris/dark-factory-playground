# The launcher: the one page in this estate that is always awake.
#
# Preview apps scale to zero, and Container Apps does not answer a request to a
# sleeping app — it *holds* it while a replica starts. Measured on a real cold
# start: TLS completed in 81ms, then 22.4 seconds of silence, then a 200. To the
# person who clicked the link that is a blank tab for half a minute, which reads
# as a broken deployment rather than a cold one.
#
# Nothing the preview serves can cover that gap, because the preview is the
# thing that is asleep. So the page that says "waking it up" has to come from
# somewhere that never sleeps and costs almost nothing to leave running. A
# storage account's static website is exactly that: no compute, no deployment
# token, pennies a month for a few kilobytes — and it sits in the same resource
# group, so `az group delete` is still a complete uninstall.
#
# The page itself is infra/azure/launcher/index.html, uploaded from here. It
# takes the real preview URL in `?u=` and redirects as soon as the app answers.

locals {
  # Storage account names are globally unique, 3-24 characters, lowercase
  # letters and digits only — no hyphens. Same trick as the registry: derive the
  # suffix from the subscription id rather than random_string, so the name is
  # stable across state rebuilds instead of orphaning the old account.
  launcher_account_name = coalesce(
    var.launcher_account_name,
    "stfactory${substr(sha1(var.subscription_id), 0, 8)}",
  )
}

# NOTE ON STATE: creating a storage account puts its access keys in the
# Terraform state, and the blob below is uploaded with one. That is the single
# secret in an estate otherwise built entirely on OIDC, so it is worth being
# precise about what it can do: write to the `$web` container of this account,
# which holds one HTML file whose entire content is public by design. It cannot
# read a preview, touch the registry, or sign in to anything. The state is local
# and gitignored (see .gitignore); if that stops being true, this is the thing
# that matters. The alternative — keys disabled and a Microsoft Entra data-plane
# role — needs a role assignment created in the same apply that uses it, and
# role assignments take a minute to propagate, so the first apply would fail.
resource "azurerm_storage_account" "launcher" {
  name                     = local.launcher_account_name
  resource_group_name      = azurerm_resource_group.preview.name
  location                 = azurerm_resource_group.preview.location
  account_tier             = "Standard"
  account_kind             = "StorageV2"
  account_replication_type = "LRS"

  https_traffic_only_enabled = true
  min_tls_version            = "TLS1_2"

  # This governs the *blob* endpoint, where nothing here should be readable
  # without credentials. It does not affect the static website endpoint: per
  # Microsoft's documentation, "the $web container is always publicly
  # accessible", which is the whole point of the launcher.
  allow_nested_items_to_be_public = false
}

resource "azurerm_storage_account_static_website" "launcher" {
  storage_account_id = azurerm_storage_account.launcher.id
  index_document     = "index.html"

  # Anything under the launcher's host is the launcher. There is only one page,
  # and a mistyped path should still explain itself rather than show Azure's
  # XML 404.
  error_404_document = "index.html"
}

resource "azurerm_storage_blob" "launcher" {
  name = "index.html"

  # The resource id of the container static website hosting creates. Composed
  # rather than referenced because `$web` is made by Azure, not by Terraform,
  # so there is no azurerm_storage_container resource to point at. It is the ARM
  # id the provider wants here, not the data-plane URL the field name suggests —
  # handing it `https://<account>.blob.core.windows.net/$web` fails the apply
  # with "the number of segments didn't match".
  storage_container_id = "${azurerm_storage_account.launcher.id}/blobServices/default/containers/$web"

  type         = "Block"
  content_type = "text/html; charset=utf-8"

  # Inline rather than uploaded from a path so the plan shows the diff when the
  # page changes — this is the only resource here whose *content* is reviewable.
  source_content = file("${path.module}/launcher/index.html")

  # An edited page has to reach people on the next click, not whenever the
  # browser feels like it. A few kilobytes fetched every time costs nothing.
  cache_control = "no-cache, max-age=0"

  # $web does not exist until static website hosting is switched on.
  depends_on = [azurerm_storage_account_static_website.launcher]
}
