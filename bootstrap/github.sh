#!/usr/bin/env bash
#
# github.sh — configure the GitHub side of the factory.
#
# Idempotent: safe to re-run after changing a value in .env. Run with --dry-run
# first; every call that changes remote state goes through run(), so the dry run
# is a complete rehearsal.
#
# What it sets up:
#   · Actions permissions: read-only GITHUB_TOKEN, Actions may not approve PRs
#   · secrets   ANTHROPIC_API_KEY, JIRA_BOT_TOKEN, FACTORY_APP_KEY
#   · variables JIRA_BASE, JIRA_BOT_EMAIL, JIRA_PROJECT_KEY, FACTORY_APP_ID,
#               FACTORY_BOT_LOGIN
#   · the `preview` environment
#   · labels    factory:active, factory:design, factory:build
#   · rulesets  design/* and build/* writable only by the App
#               main requires a PR, one approval and the `ci` check, no bypass
#
# Usage:  bootstrap/github.sh [--dry-run]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=bootstrap/lib.sh
source "$ROOT/bootstrap/lib.sh"

if ! parse_common_args "$@"; then
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

cd "$ROOT"
load_env
assert_repo

if (( DRY_RUN )); then section "DRY RUN — nothing will be changed"; fi

require_env ANTHROPIC_API_KEY JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_PROJECT_KEY \
            FACTORY_APP_ID FACTORY_APP_KEY_PATH FACTORY_BOT_LOGIN

[[ -f "$FACTORY_APP_KEY_PATH" ]] \
  || die "No App private key at $FACTORY_APP_KEY_PATH. Download it at Checkpoint A."

section "Repository: $REPO_SLUG"
gh api "repos/$REPO_SLUG" --jq '"  \(.full_name) (\(.visibility))"' \
  || die "Cannot read $REPO_SLUG. Check gh auth status."

# ------------------------------------------------------- Actions permissions

section "Actions permissions"

# The default GITHUB_TOKEN must be read-only: everything that writes uses the
# App token instead, minted per step. And Actions must not be able to approve a
# pull request, or the factory could approve its own work.
run gh api -X PUT "repos/$REPO_SLUG/actions/permissions/workflow" \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false
ok "GITHUB_TOKEN is read-only; Actions cannot approve pull requests"

# --------------------------------------------------------- secrets and vars

section "Secrets"

# gh encrypts with the repository public key before sending; the plaintext never
# leaves this machine. Values come from .env and are never echoed.
set_secret() {
  local name="$1" value="$2"
  if (( DRY_RUN )); then
    info "would set secret $name (${#value} bytes)"
    return 0
  fi
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO_SLUG" --body -
  ok "$name"
}

set_secret ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
set_secret JIRA_BOT_TOKEN "$JIRA_TOKEN"
set_secret FACTORY_APP_KEY "$(cat "$FACTORY_APP_KEY_PATH")"

section "Variables"

set_var() {
  local name="$1" value="$2"
  run gh variable set "$name" --repo "$REPO_SLUG" --body "$value"
  (( DRY_RUN )) || ok "$name = $value"
}

set_var JIRA_BASE "$JIRA_BASE"
set_var JIRA_BOT_EMAIL "$JIRA_USER"
set_var JIRA_PROJECT_KEY "$JIRA_PROJECT_KEY"
set_var FACTORY_APP_ID "$FACTORY_APP_ID"
set_var FACTORY_BOT_LOGIN "$FACTORY_BOT_LOGIN"

# Set explicitly, though poller.yml defaults to the same numbers, so the two
# knobs show up in `gh variable list` instead of being buried in the workflow.
# A window just under the cron interval keeps a runner up nearly all the time;
# FACTORY_POLL_WINDOW_SECONDS=0 gives one pass per scheduled run instead.
set_var FACTORY_POLL_INTERVAL_SECONDS "${FACTORY_POLL_INTERVAL_SECONDS:-30}"
set_var FACTORY_POLL_WINDOW_SECONDS "${FACTORY_POLL_WINDOW_SECONDS:-270}"

