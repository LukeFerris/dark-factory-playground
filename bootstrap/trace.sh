#!/usr/bin/env bash
#
# trace.sh — watch a card go through the factory.
#
# Two views side by side: where every card is in the state machine, and what
# GitHub is running. That pairing is the whole point — the card moves first and
# the run appears a moment later, because the poller claims a card before it
# dispatches. Seeing only one of the two makes that look like a fault.
#
# Read-only. It never moves a card, dispatches anything or writes to a PR, so
# it is safe to leave running for as long as you like.
#
# Usage:  bootstrap/trace.sh [--interval N] [--once]
#
#   --interval N   seconds between refreshes (default 5)
#   --once         print one snapshot and exit, for a script or a CI log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=bootstrap/lib.sh
source "$ROOT/bootstrap/lib.sh"

INTERVAL=5
ONCE=0
while (( $# )); do
  case "$1" in
    --interval) INTERVAL="${2:-5}"; shift 2 ;;
    --once)     ONCE=1; shift ;;
    -h|--help)  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown argument: $1" ;;
  esac
done

case "$INTERVAL" in ''|*[!0-9]*) die "--interval takes a whole number of seconds" ;; esac
(( INTERVAL >= 2 )) || die "--interval below 2s just rate-limits you against Jira"

cd "$ROOT"
load_env
assert_repo
require_env JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_PROJECT_KEY

# Looked up once rather than hardcoded: the id changes if the board is ever
# recreated, and a link to a board that no longer exists is worse than no link.
BOARD_ID="$(curl -sS -u "$JIRA_USER:$JIRA_TOKEN" --max-time 20 \
  "$JIRA_BASE/rest/agile/1.0/board?name=$(printf '%s' 'Dark Factory' | jq -sRr @uri)" \
  | jq -r '[.values[]?] | .[0].id // empty' 2>/dev/null || true)"

if [[ -n "$BOARD_ID" ]]; then
  BOARD_URL="$JIRA_BASE/jira/software/c/projects/$JIRA_PROJECT_KEY/boards/$BOARD_ID"
else
  BOARD_URL="(no board named \"Dark Factory\" — run bootstrap/jira.sh)"
fi

# The statuses a human owns. Anything sitting in one of these is waiting for
# you, and the factory will not touch it until you move it — which is the most
# common reason for "nothing is happening".
YOURS='Backlog|Design review|In review|Blocked on architect|Blocked on engineer|Ready for build'

cards() {
  local jql="project = $JIRA_PROJECT_KEY ORDER BY created DESC"
  curl -sS -u "$JIRA_USER:$JIRA_TOKEN" -G \
    --max-time 20 \
    --data-urlencode "jql=$jql" \
    --data 'maxResults=15&fields=summary,status,updated' \
    "$JIRA_BASE/rest/api/3/search/jql" \
    | jq -r --arg yours "$YOURS" '
        if (.issues | length) == 0 then
          "  no cards yet — bootstrap/smoke.sh --card files one"
        else
          .issues[]
          | (.fields.status.name) as $s
          | "  \(.key)  \($s)\(if ($s | test("^(" + $yours + ")$")) then "  ← you" else "" end)"
            + "\n        \(.fields.summary)"
        end'
}

runs() {
  gh run list --repo "$REPO_SLUG" --limit 8 \
    --json workflowName,status,conclusion,event,createdAt,databaseId \
    --jq '.[] | "  \(.databaseId)  \(.workflowName | .[0:22] | (. + "                      ")[0:22])  \(.event | .[0:18])  \(.status)\(if .conclusion then "/" + .conclusion else "" end)"' \
    2>/dev/null || echo "  (gh could not list runs)"
}

snapshot() {
  section "Cards — $BOARD_URL"
  cards || warn "could not reach Jira"
  echo
  section "Runs — $REPO_SLUG"
  runs
  echo
  printf '  %s\n' "$(_colour 90 "$(date '+%H:%M:%S') · refreshing every ${INTERVAL}s · ctrl-c to stop")"
}

if (( ONCE )); then
  snapshot
  exit 0
fi

# `clear` only on a terminal: redirected to a file, the escape codes would be
# the only thing in it.
while :; do
  [[ -t 1 ]] && clear
  snapshot
  sleep "$INTERVAL"
done
