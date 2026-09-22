#!/usr/bin/env bash
#
# jira.sh — configure the Jira side of the factory.
#
# Creates (or reuses) a company-managed Kanban project, the ten factory
# statuses, the Factory workflow and scheme, the two custom fields, and a filter
# and board over the project.
#
# Idempotent: every step looks for what it needs before creating it, so a
# re-run after a partial failure picks up where it stopped.
#
# NOTE ON VERIFICATION: every endpoint below has been checked against
# Atlassian's published OpenAPI spec (swagger-v3.v3.json) — each one exists, is
# undeprecated, and the request bodies carry every field the schema marks
# required. That sweep found and fixed two real defects; see the 2026-09-21
# entries in docs/factory/CHANGELOG.md.
#
# That is schema conformance, NOT a live run. None of this has touched a real
# Jira site — that needs the Checkpoint B credentials. Run --dry-run first and
# read the payloads it prints. If the API rejects one, fix it here and record
# the correction in docs/factory/CHANGELOG.md rather than patching around it.
#
# Usage:  bootstrap/jira.sh [--dry-run]

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
require_env JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_PROJECT_KEY

JIRA_BASE="${JIRA_BASE%/}"

if (( DRY_RUN )); then section "DRY RUN — nothing will be changed"; fi

# ---------------------------------------------------------------- API helper

# Every call goes through here so a failure shows Jira's own error body rather
# than an empty string. Read calls always run, including under --dry-run —
# knowing what already exists is what makes the rehearsal meaningful.
jira_get() {
  local path="$1" body status
  body="$(curl -sS -w '\n%{http_code}' \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' \
    --max-time 30 \
    "$JIRA_BASE$path")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$status" == 401 || "$status" == 403 ]]; then
    die "Jira rejected the credentials ($status). Check JIRA_USER and JIRA_TOKEN."
  fi
  if [[ "$status" -ge 400 ]]; then
    printf '%s' '{}'
    return 0
  fi
  printf '%s' "$body"
}

jira_write() {
  local method="$1" path="$2" payload="$3" body status

  if (( DRY_RUN )); then
    # Callers capture this function's stdout and pipe it to jq, so the
    # rehearsal log has to go to stderr. It is still on the terminal; it just
    # is not mistaken for the response body.
    printf '  %s %s %s\n' "$(_colour 90 'would call:')" "$method" "$path" >&2
    printf '%s\n' "$payload" | jq . | sed 's/^/      /' >&2
    printf '%s' '{}'
    return 0
  fi

  body="$(printf '%s' "$payload" | curl -sS -w '\n%{http_code}' \
    -X "$method" \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    --max-time 60 \
    --data-binary @- \
    "$JIRA_BASE$path")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"

  if [[ "$status" -ge 400 ]]; then
    warn "$method $path -> $status"
    printf '%s\n' "$body" | jq . >&2 2>/dev/null || printf '%s\n' "$body" >&2
    die "Jira rejected the request. Fix the payload here and note it in docs/factory/CHANGELOG.md."
  fi

  printf '%s' "$body"
}

section "Site: $JIRA_BASE"
ACCOUNT_ID="$(jira_get /rest/api/3/myself | jq -r '.accountId // empty')"
[[ -n "$ACCOUNT_ID" ]] || die "Could not read /rest/api/3/myself. Run bootstrap/preflight.sh."
ok "authenticated as $(jira_get /rest/api/3/myself | jq -r '.displayName')"

# ------------------------------------------------------------------ project

section "Project $JIRA_PROJECT_KEY"

PROJECT_ID="$(jira_get "/rest/api/3/project/$JIRA_PROJECT_KEY" | jq -r '.id // empty')"

if [[ -n "$PROJECT_ID" ]]; then
  ok "already exists (id $PROJECT_ID)"
