#!/usr/bin/env bash
#
# jira.sh — configure the Jira side of the factory.
#
# Creates (or reuses) a company-managed Kanban project, the ten factory
# statuses, the Factory workflow and scheme, the two custom fields, and a filter
# and board over the project. Locks the statuses the factory works a card in to
# the factory's account (ADR 0007).
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
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# jira_write, but a rejection is returned instead of fatal, and no body comes
# back. For the two calls that go to /rest/greenhopper/, which is the API the
# board settings UI drives and is not in Atlassian's published spec: it can
# change without notice, and when it does the fallback is a minute of dragging
# in the UI — not a reason to stop configuring Jira.
jira_try_write() {
  local method="$1" path="$2" payload="$3" body status

  if (( DRY_RUN )); then
    printf '  %s %s %s\n' "$(_colour 90 'would call:')" "$method" "$path" >&2
    printf '%s\n' "$payload" | jq . | sed 's/^/      /' >&2
    return 0
  fi

  body="$(printf '%s' "$payload" | curl -sS -w '\n%{http_code}' \
    -X "$method" \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H 'X-Atlassian-Token: no-check' \
    --max-time 60 \
    --data-binary @- \
    "$JIRA_BASE$path")"
  status="${body##*$'\n'}"

  [[ "$status" -lt 400 ]]
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

# --------------------------------------------------------------------- lock

section "Lock"

# While the factory works a card, only the factory can move it or reassign it.
# Jira does this itself, with two permission properties on a status: on a card
# in one of these, a transition or an assignment by anyone else — a project
# admin, a site admin — is refused, and the board will not take the drop. See
# ADR 0007 and factory/src/lock.ts, whose LOCKED_STATUSES must equal this list;
# poller.test.ts checks.
#
# Done is the factory's alone as well, at all times: it means "merged, and
# production is serving it", which only the run that deployed it can know.
# That is a condition on the one global transition into Done, naming the
# factory's account, so it binds admins too. ADR 0004 argues against an escape
# hatch.
#
# Reconciled rather than set once: a status taken off this list loses its lock,
# and a property or condition somebody changed by hand is put right.
LOCKED_STATUSES=("Designing" "Building")
LOCK_KEYS='["jira.permission.transition.user", "jira.permission.assign.user"]'
DONE_STATUS="Done"

# POST, but a read: the workflows endpoint takes its query as a body. Runs under
# --dry-run like every other read.
jira_read_post() {
  local path="$1" payload="$2" body status
  body="$(printf '%s' "$payload" | curl -sS -w '\n%{http_code}' -X POST \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    --max-time 30 --data-binary @- "$JIRA_BASE$path")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  [[ "$status" -lt 400 ]] || die "POST $path -> $status: $body"
  printf '%s' "$body"
}

# A service account is accountType "app", a person's account "atlassian";
# either can be the factory.
BOT_ID=""
if [[ -n "${JIRA_BOT_EMAIL:-}" ]]; then
  BOT_ID="$(jira_get "/rest/api/3/user/search?query=$(jq -rn --arg e "$JIRA_BOT_EMAIL" '$e|@uri')" \
    | jq -r '[.[]? | select(.accountType == "atlassian" or .accountType == "app")][0].accountId // empty')"
fi

WORKFLOW="$(jira_read_post '/rest/api/3/workflows?expand=values.transitions' \
  "$(jq -nc --arg n "$WORKFLOW_NAME" '{workflowNames: [$n]}')" | jq -c '.workflows[0] // empty')"

if [[ -z "$BOT_ID" ]]; then
  warn "JIRA_BOT_EMAIL is not set, or is not a Jira user yet: ${LOCKED_STATUSES[*]} and $DONE_STATUS are NOT locked."
  info "Re-run this script once the factory's Jira account exists (docs/factory/SETUP.md)."
elif [[ -z "$WORKFLOW" ]]; then
  info "\"$WORKFLOW_NAME\" does not exist yet (dry run); it would be locked to $BOT_ID once created"
else
  locked_json="$(printf '%s\n' "${LOCKED_STATUSES[@]}" | jq -R . | jq -sc .)"

  missing="$(jq -r --argjson have "$existing_statuses" '[.[] as $n | select(($have | map(.name) | index($n)) == null)] | join(", ")' \
    <<<"$(jq -c --arg d "$DONE_STATUS" '. + [$d]' <<<"$locked_json")")"
  [[ -z "$missing" ]] || die "Cannot lock $missing: no such status."

  # Every status's properties as they should be: the lock keys taken off, then
  # put back on the locked statuses only, for the factory.
  wanted_statuses="$(jq -c --argjson have "$existing_statuses" --argjson locked "$locked_json" \
    --argjson keys "$LOCK_KEYS" --arg bot "$BOT_ID" '
    [ .statuses[] | . as $s
      | ($have[] | select(.id == $s.statusReference) | .name) as $name
      | { statusReference, layout,
          properties: ( (.properties // {} | with_entries(select(.key as $k | $keys | index($k) | not)))
                        + (if ($locked | index($name)) == null then {}
                           else ($keys | map({key: ., value: $bot}) | from_entries) end) ) } ]
  ' <<<"$WORKFLOW")"

  # Every transition as it should be: the one global transition into Done
  # restricted to the factory, the rest untouched. "Done" is looked up among
  # this workflow's own statuses, because a site usually has more than one
  # status by that name.
  wanted_transitions="$(jq -c --argjson have "$existing_statuses" --arg bot "$BOT_ID" --arg done_name "$DONE_STATUS" '
    ([ .statuses[].statusReference as $r | $have[] | select(.id == $r and .name == $done_name) | .id ][0]) as $done_id
    | [ .transitions[] | if .type == "GLOBAL" and .toStatusReference == $done_id
          then .conditions = { operation: "ALL", conditionGroups: [],
                               conditions: [{ ruleKey: "system:restrict-issue-transition",
                                              parameters: { accountIds: $bot } }] }
          else . end ]
  ' <<<"$WORKFLOW")"

  # Conditions come back with an id and every parameter, set or not, so both
  # sides are compared as rule keys and the parameters that carry a value.
  lock_shape='{
    statuses: [ .statuses[] | {statusReference, layout, properties: (.properties // {})} ],
    conditions: [ .transitions[] | {id, groups: (.conditions.conditionGroups // [] | length),
                  rules: [ .conditions.conditions[]? | {ruleKey,
                           parameters: (.parameters // {} | with_entries(select(.value != "")))} ]} ]
  }'
  current="$(jq -S "$lock_shape" <<<"$WORKFLOW")"
  wanted="$(jq -S --argjson s "$wanted_statuses" --argjson t "$wanted_transitions" \
    "{statuses: \$s, transitions: \$t} | $lock_shape" <<<'{}')"

  if [[ "$wanted" == "$current" ]]; then
    ok "${LOCKED_STATUSES[*]} and $DONE_STATUS already locked to the factory ($BOT_ID)"
  else
    # The update replaces the whole workflow, so everything read is sent back
    # as it was apart from the status properties and the Done condition.
    # `version` is the optimistic lock: a workflow edited since the read is a
    # 409, not a lost edit. The top-level statuses carry the same required
    # fields as on create.
    payload="$(jq -n --argjson wf "$WORKFLOW" --argjson statuses "$wanted_statuses" \
      --argjson transitions "$wanted_transitions" --argjson have "$existing_statuses" '{
      statuses: [ $wf.statuses[] as $s | $have[] | select(.id == $s.statusReference)
                  | {statusReference: .id, id, name, statusCategory, description: (.description // "")} ],
      workflows: [{
        id: $wf.id, version: $wf.version, name: $wf.name, description: ($wf.description // ""),
        startPointLayout: $wf.startPointLayout, statuses: $statuses, transitions: $transitions
      }]
    }')"
    jira_write POST /rest/api/3/workflows/update "$payload" >/dev/null
    (( DRY_RUN )) || ok "locked ${LOCKED_STATUSES[*]} and $DONE_STATUS to the factory ($BOT_ID)"
  fi
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
BOARD_ID="$(jira_get "/rest/agile/1.0/board?name=$(printf '%s' "$BOARD_NAME" | jq -sRr @uri)" \
  | jq -r '[.values[]?] | .[0].id // empty')"

if [[ -n "$BOARD_ID" ]]; then
  ok "board \"$BOARD_NAME\" already exists (id $BOARD_ID)"
else
  # `location` is what ties the board to the project. Without it the board is
  # created, works, and never appears in the project's sidebar — Jira files it
  # as a cross-project board instead. Nothing reports this: the board is in
  # GET /board?projectKeyOrId= either way, because that matches on the filter.
  payload="$(jq -n --arg n "$BOARD_NAME" --arg f "${FILTER_ID:-0}" --arg p "$PROJECT_ID" '{
    name: $n, type: "kanban", filterId: ($f | tonumber),
    location: { type: "project", projectKeyOrId: $p }
  }')"
  BOARD_ID="$(jira_write POST /rest/agile/1.0/board "$payload" | jq -r '.id // empty')"
  (( DRY_RUN )) || ok "created board \"$BOARD_NAME\" (id $BOARD_ID)"
fi

# Repair a board made by an earlier run that did not set a location.
if [[ -n "$BOARD_ID" ]] && ! (( DRY_RUN )); then
  if [[ -z "$(jira_get "/rest/agile/1.0/board/$BOARD_ID" | jq -r '.location.projectId // empty')" ]]; then
    if jira_try_write PUT /rest/greenhopper/1.0/rapidviewconfig/boardLocation \
      "$(jq -n --argjson b "$BOARD_ID" --argjson p "$PROJECT_ID" \
        '{rapidViewId: $b, locationType: "project", locationId: $p}')"; then
      ok "attached board to project $JIRA_PROJECT_KEY"
    else
      warn "board \"$BOARD_NAME\" (id $BOARD_ID) has no project location, so it will not
       appear in the $JIRA_PROJECT_KEY sidebar. Set it by hand:
       Board → ⋯ → Configure board → Details → Location."
    fi
  fi
fi

# ------------------------------------------------------------ board columns
#
# One column per status, left to right in the order a card travels. Each
# "Blocked on …" sits just before the review status it shares a parent with,
# because both are exits from the same running state and the blocked one goes
# backwards.
#
# The documented Agile API cannot do this — /board/{id}/configuration is
# read-only. This is the endpoint the board settings UI drives, and it is not
# in Atlassian's published API: treat a failure here as cosmetic and map the
# columns by hand rather than letting it stop the bootstrap.
BOARD_COLUMNS='[
  "Backlog", "Ready for design", "Designing", "Blocked on architect",
  "Design review", "Ready for build", "Building", "Blocked on engineer",
  "In review", "Done"
]'

map_board_columns() {
  local pairs='[]' name id placeholder payload

  while IFS= read -r name; do
    id="$(status_id_by_name "$name")"
    if [[ -z "$id" ]]; then
      warn "no status id for \"$name\"; leaving board columns alone"
      return 0
    fi
    pairs="$(printf '%s' "$pairs" | jq --arg n "$name" --arg i "$id" '. + [{name: $n, id: $i}]')"
  done < <(printf '%s' "$BOARD_COLUMNS" | jq -r '.[]')

  # A Kanban board made from the template starts with a placeholder column for
  # the Kanban backlog: flagged isKanPlanColumn, holding no statuses, and
  # hidden while the backlog is off. Jira keeps it whatever is sent, so it is
  # sent back as it was, in front, rather than appearing as an eleventh column
  # nobody asked for. The board settings report it only as that flag on the
  # first column; there is no board-level setting to read.
  placeholder="$(jira_get "/rest/greenhopper/1.0/rapidviewconfig/editmodel?rapidViewId=$BOARD_ID" \
    | jq -c '[.rapidListConfig.mappedColumns[0]? | select(.isKanPlanColumn == true)
              | {name, mappedStatuses: [], min: "", max: "", isKanPlanColumn: true}]')"

  payload="$(printf '%s' "$pairs" | jq --argjson b "$BOARD_ID" --argjson front "${placeholder:-[]}" '{
    currentStatisticsField: { id: "issueCount_" },
    rapidViewId: $b,
    mappedColumns: ($front + [ .[] | {
      name: .name,
      mappedStatuses: [{ id: .id }],
      min: "", max: "",
      isKanPlanColumn: false
    }])
  }')"

  if jira_try_write PUT /rest/greenhopper/1.0/rapidviewconfig/columns "$payload"; then
    (( DRY_RUN )) || ok "mapped ten statuses onto ten columns"
  else
    warn "could not set board columns; map them by hand (see docs/factory/SETUP.md, Checkpoint D)"
  fi
}

if [[ -n "$BOARD_ID" ]]; then
  map_board_columns
fi

# The project template creates its own board, named after the project and with
# none of the factory's statuses mapped. It is the board the sidebar links to,
# so it is the one you will land on by accident. Not deleted here: a board is
# not this script's to destroy, and it may not be the only thing using it.
other_boards="$(jira_get "/rest/agile/1.0/board?projectKeyOrId=$JIRA_PROJECT_KEY" \
  | jq -r --arg n "$BOARD_NAME" '.values[]? | select(.name != $n) | "\(.id) \(.name)"')"
if [[ -n "$other_boards" ]]; then
  warn "another board exists on $JIRA_PROJECT_KEY and has none of these columns:
$(printf '%s\n' "$other_boards" | sed 's/^/       /')
       The project template creates one. Delete it so you cannot land on it by mistake:
       curl -u \"\$JIRA_USER:\$JIRA_TOKEN\" -X DELETE \"\$JIRA_BASE/rest/agile/1.0/board/<id>\""
fi

section "Done"
if (( DRY_RUN )); then
  info "Dry run only. Re-run without --dry-run to apply."
else
  ok "Jira is configured."
fi
