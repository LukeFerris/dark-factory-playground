#!/usr/bin/env bash
#
# apply.sh — stand up the Azure preview estate and wire the repository to it.
#
# A thin wrapper around terraform, not a replacement for it. All it does is
# answer the three questions Terraform would otherwise have to be told twice:
# which subscription, which GitHub repository, and what token to talk to GitHub
# with. Everything else is in the .tf files.
#
# Defaults to `plan` — it shows you what it intends to do and changes nothing.
# Pass --apply to go ahead, or --destroy to take the whole estate down.
#
# Usage:  infra/azure/apply.sh [--apply | --destroy]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

ACTION=plan
for arg in "$@"; do
  case "$arg" in
    --apply)   ACTION=apply ;;
    --destroy) ACTION=destroy ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

command -v terraform >/dev/null || die "terraform is not installed."
command -v az >/dev/null        || die "the Azure CLI is not installed."
command -v gh >/dev/null        || die "the GitHub CLI is not installed."

# Reads one key out of .env WITHOUT sourcing it — .env is data, and sourcing a
# data file executes whatever happens to be in it.
env_value() {
  [ -f "$ROOT/.env" ] || return 0
  awk -v k="$1" 'index($0, k"=")==1 { print substr($0, length(k)+2); exit }' "$ROOT/.env"
}

# `az account show` fails on an expired refresh token as well as on no login at
# all, and the difference matters: one needs `az login`, the other needs
# `az login` too. Same instruction, so do not bother distinguishing them.
ACCOUNT="$(az account show -o json 2>/dev/null)" \
  || die "Azure CLI is not signed in (or the token expired). Run: az login"

SUBSCRIPTION_ID="${ARM_SUBSCRIPTION_ID:-$(printf '%s' "$ACCOUNT" | jq -r .id)}"
SUBSCRIPTION_NAME="$(printf '%s' "$ACCOUNT" | jq -r .name)"

OWNER="${GH_OWNER:-$(env_value GH_OWNER)}"
REPO="${GH_REPO:-$(env_value GH_REPO)}"
[ -n "$OWNER" ] || die "GH_OWNER is not set, in the environment or in .env"
[ -n "$REPO" ]  || die "GH_REPO is not set, in the environment or in .env"

# The github provider reads GITHUB_TOKEN. Taking it from `gh auth token` means
# no new credential is issued and nothing is written to disk — and it is
# scoped to whichever account `gh` is currently active as, which is the same
# account that has to own the repository.
GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}"
[ -n "$GITHUB_TOKEN" ] || die "No GitHub token. Run: gh auth login"
export GITHUB_TOKEN

gh repo view "$OWNER/$REPO" >/dev/null 2>&1 \
  || die "$OWNER/$REPO is not reachable with the active gh account ($(gh api user --jq .login))."

echo "subscription : $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"
echo "repository   : $OWNER/$REPO"
echo "action       : $ACTION"
echo

cd "$HERE"
[ -d .terraform ] || terraform init -input=false

# No -auto-approve: apply and destroy both stop and show you the plan first.
# This creates billable resources and, on destroy, deletes a registry full of
# images — neither should happen because a script was run with a typo in it.
terraform "$ACTION" \
  -var "subscription_id=$SUBSCRIPTION_ID" \
  -var "github_owner=$OWNER" \
  -var "github_repository=$REPO"
