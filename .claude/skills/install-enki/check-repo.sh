#!/usr/bin/env bash
#
# check-repo.sh OWNER/REPO — read-only: what the repository has of what Enki
# needs on GitHub, one line each.
#
#   ok       there, and as Enki needs it
#   MISSING  not there
#   WRONG    there, but not as Enki needs it
#   SEE      can't be read from here; the line says what to check
#
# It only reads. Run it with the human's own gh login, without switching the
# active account:  GH_TOKEN=$(gh auth token -u <account>) check-repo.sh OWNER/REPO
# Secrets are write-only, so "ok" for a secret means one of that name exists,
# not that it holds the right value. The first poller run proves the values.

set -uo pipefail

R="${1:?usage: check-repo.sh OWNER/REPO}"

say() { printf '%-8s %-34s %s\n' "$1" "$2" "${3:-}"; }
# gh prints an error's JSON body to stdout, so a failed call returns nothing.
api() { local out; out="$(gh api "$@" 2>/dev/null)" || return 1; printf '%s\n' "$out"; }

repo="$(api "repos/$R")" || { say MISSING "$R" "can't read the repository with this login"; exit 1; }
branch="$(jq -r .default_branch <<<"$repo")"
admin="$(jq -r .permissions.admin <<<"$repo")"
say ok repository "$(jq -r '"\(.full_name), \(.visibility), default branch \(.default_branch)"' <<<"$repo")"
[[ "$admin" == true ]] && say ok "admin rights" "this login can change the settings below" \
  || say WRONG "admin rights" "this login can't change settings; the apply stage needs a repo admin"

# ---------------------------------------------------------------- secrets
names() { api "$1" --paginate --jq ".$2[].name" | sort -u; }
repo_secrets="$(names "repos/$R/actions/secrets" secrets)"
org_secrets="$(names "repos/$R/actions/organization-secrets" secrets)"
repo_vars="$(names "repos/$R/actions/variables" variables)"
org_vars="$(names "repos/$R/actions/organization-variables" variables)"
has() { grep -qx "$1" <<<"$2"; }

for s in ANTHROPIC_API_KEY JIRA_BOT_TOKEN FACTORY_APP_KEY; do
  if has "$s" "$repo_secrets"; then say ok "secret $s"
  elif has "$s" "$org_secrets"; then say ok "secret $s" "from the organization"
  else say MISSING "secret $s"; fi
done

# --------------------------------------------------------------- variables
# Enki reads these as variables (vars.X). A secret of the same name is
# invisible to it.
for v in JIRA_BASE JIRA_BOT_EMAIL JIRA_PROJECT_KEY FACTORY_APP_ID FACTORY_BOT_LOGIN; do
  if has "$v" "$repo_vars"; then say ok "variable $v" "$(api "repos/$R/actions/variables/$v" --jq .value)"
  elif has "$v" "$org_vars"; then say ok "variable $v" "from the organization"
  elif has "$v" "$repo_secrets"; then say WRONG "variable $v" "set as a secret; Enki reads it as a variable"
  else say MISSING "variable $v"; fi
done

backend="$(api "repos/$R/actions/variables/FACTORY_PREVIEW_BACKEND" --jq .value)"
if [[ "$backend" == azure ]]; then
  say ok "previews on Container Apps" "FACTORY_PREVIEW_BACKEND=azure"
  for v in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP AZURE_ACR_NAME \
           AZURE_CONTAINERAPPS_ENVIRONMENT AZURE_PREVIEW_IDENTITY AZURE_PREVIEW_PREFIX \
           AZURE_PREVIEW_REPOSITORY AZURE_PREVIEW_LAUNCHER; do
    has "$v" "$repo_vars" || say MISSING "variable $v" "Terraform in infra/azure sets it"
  done
else
  say MISSING "previews on Container Apps" "FACTORY_PREVIEW_BACKEND is '${backend:-unset}', not azure"
fi

# ------------------------------------------------------------- Actions
perms="$(api "repos/$R/actions/permissions/workflow")"
[[ "$(jq -r .default_workflow_permissions <<<"$perms")" == read ]] \
  && say ok "GITHUB_TOKEN read-only" || say WRONG "GITHUB_TOKEN read-only" "default token can write"
[[ "$(jq -r .can_approve_pull_request_reviews <<<"$perms")" == false ]] \
  && say ok "Actions can't approve PRs" || say WRONG "Actions can't approve PRs" "Actions may approve PRs"