else
  # Company-managed, not team-managed: team-managed projects keep their
  # workflow private to the project and cannot share the Factory scheme.
  payload="$(jq -n \
    --arg key "$JIRA_PROJECT_KEY" \
    --arg lead "$ACCOUNT_ID" \
    '{
      key: $key,
      name: "Dark Factory",
      projectTypeKey: "software",
      projectTemplateKey: "com.pyxis.greenhopper.jira:gh-simplified-kanban-classic",
      leadAccountId: $lead,
      assigneeType: "UNASSIGNED",
      description: "Cards worked by the factory. See docs/factory/OVERVIEW.md."
    }')"
  PROJECT_ID="$(jira_write POST /rest/api/3/project "$payload" | jq -r '.id // empty')"
  (( DRY_RUN )) || ok "created (id $PROJECT_ID)"
fi

# ----------------------------------------------------------------- statuses

section "Statuses"

# The ten statuses of the state machine. The names here are the contract: the
# factory transitions by destination status NAME (see factory/src/schema.ts,
# STATUS_TRANSITIONS), so renaming one here breaks reporting until the map is
# changed to match.
STATUS_SPEC='[
  { "name": "Backlog",             "category": "TODO",        "description": "Not yet ready to be worked." },
  { "name": "Ready for design",    "category": "TODO",        "description": "Picked up by the poller for a design turn." },
  { "name": "Designing",           "category": "IN_PROGRESS", "description": "A design turn is running." },
  { "name": "Design review",       "category": "IN_PROGRESS", "description": "A design is waiting for a human to review it." },
  { "name": "Blocked on architect","category": "IN_PROGRESS", "description": "The design stage asked a question and is waiting." },
  { "name": "Ready for build",     "category": "TODO",        "description": "Design approved; picked up by the poller for a build." },
  { "name": "Building",            "category": "IN_PROGRESS", "description": "A build turn is running, or waiting for the next turn to be granted." },
  { "name": "In review",           "category": "IN_PROGRESS", "description": "A build is waiting for a human to review the PR." },
  { "name": "Blocked on engineer", "category": "IN_PROGRESS", "description": "The build stage asked a question and is waiting." },
  { "name": "Done",                "category": "DONE",        "description": "Merged." }
]'

existing_statuses="$(jira_get "/rest/api/3/statuses/search?maxResults=200" | jq -c '.values // []')"

status_id_by_name() {
  printf '%s' "$existing_statuses" | jq -r --arg n "$1" '.[] | select(.name == $n) | .id' | head -1
}

to_create="$(jq -n --argjson spec "$STATUS_SPEC" --argjson have "$existing_statuses" '
  [ $spec[] | select( .name as $n | ($have | map(.name) | index($n)) == null ) ]
')"

if [[ "$(printf '%s' "$to_create" | jq 'length')" == "0" ]]; then
  ok "all ten already exist"
else
  payload="$(jq -n --argjson create "$to_create" '{
    scope: { type: "GLOBAL" },
    statuses: [ $create[] | { name: .name, statusCategory: .category, description: .description } ]
  }')"
  jira_write POST /rest/api/3/statuses "$payload" >/dev/null
  (( DRY_RUN )) || ok "created $(printf '%s' "$to_create" | jq -r 'map(.name) | join(", ")')"
  existing_statuses="$(jira_get "/rest/api/3/statuses/search?maxResults=200" | jq -c '.values // []')"
fi

# ----------------------------------------------------------------- workflow

section "Workflow"

WORKFLOW_NAME="Factory"

# /rest/api/3/workflow/search (singular) was REMOVED on 1 June 2026 — see
# changelog CHANGE-2569. The replacement is /rest/api/3/workflows/search, which
# also changed shape: a workflow's name is now a plain `.name` string, where the
# old endpoint nested it under `.id.name`.
workflow_exists="$(jira_get "/rest/api/3/workflows/search?queryString=$(printf '%s' "$WORKFLOW_NAME" | jq -sRr @uri)" \
  | jq -r --arg n "$WORKFLOW_NAME" '[.values[]? | select(.name == $n)] | length')"

if [[ "${workflow_exists:-0}" != "0" ]]; then
  ok "\"$WORKFLOW_NAME\" already exists"
