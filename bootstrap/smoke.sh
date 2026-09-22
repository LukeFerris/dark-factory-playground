#!/usr/bin/env bash
#
# smoke.sh — check that what the bootstrap scripts configured is actually there.
#
# Read-only by default: it asserts, it does not create. Run it after
# github.sh and jira.sh, and again any time the factory starts misbehaving —
# most failures are a missing variable or a renamed status, and this names which.
#
# With --card it also files a real Jira card in "Ready for design" and leaves
# it for the poller, which is the only way to test the whole loop. That card is
# real work for a real agent; it is not cleaned up.
#
# Usage:  bootstrap/smoke.sh [--card]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=bootstrap/lib.sh
source "$ROOT/bootstrap/lib.sh"

CREATE_CARD=0
for arg in "$@"; do
  case "$arg" in
    --card) CREATE_CARD=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

cd "$ROOT"
load_env
assert_repo
require_env JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_PROJECT_KEY
JIRA_BASE="${JIRA_BASE%/}"

FAILURES=0
check() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "$what"
  else
    warn "$what"
    FAILURES=$((FAILURES + 1))
  fi
}

jira_get() {
  curl -sS -u "$JIRA_USER:$JIRA_TOKEN" -H 'Accept: application/json' --max-time 30 "$JIRA_BASE$1"
}

# --------------------------------------------------------------- GitHub side

section "GitHub — $REPO_SLUG"

check "repository is reachable" gh api "repos/$REPO_SLUG"

perms="$(gh api "repos/$REPO_SLUG/actions/permissions/workflow" 2>/dev/null || printf '{}')"
if [[ "$(printf '%s' "$perms" | jq -r '.default_workflow_permissions')" == "read" ]]; then
  ok "GITHUB_TOKEN is read-only"
else
  warn "GITHUB_TOKEN is NOT read-only — re-run bootstrap/github.sh"
  FAILURES=$((FAILURES + 1))
fi

if [[ "$(printf '%s' "$perms" | jq -r '.can_approve_pull_request_reviews')" == "false" ]]; then
  ok "Actions cannot approve pull requests"
else
  warn "Actions CAN approve pull requests — re-run bootstrap/github.sh"
  FAILURES=$((FAILURES + 1))
fi

have_secrets="$(gh api "repos/$REPO_SLUG/actions/secrets" --jq '[.secrets[].name]' 2>/dev/null || printf '[]')"
for name in ANTHROPIC_API_KEY JIRA_BOT_TOKEN FACTORY_APP_KEY; do
  if printf '%s' "$have_secrets" | jq -e --arg n "$name" 'index($n)' >/dev/null; then
    ok "secret $name"
  else
    warn "secret $name is missing"
    FAILURES=$((FAILURES + 1))
  fi
done

have_vars="$(gh api "repos/$REPO_SLUG/actions/variables" --jq '[.variables[].name]' 2>/dev/null || printf '[]')"
for name in JIRA_BASE JIRA_BOT_EMAIL JIRA_PROJECT_KEY FACTORY_APP_ID FACTORY_BOT_LOGIN; do
  if printf '%s' "$have_vars" | jq -e --arg n "$name" 'index($n)' >/dev/null; then
    ok "variable $name"
  else
    warn "variable $name is missing"
    FAILURES=$((FAILURES + 1))
  fi
done

have_labels="$(gh api "repos/$REPO_SLUG/labels" --jq '[.[].name]' 2>/dev/null || printf '[]')"
for name in 'factory:active' 'factory:design' 'factory:build'; do
  if printf '%s' "$have_labels" | jq -e --arg n "$name" 'index($n)' >/dev/null; then
    ok "label $name"
  else
    warn "label $name is missing"
    FAILURES=$((FAILURES + 1))
  fi
done

have_rules="$(gh api "repos/$REPO_SLUG/rulesets" --jq '[.[].name]' 2>/dev/null || printf '[]')"
for name in 'factory card branches' 'main protection'; do
  if printf '%s' "$have_rules" | jq -e --arg n "$name" 'index($n)' >/dev/null; then
    ok "ruleset \"$name\""
  else
    warn "ruleset \"$name\" is missing"
    FAILURES=$((FAILURES + 1))
  fi
done

# The one rule worth asserting in detail: nothing may bypass main.
main_bypass="$(gh api "repos/$REPO_SLUG/rulesets" \
  --jq '.[] | select(.name == "main protection") | .id' 2>/dev/null | head -1)"
if [[ -n "$main_bypass" ]]; then
  count="$(gh api "repos/$REPO_SLUG/rulesets/$main_bypass" --jq '.bypass_actors | length' 2>/dev/null || echo '?')"
  if [[ "$count" == "0" ]]; then
    ok "nothing can bypass main protection"
  else
    warn "main protection has $count bypass actor(s) — the factory must not be able to push to main"
    FAILURES=$((FAILURES + 1))
  fi
fi

have_workflows="$(gh api "repos/$REPO_SLUG/actions/workflows" --jq '[.workflows[].path]' 2>/dev/null || printf '[]')"
for wf in ci poller design build-start build-setup build-turn build-teardown; do
  if printf '%s' "$have_workflows" | jq -e --arg p ".github/workflows/$wf.yml" 'index($p)' >/dev/null; then
    ok "workflow $wf.yml is registered"
  else
    warn "workflow $wf.yml is not registered — has it been pushed to the default branch?"
    FAILURES=$((FAILURES + 1))
  fi
done

# ----------------------------------------------------------------- Jira side

