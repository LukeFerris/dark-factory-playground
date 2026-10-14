#!/usr/bin/env bash
#
# jira-triggers.sh — create the six Jira Automation flows that start the
# factory. See docs/factory/JIRA-TRIGGERS.md for why they exist.
#
#   Factory: card ready     a card assigned to the factory moved to a Ready column
#   Factory: card assigned  a card in a Ready column was assigned to the factory
#   Factory: new comment    a person commented on a card blocked on a question
#   Factory: mentioned      a comment on a card in review @mentions the factory
#   Factory: stop           a comment on a card the factory is working @mentions it
#   Factory: sweep          every 30 minutes, if the factory has a card waiting
#                           or a card locked
#
# Each flow POSTs to a workflow-dispatch endpoint with FACTORY_DISPATCH_PAT, a
# fine-grained PAT with Actions: write on this repository only: stop.yml, with
# the card's key, for the stop flow, and poller.yml for the rest. The PAT is
# sent as a secure header, which Jira masks in the editor and in every read of
# the flow.
#
# Idempotent: a flow that already exists by name is updated in place to match
# this file, keeping its id, its audit log and its state, so a flow somebody
# switched off on purpose stays off. A new flow is created and enabled.
#
# This uses Atlassian's Automation Rule Management API, which needs the
# credentials of a person who may administer automation on the project.
# JIRA_USER / JIRA_TOKEN are those; the factory bot is refused, as it should be.
#
# Usage:  bootstrap/jira-triggers.sh [--dry-run]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=bootstrap/lib.sh
source "$ROOT/bootstrap/lib.sh"

if ! parse_common_args "$@"; then
  sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

cd "$ROOT"
load_env
require_env JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_PROJECT_KEY JIRA_BOT_EMAIL \
  GH_OWNER GH_REPO FACTORY_DISPATCH_PAT
assert_repo

JIRA_BASE="${JIRA_BASE%/}"

# The statuses whose comments triage reads: any comment where the factory asked
# a question, only a mention of it where a person is reviewing. Must equal the
# lists of the same names in factory/src/triage.ts; poller.test.ts fails CI
# when they drift.
QUESTION_STATUSES=("Blocked on architect" "Blocked on engineer")
REVIEW_STATUSES=("Design review" "In review")
READY_STATUSES=("Ready for design" "Ready for build")
# The statuses Jira locks to the factory (bootstrap/jira.sh, ADR 0007). Must
# equal LOCKED_STATUSES in factory/src/lock.ts; poller.test.ts checks.
LOCKED_STATUSES=("Designing" "Building")
SWEEP_CRON='0 0/30 * * * ?'

if (( DRY_RUN )); then section "DRY RUN — nothing will be changed"; fi

# ---------------------------------------------------------------- API helpers

# Reads always run, including under --dry-run, so the rehearsal knows what
# already exists.
jira_get() {
  local url="$1" body status
  body="$(curl -sS -w '\n%{http_code}' -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' --max-time 30 "$url")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$status" == 401 ]]; then
    die "Jira rejected the credentials (401). Check JIRA_USER and JIRA_TOKEN."
  fi
  if [[ "$status" == 403 ]]; then
    die "Jira refused $url (403). JIRA_USER must be allowed to administer automation on $JIRA_PROJECT_KEY."
  fi
  [[ "$status" -lt 400 ]] || die "GET $url -> $status: $body"
  printf '%s' "$body"
}

# Writes. The payload goes on stdin, never argv, because it carries the PAT.
# A malformed rule comes back as a bare 500 with no body, so the message says
# where to look rather than echoing nothing.
automation_write() {
  local method="$1" path="$2" payload="$3" body status

  if (( DRY_RUN )); then
    printf '  %s %s %s\n' "$(_colour 90 'would call:')" "$method" "$path" >&2
    printf '%s\n' "$payload" | jq '
      (.. | objects | select(.headerSecure? == true) | .value) |= "<FACTORY_DISPATCH_PAT>"
    ' | sed 's/^/      /' >&2
    printf '%s' '{}'
    return 0
  fi

  # The API answers 415 to a DELETE or a PUT without a Content-Type, so every
  # write sends one.
  body="$(printf '%s' "$payload" | curl -sS -w '\n%{http_code}' -X "$method" \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    --max-time 60 --data-binary @- "$AUTOMATION$path")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"

  if [[ "$status" -ge 400 ]]; then
    warn "$method $path -> $status"
    [[ -n "$body" ]] && printf '%s\n' "$body" | jq . >&2 2>/dev/null
    die "Automation rejected the flow. A 500 with no body means a component's value has the wrong shape; see docs/factory/CHANGELOG.md, 2026-10-02."
  fi
  printf '%s' "$body"
}

