#!/usr/bin/env bash
# jira.sh ADMIN|BOT METHOD PATH [BODY-FILE]
#
# Calls Jira as the admin or the bot. Credentials come from the file named by
# ENKI_ENV (for example ~/.config/enki/<site>.env), or from the environment.
# They go to curl on stdin, never in its arguments. The last line of output is
# the HTTP status; strip it with `sed '$d'` (macOS head has no `-n -1`).
set -euo pipefail

if [[ -n ${ENKI_ENV:-} ]]; then set -a; . "$ENKI_ENV"; set +a; fi

who=$1 method=$2 path=$3 body=${4:-}
if [[ $who == BOT ]]; then u=$JIRA_BOT_EMAIL t=$JIRA_BOT_TOKEN base=$JIRA_BOT_BASE
else u=$JIRA_USER t=$JIRA_TOKEN base=$JIRA_BASE; fi

args=(-s -X "$method" -H 'Accept: application/json' -H 'Content-Type: application/json'
      -w '\n%{http_code}\n' -K -)
[[ -n $body ]] && args+=(--data-binary "@$body")
printf 'user = "%s:%s"\n' "$u" "$t" | curl "${args[@]}" "$base$path"