else
  # Every status is reachable from every other one, via global transitions.
  #
  # This is deliberate. `factory report` picks a transition by its DESTINATION
  # status name, and a turn can end in any state from any state — a build turn
  # that fails validation has to reach "Blocked on engineer" whether it started
  # from "Building" or from "In review". A tightly drawn workflow would turn
  # those into JiraTransitionError and leave cards stuck with nobody told. The
  # gate on this pipeline is the PR review, not the Jira workflow.
  # Carry name/category/description through from STATUS_SPEC as well as the id:
  # the bulk-create payload needs all of them (see the schema note below).
  statuses_json="$(jq -n --argjson spec "$STATUS_SPEC" --argjson have "$existing_statuses" '
    [ $spec[] as $s | ($have[] | select(.name == $s.name)) as $h
      | { statusReference: $h.id, id: $h.id, name: $s.name,
          statusCategory: $s.category, description: $s.description } ]
  ')"

  # Both status arrays below carry fields the API reference marks REQUIRED, and
  # omitting them is a 400 rather than a default:
  #   - top-level statuses[] (WorkflowStatusUpdate) requires name and
  #     statusCategory as well as statusReference. `id` is what tells Jira to
  #     REUSE the status created above rather than mint a new one; without it
  #     the call fails with `Status name "..." must be unique`.
  #   - workflows[].statuses[] (StatusLayoutUpdate) requires `properties`, even
  #     when it is empty.
  payload="$(jq -n \
    --arg name "$WORKFLOW_NAME" \
    --argjson statuses "$statuses_json" \
    '{
      scope: { type: "GLOBAL" },
      statuses: [ $statuses[] | {
        statusReference: .statusReference,
        id: .id,
        name: .name,
        statusCategory: .statusCategory,
        description: .description
      } ],
      workflows: [{
        name: $name,
        description: "Factory state machine. Every status is globally reachable; see bootstrap/jira.sh for why.",
        startPointLayout: { x: 0, y: 0 },
        statuses: [ $statuses[] as $s | { statusReference: $s.statusReference, layout: { x: 0, y: 0 }, properties: {} } ],
        transitions: (
          [{
            id: "1",
            name: "Create",
            type: "INITIAL",
            toStatusReference: $statuses[0].statusReference,
            properties: {}
          }]
          +
          [ $statuses | to_entries[] | {
              id: ((.key + 2) | tostring),
              name: .value.name,
              type: "GLOBAL",
              toStatusReference: .value.statusReference,
              properties: {}
          } ]
        )
      }]
    }')"

  jira_write POST /rest/api/3/workflows/create "$payload" >/dev/null
  (( DRY_RUN )) || ok "created \"$WORKFLOW_NAME\" with a global transition into each status"
fi

# ---------------------------------------------------------- workflow scheme

section "Workflow scheme"

SCHEME_NAME="Factory scheme"
SCHEME_ID="$(jira_get "/rest/api/3/workflowscheme?maxResults=200" \
  | jq -r --arg n "$SCHEME_NAME" '.values[]? | select(.name == $n) | .id' | head -1)"

if [[ -n "$SCHEME_ID" ]]; then
  ok "\"$SCHEME_NAME\" already exists (id $SCHEME_ID)"
else
  payload="$(jq -n --arg n "$SCHEME_NAME" --arg w "$WORKFLOW_NAME" '{
    name: $n,
    description: "Every issue type uses the Factory workflow.",
    defaultWorkflow: $w
  }')"
  SCHEME_ID="$(jira_write POST /rest/api/3/workflowscheme "$payload" | jq -r '.id // empty')"
  (( DRY_RUN )) || ok "created (id $SCHEME_ID)"
fi

section "Assigning the scheme to $JIRA_PROJECT_KEY"

# Assigning a workflow scheme is asynchronous whenever the project already has
# issues: Jira returns 303 and a task to poll. A fresh project usually returns
# 204 and is done immediately, so handle both rather than assuming.
if (( DRY_RUN )); then
  info "would PUT /rest/api/3/workflowscheme/project (scheme $SCHEME_ID -> project $PROJECT_ID) and poll the task"