# ---------------------------------------------------------------- what exists

section "Site: $JIRA_BASE"

CLOUD_ID="$(jira_get "$JIRA_BASE/_edge/tenant_info" | jq -r '.cloudId // empty')"
[[ -n "$CLOUD_ID" ]] || die "Could not read the site's cloud id from $JIRA_BASE/_edge/tenant_info."
AUTOMATION="https://api.atlassian.com/automation/public/jira/$CLOUD_ID/rest/v1"
ok "cloud id $CLOUD_ID"

ACCOUNT_ID="$(jira_get "$JIRA_BASE/rest/api/3/myself" | jq -r '.accountId // empty')"
[[ -n "$ACCOUNT_ID" ]] || die "Could not read JIRA_USER's account id."
ok "flows will be owned by $JIRA_USER"

PROJECT_ID="$(jira_get "$JIRA_BASE/rest/api/3/project/$JIRA_PROJECT_KEY" | jq -r '.id // empty')"
[[ -n "$PROJECT_ID" ]] || die "Project $JIRA_PROJECT_KEY not found. Run bootstrap/jira.sh first."
SCOPE="ari:cloud:jira:$CLOUD_ID:project/$PROJECT_ID"
ok "scoped to $JIRA_PROJECT_KEY only ($SCOPE)"

BOT_ID="$(jira_get "$JIRA_BASE/rest/api/3/user/search?query=$(jq -rn --arg e "$JIRA_BOT_EMAIL" '$e|@uri')" \
  | jq -r '[.[] | select(.accountType == "atlassian" or .accountType == "app")][0].accountId // empty')"
[[ -n "$BOT_ID" ]] || die "No Jira user found for JIRA_BOT_EMAIL ($JIRA_BOT_EMAIL)."
ok "the factory is $BOT_ID: it takes cards assigned to it, and ignores its own comments"
# JQL takes an account id as a quoted string.
FACTORY_IS_ASSIGNEE="assignee = \"$BOT_ID\""

STATUSES="$(jira_get "$JIRA_BASE/rest/api/3/project/$JIRA_PROJECT_KEY/statuses" \
  | jq -c '[.[].statuses[] | {name, id}] | unique')"
READY_IDS="$(jq -c --argjson s "$STATUSES" '[.[] as $n | $s[] | select(.name == $n) | {type: "ID", value: .id}]' \
  <<<"$(printf '%s\n' "${READY_STATUSES[@]}" | jq -R . | jq -sc .)")"
[[ "$(jq length <<<"$READY_IDS")" == "${#READY_STATUSES[@]}" ]] \
  || die "Missing a Ready status on $JIRA_PROJECT_KEY (want: ${READY_STATUSES[*]}). Run bootstrap/jira.sh first."

# Prove the PAT before handing it to Jira: Automation's only error report is a
# rule audit log nobody is watching. A read is enough to show it can see each
# workflow; it is not a dispatch, so this starts nothing. stop.yml has to be on
# main already, so this also fails a run made before that merge.
dispatch_url() { printf 'https://api.github.com/repos/%s/actions/workflows/%s/dispatches' "$REPO_SLUG" "$1"; }
for workflow in poller.yml stop.yml; do
  pat_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer $FACTORY_DISPATCH_PAT" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO_SLUG/actions/workflows/$workflow")"
  [[ "$pat_status" == 200 ]] \
    || die "FACTORY_DISPATCH_PAT cannot see $workflow on $REPO_SLUG ($pat_status). Check its repository access, and that $workflow is on main."
  ok "FACTORY_DISPATCH_PAT can see $workflow"
done

EXISTING="$(jira_get "$AUTOMATION/rule/summary?limit=100" | jq -c '[.data[] | {name, uuid, state}]')"

# ---------------------------------------------------------------- the flows

# Every step's value is a JSON object, not the string the API reference shows;
# a string value is a 500. Fields the reference marks required are sent even
# where they carry nothing.
rule() {
  local name="$1" description="$2" trigger="$3" components="$4"
  jq -nc --arg name "$name" --arg description "$description" --arg me "$ACCOUNT_ID" \
    --arg scope "$SCOPE" --argjson trigger "$trigger" --argjson components "$components" '{
      connections: [],
      rule: {
        name: $name, description: $description, state: "DISABLED",
        ruleScopeARIs: [$scope],
        actor: {actor: $me, type: "ACCOUNT_ID"}, authorAccountId: $me,
        writeAccessType: "OWNER_ONLY", notifyOnError: "FIRSTERROR",
        canOtherRuleTrigger: false, labels: [], collaborators: [],
        trigger: ($trigger + {component: "TRIGGER", schemaVersion: 1, conditions: []}),
        components: ($components | map(. + {schemaVersion: 1, conditions: [], children: []}))
      }}'
}

