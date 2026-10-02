#!/usr/bin/env bash
#
# jira-triggers.sh — create the three Jira Automation flows that start the
# factory poller. See docs/factory/JIRA-TRIGGERS.md for why they exist.
#
#   Factory: card ready    a card moved to Ready for design or Ready for build
#   Factory: new comment   a person commented on a card the factory waits on
#   Factory: sweep         every 30 minutes, if a card is waiting in a Ready column
#
# Each flow POSTs to poller.yml's workflow-dispatch endpoint with
# FACTORY_DISPATCH_PAT, a fine-grained PAT with Actions: write on this
# repository only. The PAT is sent as a secure header, which Jira masks in the
# editor and in every read of the flow.
#
# Idempotent: a flow that already exists by name is left exactly as it is,
# including its state, so a flow somebody switched off on purpose stays off.
# To change one, delete it in Jira and re-run this.
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
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

cd "$ROOT"
load_env
require_env JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_PROJECT_KEY JIRA_BOT_EMAIL \
  GH_OWNER GH_REPO FACTORY_DISPATCH_PAT
assert_repo

JIRA_BASE="${JIRA_BASE%/}"

# The statuses whose comments triage reads. Must equal TRIAGE_STATUSES in
# factory/src/triage.ts; poller.test.ts fails CI when they drift.
TRIAGE_STATUSES=("Design review" "Blocked on architect" "In review" "Blocked on engineer")
READY_STATUSES=("Ready for design" "Ready for build")
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
  | jq -r '[.[] | select(.accountType == "atlassian")][0].accountId // empty')"
[[ -n "$BOT_ID" ]] || die "No Jira user found for JIRA_BOT_EMAIL ($JIRA_BOT_EMAIL)."
ok "the bot's own comments are ignored ($BOT_ID)"

STATUSES="$(jira_get "$JIRA_BASE/rest/api/3/project/$JIRA_PROJECT_KEY/statuses" \
  | jq -c '[.[].statuses[] | {name, id}] | unique')"
READY_IDS="$(jq -c --argjson s "$STATUSES" '[.[] as $n | $s[] | select(.name == $n) | {type: "ID", value: .id}]' \
  <<<"$(printf '%s\n' "${READY_STATUSES[@]}" | jq -R . | jq -sc .)")"
[[ "$(jq length <<<"$READY_IDS")" == "${#READY_STATUSES[@]}" ]] \
  || die "Missing a Ready status on $JIRA_PROJECT_KEY (want: ${READY_STATUSES[*]}). Run bootstrap/jira.sh first."

# Prove the PAT before handing it to Jira: Automation's only error report is a
# rule audit log nobody is watching. A read is enough to show it can see the
# workflow; it is not a dispatch, so this starts nothing.
DISPATCH_URL="https://api.github.com/repos/$REPO_SLUG/actions/workflows/poller.yml/dispatches"
pat_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  -H "Authorization: Bearer $FACTORY_DISPATCH_PAT" -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO_SLUG/actions/workflows/poller.yml")"
[[ "$pat_status" == 200 ]] \
  || die "FACTORY_DISPATCH_PAT cannot see poller.yml on $REPO_SLUG ($pat_status). Check its repository access."
ok "FACTORY_DISPATCH_PAT can see poller.yml"

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

WEBHOOK="$(jq -nc --arg url "$DISPATCH_URL" --arg pat "$FACTORY_DISPATCH_PAT" '{
  component: "ACTION", type: "jira.issue.outgoing.webhook",
  value: {
    url: $url, method: "POST",
    contentType: "custom", customBody: "{\"ref\":\"main\"}", sendIssue: false,
    responseEnabled: true, continueOnErrorEnabled: false,
    headers: [
      {name: "Authorization", value: ("Bearer " + $pat), headerSecure: true},
      {name: "Accept", value: "application/vnd.github+json", headerSecure: false},
      {name: "X-GitHub-Api-Version", value: "2022-11-28", headerSecure: false}
    ]}}')"