else
  assign_payload="$(jq -n --arg s "$SCHEME_ID" --arg p "$PROJECT_ID" \
    '{ workflowSchemeId: $s, projectId: $p }')"

  response="$(printf '%s' "$assign_payload" | curl -sS -w '\n%{http_code}' \
    -X PUT \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    --max-time 60 \
    --data-binary @- \
    "$JIRA_BASE/rest/api/3/workflowscheme/project")"
  http="${response##*$'\n'}"
  body="${response%$'\n'*}"

  case "$http" in
    204|200)
      ok "assigned"
      ;;
    303)
      task_url="$(printf '%s' "$body" | jq -r '.self // empty')"
      [[ -n "$task_url" ]] || die "Jira returned 303 without a task to poll: $body"
      info "migration queued; polling"
      for _ in $(seq 1 60); do
        task="$(curl -sS -u "$JIRA_USER:$JIRA_TOKEN" -H 'Accept: application/json' "$task_url")"
        state="$(printf '%s' "$task" | jq -r '.status // "UNKNOWN"')"
        case "$state" in
          COMPLETE) ok "assigned (migration complete)"; break ;;
          FAILED|CANCELLED|DEAD)
            printf '%s\n' "$task" | jq . >&2
            die "The workflow scheme migration ended in $state."
            ;;
          *)
            printf '    %s %s\n' "$(_colour 90 'migration:')" \
              "$(printf '%s' "$task" | jq -r '"\(.status) \(.progress // 0)%"')"
            sleep 5
            ;;
        esac
      done
      ;;
    *)
      printf '%s\n' "$body" | jq . >&2 2>/dev/null || printf '%s\n' "$body" >&2
      die "Assigning the workflow scheme returned HTTP $http."
      ;;
  esac
fi

# ------------------------------------------------------------ custom fields

section "Custom fields"

# Every screen the project actually uses, via its issue type screen scheme.
# Resolved once: the ids are generated per project, so they cannot be constants.
project_screen_ids() {
  local scheme_id screen_scheme_ids
  scheme_id="$(jira_get "/rest/api/3/issuetypescreenscheme/project?projectId=$PROJECT_ID" \
    | jq -r '.values[0].issueTypeScreenScheme.id // empty')"
  [[ -n "$scheme_id" ]] || return 0
  screen_scheme_ids="$(jira_get "/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=$scheme_id&maxResults=100" \
    | jq -r '[.values[].screenSchemeId] | unique | join("&id=")')"
  [[ -n "$screen_scheme_ids" ]] || return 0
  jira_get "/rest/api/3/screenscheme?id=$screen_scheme_ids&maxResults=100" \
    | jq -r '[.values[].screens | to_entries[] | .value] | unique | .[]'
}

