terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "azuread" {}

# Authenticates with GITHUB_TOKEN from the environment. `apply.sh` fills that
# from `gh auth token`, so there is no new credential to issue or store — the
# token is the one you are already logged in with.
provider "github" {
  owner = var.github_owner
}
