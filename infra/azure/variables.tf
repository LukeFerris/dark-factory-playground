variable "subscription_id" {
  description = "Azure subscription the previews are billed to."
  type        = string
}

variable "location" {
  description = "Azure region. Everything lives in one, including the registry."
  type        = string
  default     = "uksouth"
}

variable "resource_group_name" {
  description = "Holds every preview resource, so `az group delete` is a complete uninstall."
  type        = string
  default     = "rg-factory-preview"
}

# ACR names are globally unique across all of Azure, alphanumeric only, 5-50
# characters. A fixed default would collide with anyone else who ran this, so
# the default is empty and a random suffix is generated instead.
variable "registry_name" {
  description = "Container registry name. Leave empty to generate one."
  type        = string
  default     = ""

  validation {
    condition     = var.registry_name == "" || can(regex("^[a-zA-Z0-9]{5,50}$", var.registry_name))
    error_message = "An ACR name is 5-50 characters, letters and digits only — no hyphens."
  }
}

variable "environment_name" {
  description = "Container Apps environment. One environment holds every preview app."
  type        = string
  default     = "cae-factory"
}

variable "github_owner" {
  description = "GitHub user or organisation that owns the repository."
  type        = string
}

variable "github_repository" {
  description = "Repository name, without the owner."
  type        = string
  default     = "dark-factory-playground"
}

variable "preview_prefix" {
  description = "Prefixes each preview app name, keeping two factories in one environment apart."
  type        = string
  default     = "df"

  validation {
    # previewAppName() in factory/src/azure.ts builds `<prefix>-preview-pr-<n>`
    # and rejects anything that is not a legal Container App name. Catching it
    # here means finding out at plan time rather than after an image is built.
    condition     = can(regex("^[a-z][a-z0-9-]{0,10}[a-z0-9]$", var.preview_prefix))
    error_message = "The prefix must be lowercase, start with a letter, end alphanumeric, and be short."
  }
}

variable "log_retention_days" {
  description = "How long Container Apps console logs are kept. 30 is the Log Analytics minimum."
  type        = number
  default     = 30
}