# The dispatch call. The body is a template: Automation renders smart values
# such as {{issue.key}} in it before sending.
webhook() {
  jq -nc --arg url "$(dispatch_url "$1")" --arg body "$2" --arg pat "$FACTORY_DISPATCH_PAT" '{
    component: "ACTION", type: "jira.issue.outgoing.webhook",
    value: {
      url: $url, method: "POST",
      contentType: "custom", customBody: $body, sendIssue: false,
      responseEnabled: true, continueOnErrorEnabled: false,
      headers: [
        {name: "Authorization", value: ("Bearer " + $pat), headerSecure: true},
        {name: "Accept", value: "application/vnd.github+json", headerSecure: false},
        {name: "X-GitHub-Api-Version", value: "2022-11-28", headerSecure: false}
      ]}}'
}
WEBHOOK="$(webhook poller.yml '{"ref":"main"}')"

jql_list() { printf '%s\n' "$@" | jq -R . | jq -sr 'map("\"" + . + "\"") | join(", ")'; }

jql_condition() { jq -nc --arg jql "$1" '{component: "CONDITION", type: "jira.jql.condition", value: $jql}'; }

# A card is the factory's when it is in a Ready column AND assigned to the
# factory. Either can happen second, so there is a flow for each.
CARD_READY="$(rule 'Factory: card ready' \
  'Starts the factory poller when a card assigned to the factory moves to Ready for design or Ready for build. Managed by bootstrap/jira-triggers.sh.' \
  "$(jq -nc --argjson to "$READY_IDS" '{type: "jira.issue.event.trigger:transitioned", value: {fromStatus: [], toStatus: $to}}')" \
  "[$(jql_condition "$FACTORY_IS_ASSIGNEE"), $WEBHOOK]")"

# Jira stores this trigger with a null event unless told which one; with the
# event named it fires within seconds of the assignment.
CARD_ASSIGNED="$(rule 'Factory: card assigned' \
  'Starts the factory poller when a card in Ready for design or Ready for build is assigned to the factory. Managed by bootstrap/jira-triggers.sh.' \
  '{"type": "jira.issue.event.trigger:assigned", "value": {"eventKey": "jira:issue_updated", "issueEvent": "issue_assigned"}}' \
  "[$(jql_condition "status in ($(jql_list "${READY_STATUSES[@]}")) AND $FACTORY_IS_ASSIGNEE"), $WEBHOOK]")"

NOT_THE_FACTORY="$(jq -nc --arg bot "$BOT_ID" '{component: "CONDITION", type: "jira.comparator.condition",
  value: {first: "{{initiator.accountId}}", second: $bot, operator: "NOT_EQUALS"}}')"

NEW_COMMENT="$(rule 'Factory: new comment' \
  'Starts the factory poller when a person comments on a card the factory stopped on to ask a question. Managed by bootstrap/jira-triggers.sh.' \
  '{"type": "jira.issue.event.trigger:commented", "value": {}}' \
  "[$(jql_condition "status in ($(jql_list "${QUESTION_STATUSES[@]}"))"), $NOT_THE_FACTORY, $WEBHOOK]")"