jql_list() { printf '%s\n' "$@" | jq -R . | jq -sr 'map("\"" + . + "\"") | join(", ")'; }

CARD_READY="$(rule 'Factory: card ready' \
  'Starts the factory poller when a card moves to Ready for design or Ready for build. Managed by bootstrap/jira-triggers.sh.' \
  "$(jq -nc --argjson to "$READY_IDS" '{type: "jira.issue.event.trigger:transitioned", value: {fromStatus: [], toStatus: $to}}')" \
  "[$WEBHOOK]")"

NEW_COMMENT="$(rule 'Factory: new comment' \
  'Starts the factory poller when a person comments on a card the factory is waiting on. Managed by bootstrap/jira-triggers.sh.' \
  '{"type": "jira.issue.event.trigger:commented", "value": {}}' \
  "$(jq -nc --arg jql "status in ($(jql_list "${TRIAGE_STATUSES[@]}"))" --arg bot "$BOT_ID" --argjson w "$WEBHOOK" '[
      {component: "CONDITION", type: "jira.jql.condition", value: $jql},
      {component: "CONDITION", type: "jira.comparator.condition",
       value: {first: "{{initiator.accountId}}", second: $bot, operator: "NOT_EQUALS"}},
      $w]')")"

# The scheduled trigger accepts only method CRON through this API; the BASIC
# rate form the UI offers is a 500. Quartz syntax, so seconds come first.
SWEEP="$(rule 'Factory: sweep' \
  'Every 30 minutes, starts the factory poller if any card is waiting in a Ready column. Catches dropped events. Managed by bootstrap/jira-triggers.sh.' \
  "$(jq -nc --arg jql "project = $JIRA_PROJECT_KEY AND status in ($(jql_list "${READY_STATUSES[@]}"))" --arg cron "$SWEEP_CRON" '{
      type: "jira.jql.scheduled",
      value: {jql: $jql, executionMode: "jql", onlyUpdatedIssues: false,
              schedule: {method: "CRON", cronExpression: $cron}}}')" \
  "[$WEBHOOK]")"

# Created disabled and then enabled, so a flow Jira half-accepts never runs.
ensure_flow() {
  local payload="$1" name uuid state
  name="$(jq -r .rule.name <<<"$payload")"
  state="$(jq -r --arg n "$name" '.[] | select(.name == $n) | .state' <<<"$EXISTING" | head -1)"
  if [[ -n "$state" ]]; then
    info "$name — already present ($state), left as it is"
    return 0
  fi

  uuid="$(automation_write POST /rule "$payload" | jq -r '.ruleUuid // empty')"
  if (( DRY_RUN )); then
    printf '  %s %s\n' "$(_colour 90 'would enable:')" "$name" >&2
    return 0
  fi
  [[ -n "$uuid" ]] || die "$name: no rule id came back."

  # Read it back: Jira fills in its own defaults for a trigger it understood,
  # and drops or rejects one it did not.
  jira_get "$AUTOMATION/rule/$uuid?redactSensitiveFields=true" \
    | jq -e --arg t "$(jq -r .rule.trigger.type <<<"$payload")" '.rule.trigger.type == $t' >/dev/null \
    || die "$name was created ($uuid) but reads back with a different trigger. Check it in Jira."

  automation_write PUT "/rule/$uuid/state" '{"value":"ENABLED"}' >/dev/null
  ok "$name — created and enabled"
}

section "Automation flows on $JIRA_PROJECT_KEY"
ensure_flow "$CARD_READY"
ensure_flow "$NEW_COMMENT"
ensure_flow "$SWEEP"

section "Done"
info "Each flow's calls and their status codes: Space settings → Automation → Audit log."
info "Prove it: move a card to Ready for design, then: gh run list --workflow poller.yml --repo $REPO_SLUG"
info "The PAT expires. Put the date in a calendar; see Rotation in docs/factory/JIRA-TRIGGERS.md."