# ------------------------------------------------------------- environment

section "Environments"

# The preview environment exists so Deployments have somewhere to land and so a
# reviewer can see the per-PR image from the PR page.
run gh api -X PUT "repos/$REPO_SLUG/environments/preview" --silent
ok "preview"

# ------------------------------------------------------------------ labels

section "Labels"

create_label() {
  run_ok_if_exists "$1" gh label create "$1" \
    --repo "$REPO_SLUG" --color "$2" --description "$3" --force
}

create_label 'factory:active' '0e8a16' 'Build turns may be granted on this PR'
create_label 'factory:design' '1d76db' 'Opened by the design stage'
create_label 'factory:build'  '5319e7' 'Opened by the build stage'

# ----------------------------------------------------------------- rulesets

section "Rulesets"

# Rulesets are matched by name, so re-running updates rather than duplicates.
upsert_ruleset() {
  local name="$1" payload="$2" id existing

  # Rulesets need GitHub Pro on a private repository, and the 403 that comes
  # back is a JSON body. Reading it with --jq would put that body where an id
  # belongs, so list first and check the call actually succeeded: a missing
  # ruleset is a normal state, an unreachable API is not.
  if ! existing="$(gh api "repos/$REPO_SLUG/rulesets" 2>&1)"; then
    die "cannot read rulesets on $REPO_SLUG: ${existing//$'\n'/ }
       Rulesets require GitHub Pro on a private repository, or a public one.
       Without them the App is not contained: nothing stops it pushing to main."
  fi
  id="$(printf '%s' "$existing" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id')"

  if [[ -n "$id" ]]; then
    if (( DRY_RUN )); then
      info "would update ruleset \"$name\" (id $id)"
    else
      printf '%s' "$payload" | gh api -X PUT "repos/$REPO_SLUG/rulesets/$id" --input - --silent
      ok "updated \"$name\""
    fi
  else
    if (( DRY_RUN )); then
      info "would create ruleset \"$name\""
    else
      printf '%s' "$payload" | gh api -X POST "repos/$REPO_SLUG/rulesets" --input - --silent
      ok "created \"$name\""
    fi
  fi
}

# Agent branches: nobody may create, update or delete them except the App. That
# is what stops a human accidentally pushing onto a branch mid-turn, and what
# stops anything other than the factory fabricating a build/* branch.
agent_branch_ruleset() {
  local name="$1" pattern="$2"
  jq -n \
    --arg name "$name" \
    --arg pattern "$pattern" \
    --argjson app_id "$FACTORY_APP_ID" \
    '{
      name: $name,
      target: "branch",
      enforcement: "active",
      bypass_actors: [
        { actor_id: $app_id, actor_type: "Integration", bypass_mode: "always" }
      ],
      conditions: { ref_name: { include: [$pattern], exclude: [] } },
      rules: [
        { type: "creation" },
        { type: "update" },
        { type: "deletion" },
        { type: "non_fast_forward" }
      ]
    }'
}

upsert_ruleset 'factory design branches' "$(agent_branch_ruleset 'factory design branches' 'refs/heads/design/*')"
upsert_ruleset 'factory build branches'  "$(agent_branch_ruleset 'factory build branches'  'refs/heads/build/*')"

# main: a pull request, one human approval, and a green `ci`. bypass_actors is
# empty on purpose — the App is not on it, so the factory cannot push to main,
# cannot approve, and cannot merge. That is the whole containment story in one
# API call, so do not add a bypass actor here without a very good reason.
main_ruleset() {
  jq -n '{
    name: "main protection",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash", "merge", "rebase"]
        }
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [ { context: "ci" } ]
        }
      }
    ]
  }'
}

upsert_ruleset 'main protection' "$(main_ruleset)"

section "Done"
if (( DRY_RUN )); then
  info "Dry run only. Re-run without --dry-run to apply."
else
  ok "GitHub is configured. Next: bootstrap/jira.sh, then bootstrap/smoke.sh."
fi