# A field that is on no screen is invisible twice over: nobody can type into it
# in the UI, and GET /rest/api/3/field does not return it at all — which is the
# endpoint `factory gather` uses to resolve these two by name, and where a miss
# is silent. Creating the field is only half the job.
#
# POSTing a field that is already on the screen answers 400. That is the
# idempotent case rather than a failure, so this cannot go through jira_write.
add_field_to_screens() {
  local field_id="$1" screen tab payload body status
  payload="$(jq -n --arg f "$field_id" '{fieldId: $f}')"

  # bash 3.2 under `set -u` treats "${empty[@]}" as unbound, so guard the loop.
  (( ${#SCREEN_IDS[@]} == 0 )) && return 0

  for screen in "${SCREEN_IDS[@]}"; do
    if (( DRY_RUN )); then
      printf '  %s POST /rest/api/3/screens/%s/tabs/<tab>/fields %s\n' \
        "$(_colour 90 'would call:')" "$screen" "$field_id" >&2
      continue
    fi
    tab="$(jira_get "/rest/api/3/screens/$screen/tabs" | jq -r '.[0].id // empty')"
    [[ -n "$tab" ]] || continue
    body="$(printf '%s' "$payload" | curl -sS -w '\n%{http_code}' \
      -X POST -u "$JIRA_USER:$JIRA_TOKEN" \
      -H 'Accept: application/json' -H 'Content-Type: application/json' \
      --max-time 30 --data-binary @- \
      "$JIRA_BASE/rest/api/3/screens/$screen/tabs/$tab/fields")"
    status="${body##*$'\n'}"
    [[ "$status" == 200 || "$status" == 400 ]] \
      || warn "could not add $field_id to screen $screen (HTTP $status)"
  done
}

ensure_field() {
  local name="$1" description="$2" type="$3" searcher="$4" id

  # Look the field up through /field/search, not /field: an existing field that
  # is not yet on a screen is absent from /field, and trusting that would create
  # a second field with the same name on every re-run.
  id="$(jira_get "/rest/api/3/field/search?query=$(printf '%s' "$name" | jq -sRr @uri)&maxResults=50" \
    | jq -r --arg n "$name" '.values[]? | select(.name == $n) | .id' | head -1)"

  if [[ -n "$id" ]]; then
    ok "$name ($id)"
  else
    local payload
    payload="$(jq -n --arg n "$name" --arg d "$description" --arg t "$type" --arg s "$searcher" '{
      name: $n, description: $d, type: $t, searcherKey: $s
    }')"
    id="$(jira_write POST /rest/api/3/field "$payload" | jq -r '.id // empty')"
    (( DRY_RUN )) || ok "created $name ($id)"
  fi

  [[ -n "$id" ]] && add_field_to_screens "$id"
  return 0
}

# Built by hand rather than with readarray: macOS ships bash 3.2, where that
# builtin does not exist.
SCREEN_IDS=()
while IFS= read -r screen_id; do
  [[ -n "$screen_id" ]] && SCREEN_IDS+=("$screen_id")
done < <(project_screen_ids)

if (( ${#SCREEN_IDS[@]} == 0 )); then
  if [[ -z "$PROJECT_ID" ]]; then
    # A rehearsal on a site where the project does not exist yet. Nothing is
    # wrong; there is simply no screen scheme to read until the project is real.
    info "screens cannot be resolved until $JIRA_PROJECT_KEY exists — re-run without --dry-run"
  else
    warn "could not resolve the screens for $JIRA_PROJECT_KEY — add both custom fields to the project's screen by hand, or the agent will never see them"
  fi
fi

# `factory gather` finds these BY NAME, not by id: custom field ids differ per
# site, so hard-coding one would break the moment the factory ran anywhere else.
ensure_field 'Acceptance criteria' \
  'What has to be true for this card to be done. Read by the agent on every turn.' \
  'com.atlassian.jira.plugin.system.customfieldtypes:textarea' \
  'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'

ensure_field 'Design owner' \
  'The human accountable for the design on this card.' \
  'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' \
  'com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher'

# -------------------------------------------------------- filter and board

section "Filter and board"

FILTER_NAME="Dark Factory board filter"
FILTER_ID="$(jira_get "/rest/api/3/filter/search?filterName=$(printf '%s' "$FILTER_NAME" | jq -sRr @uri)" \
  | jq -r --arg n "$FILTER_NAME" '.values[]? | select(.name == $n) | .id' | head -1)"

if [[ -n "$FILTER_ID" ]]; then
  ok "filter already exists (id $FILTER_ID)"
else
  payload="$(jq -n --arg n "$FILTER_NAME" --arg k "$JIRA_PROJECT_KEY" '{
    name: $n,
    description: "Everything in the factory project, newest last.",
    jql: ("project = " + $k + " ORDER BY Rank ASC"),
    favourite: true
  }')"
  FILTER_ID="$(jira_write POST /rest/api/3/filter "$payload" | jq -r '.id // empty')"
  (( DRY_RUN )) || ok "created filter (id $FILTER_ID)"
fi

BOARD_NAME="Dark Factory"
board_exists="$(jira_get "/rest/agile/1.0/board?name=$(printf '%s' "$BOARD_NAME" | jq -sRr @uri)" \
  | jq -r '[.values[]?] | length')"

if [[ "${board_exists:-0}" != "0" ]]; then
  ok "board \"$BOARD_NAME\" already exists"
else
  payload="$(jq -n --arg n "$BOARD_NAME" --arg f "${FILTER_ID:-0}" '{
    name: $n, type: "kanban", filterId: ($f | tonumber)
  }')"
  jira_write POST /rest/agile/1.0/board "$payload" >/dev/null
  (( DRY_RUN )) || ok "created board \"$BOARD_NAME\""
fi

section "Done"
if (( DRY_RUN )); then
  info "Dry run only. Re-run without --dry-run to apply."
else
  ok "Jira is configured."
  warn "Map the ten statuses onto board columns by hand — the Agile API cannot do it. This is Checkpoint D; see docs/factory/SETUP.md."
fi