# ---------------------------------------------------------------- main
# Classic branch protection and rulesets both count; GitHub applies both.
prot="$(api "repos/$R/branches/$branch/protection" || echo '{}')"
rules="$(api "repos/$R/rules/branches/$branch" || echo '[]')"
approvals="$( { jq -r '.required_pull_request_reviews.required_approving_review_count // 0' <<<"$prot";
               jq -r '.[] | select(.type=="pull_request") | .parameters.required_approving_review_count' <<<"$rules"; } | sort -n | tail -1)"
(( ${approvals:-0} >= 1 )) && say ok "$branch needs an approval" "$approvals" \
  || say WRONG "$branch needs an approval" "a PR can merge unreviewed"
checks="$( { jq -r '.required_status_checks.contexts[]?' <<<"$prot";
             jq -r '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' <<<"$rules"; } | sort -u)"
if [[ -n "$checks" ]]; then say SEE "$branch required checks" "$(paste -sd, - <<<"$checks"). Are the repo's own tests among them?"
else say WRONG "$branch required checks" "none: a PR can merge with failing tests"; fi
# A bypass actor on a ruleset that covers the default branch can merge without
# review. The card/* ruleset's App bypass is expected and isn't counted.
bypass="$(api "repos/$R/rulesets" --jq '.[].id' | while read -r id; do
  # The --jq of gh takes no --arg, so the branch goes into the filter itself.
  api "repos/$R/rulesets/$id" --jq "select((.bypass_actors // []) | length > 0)
    | select([.conditions.ref_name.include[]?] | any(. == \"~DEFAULT_BRANCH\" or . == \"~ALL\" or . == \"refs/heads/$branch\"))
    | .name"
done)"
[[ -z "$bypass" ]] && say ok "nobody bypasses $branch rules" \
  || say WRONG "nobody bypasses $branch rules" "bypass actors on: $(paste -sd, - <<<"$bypass")"

# ----------------------------------------------------- card/* branches
card="$(api "repos/$R/rulesets" --jq '.[].id' | while read -r id; do
  api "repos/$R/rulesets/$id" --jq 'select(.conditions.ref_name.include[]? == "refs/heads/card/*") | .name'; done)"
[[ -n "$card" ]] && say ok "card/* locked to the App" "ruleset: $card" || say MISSING "card/* locked to the App"

# ------------------------------------------------- environment, labels
api "repos/$R/environments/preview" >/dev/null && say ok "environment preview" || say MISSING "environment preview"
labels="$(api "repos/$R/labels" --paginate --jq '.[].name')"
for l in factory:active factory:design factory:build; do
  has "$l" "$labels" && say ok "label $l" || say MISSING "label $l"
done

# ------------------------------------------------------------ the code
file() { api "repos/$R/contents/$1?ref=$branch" >/dev/null; }
missing_wf=()
for w in poller design build-start build-turn build-comment build-setup build-teardown stop refresh production; do
  file ".github/workflows/$w.yml" || missing_wf+=("$w.yml")
done
(( ${#missing_wf[@]} == 0 )) && say ok "Enki's workflows" || say MISSING "Enki's workflows" "${missing_wf[*]}"
file factory/src/statuses.ts && say ok "factory reads pinned ids" || say MISSING "factory reads pinned ids" "factory/src/statuses.ts"
pinned="$(api "repos/$R/contents/enki.json?ref=$branch" --jq .content | base64 -d 2>/dev/null | jq -r '.jira.statuses | length' 2>/dev/null)"
[[ "$pinned" == 10 ]] && say ok "enki.json status ids" || say MISSING "enki.json status ids"
dockerfiles="$(api "repos/$R/git/trees/$branch?recursive=1" --jq '.tree[].path | select(test("(^|/)Dockerfile$"))' | paste -sd, -)"
[[ -n "$dockerfiles" ]] && say ok Dockerfile "$dockerfiles" || say MISSING Dockerfile "Container Apps previews build from one"

# ------------------------------------------------------------- the App
# A private App can't be looked up by anyone but itself, so this only shows the
# bot user exists. Whether the App is installed here, with the permissions in
# docs/factory/SETUP.md (Checkpoint A), is for the human or an org owner to
# confirm, until the first poller run mints a token with it.
login="$(api "repos/$R/actions/variables/FACTORY_BOT_LOGIN" --jq .value)"
if [[ -z "$login" ]]; then
  say SEE "GitHub App" "FACTORY_BOT_LOGIN isn't a variable, so the App can't be named. Ask for its slug"
elif bot="$(api "users/${login//\[/%5B}" --jq .id)"; then
  say SEE "GitHub App" "bot $login exists (user id $bot). Confirm it is installed on $R"
else
  say WRONG "GitHub App" "no bot user called $login"
fi