section "Jira — $JIRA_BASE"

me="$(jira_get /rest/api/3/myself | jq -r '.displayName // empty')"
if [[ -n "$me" ]]; then
  ok "authenticated as $me"
else
  warn "cannot authenticate against $JIRA_BASE"
  FAILURES=$((FAILURES + 1))
fi

project="$(jira_get "/rest/api/3/project/$JIRA_PROJECT_KEY" | jq -r '.id // empty')"
if [[ -n "$project" ]]; then
  ok "project $JIRA_PROJECT_KEY exists (id $project)"
else
  warn "project $JIRA_PROJECT_KEY does not exist — run bootstrap/jira.sh"
  FAILURES=$((FAILURES + 1))
fi

# These names are the contract between Jira and factory/src/schema.ts. A typo
# here surfaces as JiraTransitionError on a turn that has already done its work.
all_statuses="$(jira_get '/rest/api/3/statuses/search?maxResults=200' | jq -r '[.values[]?.name]')"
for status in \
  'Backlog' 'Ready for design' 'Designing' 'Design review' 'Blocked on architect' \
  'Ready for build' 'Building' 'In review' 'Blocked on engineer' 'Done'
do
  if printf '%s' "$all_statuses" | jq -e --arg n "$status" 'index($n)' >/dev/null; then
    ok "status \"$status\""
  else
    warn "status \"$status\" is missing — factory/src/schema.ts expects it by name"
    FAILURES=$((FAILURES + 1))
  fi
done

fields="$(jira_get /rest/api/3/field | jq -r '[.[].name]')"
for field in 'Acceptance criteria' 'Design owner'; do
  if printf '%s' "$fields" | jq -e --arg n "$field" 'index($n)' >/dev/null; then
    ok "custom field \"$field\""
  else
    warn "custom field \"$field\" is missing"
    FAILURES=$((FAILURES + 1))
  fi
done

board_id="$(jira_get "/rest/agile/1.0/board?name=$(printf '%s' 'Dark Factory' | jq -sRr @uri)" \
  | jq -r '[.values[]?] | .[0].id // empty')"
if [[ -n "$board_id" ]]; then
  ok "board \"Dark Factory\" exists (id $board_id)"

  # Existing is not the same as reachable. A board with no project location is
  # a cross-project board: it works, but the project sidebar does not link to
  # it, so you end up on whichever board the project template made instead.
  board_project="$(jira_get "/rest/agile/1.0/board/$board_id" | jq -r '.location.projectKey // empty')"
  if [[ "$board_project" == "$JIRA_PROJECT_KEY" ]]; then
    ok "board is attached to $JIRA_PROJECT_KEY"
  else
    warn "board \"Dark Factory\" has no location on $JIRA_PROJECT_KEY, so it is hidden from the project sidebar. Re-run bootstrap/jira.sh."
    FAILURES=$((FAILURES + 1))
  fi

  mapped="$(jira_get "/rest/agile/1.0/board/$board_id/configuration" \
    | jq -r '[.columnConfig.columns[].statuses[]?] | length')"
  if [[ "${mapped:-0}" == "10" ]]; then
    ok "all ten statuses are mapped onto columns"
  else
    warn "only ${mapped:-0} of 10 statuses are mapped onto board columns; cards in the rest are invisible. See docs/factory/SETUP.md, Checkpoint D."
    FAILURES=$((FAILURES + 1))
  fi
else
  warn "board \"Dark Factory\" is missing"
  FAILURES=$((FAILURES + 1))
fi

# The project template creates its own board, and it is the one the sidebar
# links to. Not a failure — but it is the reason for landing on a board with
# none of these columns, so it is worth naming.
stray="$(jira_get "/rest/agile/1.0/board?projectKeyOrId=$JIRA_PROJECT_KEY" \
  | jq -r '.values[]? | select(.name != "Dark Factory") | "\(.id) \(.name)"')"
if [[ -n "$stray" ]]; then
  info "another board exists on $JIRA_PROJECT_KEY and is not the factory's: $(printf '%s' "$stray" | tr '\n' ';')"
fi

# ------------------------------------------------------------- optional card

if (( CREATE_CARD )); then
  section "Filing a live card"

  if (( FAILURES )); then
    die "Not filing a card while $FAILURES check(s) are failing — fix those first."
  fi

  payload="$(jq -n --arg k "$JIRA_PROJECT_KEY" '{
    fields: {
      project: { key: $k },
      issuetype: { name: "Task" },
      summary: "Smoke test: greet the user by name",
      description: {
        type: "doc", version: 1,
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "Let the user type their name into the example app and have the greeting use it. Keep it to one input and one greeting."
          }]
        }]
      }
    }
  }')"

  key="$(printf '%s' "$payload" | curl -sS \
    -X POST \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    --data-binary @- \
    "$JIRA_BASE/rest/api/3/issue" | jq -r '.key // empty')"

  [[ -n "$key" ]] || die "Could not create the card."
  ok "created $key"

  npm run --silent factory -- jira-transition "$key" 'Ready for design'
  ok "$key moved to Ready for design"

  info "The poller runs every ten minutes. To start it now:"
  info "  gh workflow run poller.yml --repo $REPO_SLUG"
  info "Then watch: gh run watch --repo $REPO_SLUG"
fi

# ---------------------------------------------------------------------- done

section "Result"
if (( FAILURES )); then
  die "$FAILURES check(s) failed. See docs/factory/RUNBOOK.md."
fi
ok "Everything the factory needs is in place."