# {{comment.body}} renders as wiki markup, where a mention is [~accountid:…].
MENTIONED="$(rule 'Factory: mentioned' \
  'Starts the factory poller when a comment on a card in review mentions the factory. Managed by bootstrap/jira-triggers.sh.' \
  '{"type": "jira.issue.event.trigger:commented", "value": {}}' \
  "[$(jql_condition "status in ($(jql_list "${REVIEW_STATUSES[@]}"))"), $NOT_THE_FACTORY,
    $(jq -nc --arg m "[~accountid:$BOT_ID]" '{component: "CONDITION", type: "jira.comparator.condition",
      value: {first: "{{comment.body}}", second: $m, operator: "CONTAINS"}}'), $WEBHOOK]")"

# Same shape as the mentioned flow, on the other statuses. It cannot tell a stop
# from any other mention — Automation has no "starts with" on a rendered body
# that carries the mention first — so `factory stop` reads the comment again
# and does nothing unless it is one. Straight to stop.yml rather than the
# poller, because a stop is the one thing that cannot wait for a turn to end.
STOP="$(rule 'Factory: stop' \
  'Starts factory stop when a comment on a card in Designing or Building mentions the factory. Only a comment that starts with "stop" after the mention does anything. Managed by bootstrap/jira-triggers.sh.' \
  '{"type": "jira.issue.event.trigger:commented", "value": {}}' \
  "[$(jql_condition "status in ($(jql_list "${LOCKED_STATUSES[@]}"))"), $NOT_THE_FACTORY,
    $(jq -nc --arg m "[~accountid:$BOT_ID]" '{component: "CONDITION", type: "jira.comparator.condition",
      value: {first: "{{comment.body}}", second: $m, operator: "CONTAINS"}}'),
    $(webhook stop.yml '{"ref":"main","inputs":{"key":"{{issue.key}}"}}')]")"

# The scheduled trigger accepts only method CRON through this API; the BASIC
# rate form the UI offers is a 500. Quartz syntax, so seconds come first.
#
# A locked card counts as well as a waiting one: a run that died without
# reporting leaves its card locked, only the factory can move it, and the
# poller's orphan check is what does.
SWEEP="$(rule 'Factory: sweep' \
  'Every 30 minutes, starts the factory poller if a card assigned to the factory is waiting in a Ready column, or a card is locked in Designing or Building. Catches dropped events and lets go of abandoned cards. Managed by bootstrap/jira-triggers.sh.' \
  "$(jq -nc --arg jql "project = $JIRA_PROJECT_KEY AND ((status in ($(jql_list "${READY_STATUSES[@]}")) AND $FACTORY_IS_ASSIGNEE) OR status in ($(jql_list "${LOCKED_STATUSES[@]}")))" --arg cron "$SWEEP_CRON" '{
      type: "jira.jql.scheduled",
      value: {jql: $jql, executionMode: "jql", onlyUpdatedIssues: false,
              schedule: {method: "CRON", cronExpression: $cron}}}')" \
  "[$WEBHOOK]")"

# Jira fills in its own defaults for a trigger it understood, and drops or
# rejects one it did not, so every write is read back.
check_trigger() {
  local name="$1" uuid="$2" payload="$3"
  jira_get "$AUTOMATION/rule/$uuid?redactSensitiveFields=true" \
    | jq -e --arg t "$(jq -r .rule.trigger.type <<<"$payload")" '.rule.trigger.type == $t' >/dev/null \
    || die "$name ($uuid) reads back with a different trigger. Check it in Jira."
}

# A flow that exists is replaced in place with PUT /rule/{uuid}, which keeps its
# id and audit log; its state is carried over so the update never switches a
# flow on or off. A new one is created disabled and then enabled, so a flow
# Jira half-accepts never runs.
ensure_flow() {
  local payload="$1" name uuid state
  name="$(jq -r .rule.name <<<"$payload")"
  uuid="$(jq -r --arg n "$name" '[.[] | select(.name == $n)][0].uuid // empty' <<<"$EXISTING")"

  if [[ -n "$uuid" ]]; then
    state="$(jq -r --arg u "$uuid" '.[] | select(.uuid == $u) | .state' <<<"$EXISTING")"
    automation_write PUT "/rule/$uuid" "$(jq -c --arg s "$state" '{rule: (.rule | .state = $s)}' <<<"$payload")" >/dev/null
    (( DRY_RUN )) && return 0
    check_trigger "$name" "$uuid" "$payload"
    ok "$name — updated ($state, as it was)"
    return 0
  fi

  uuid="$(automation_write POST /rule "$payload" | jq -r '.ruleUuid // empty')"
  if (( DRY_RUN )); then
    printf '  %s %s\n' "$(_colour 90 'would enable:')" "$name" >&2
    return 0
  fi
  [[ -n "$uuid" ]] || die "$name: no rule id came back."
  check_trigger "$name" "$uuid" "$payload"

  automation_write PUT "/rule/$uuid/state" '{"value":"ENABLED"}' >/dev/null
  ok "$name — created and enabled"
}

section "Automation flows on $JIRA_PROJECT_KEY"
ensure_flow "$CARD_READY"
ensure_flow "$CARD_ASSIGNED"
ensure_flow "$NEW_COMMENT"
ensure_flow "$MENTIONED"
ensure_flow "$STOP"
ensure_flow "$SWEEP"

section "Done"
info "Each flow's calls and their status codes: Space settings → Automation → Audit log."
info "Prove it: assign a card to the factory in Ready for design, then: gh run list --workflow poller.yml --repo $REPO_SLUG"
info "The PAT expires. Put the date in a calendar; see Rotation in docs/factory/JIRA-TRIGGERS.md."
