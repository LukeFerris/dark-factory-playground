#!/usr/bin/env bash
#
# preflight.sh — the gate every other bootstrap script sits behind.
#
# Nothing in this repo may call an external API until this passes. It checks
# that the tools are present at the right versions, that .env exists and its
# non-secret values are filled in, that gh is authenticated as an identity that
# can see $GH_OWNER, and that the Jira token (if set) actually authenticates.
#
# It never prints a secret, and it never writes anything.
#
# Usage:  bootstrap/preflight.sh
# Exit:   0 = every check passed · 1 = at least one check failed

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# ---------------------------------------------------------------- result table

RESULTS=()
FAILED=0

pass() { RESULTS+=("PASS|$1|$2"); }
warn() { RESULTS+=("WARN|$1|$2"); }
fail() { RESULTS+=("FAIL|$1|$2"); FAILED=1; }

print_table() {
  local status check detail colour reset width=0

  for row in "${RESULTS[@]}"; do
    check="${row#*|}"; check="${check%%|*}"
    (( ${#check} > width )) && width=${#check}
  done

  echo
  printf '  %-6s  %-*s  %s\n' "RESULT" "$width" "CHECK" "DETAIL"
  printf '  %-6s  %-*s  %s\n' "------" "$width" "$(printf '%*s' "$width" '' | tr ' ' '-')" "------"

  reset=$'\033[0m'
  for row in "${RESULTS[@]}"; do
    status="${row%%|*}"
    check="${row#*|}"; check="${check%%|*}"
    detail="${row##*|}"
    case "$status" in
      PASS) colour=$'\033[32m' ;;
      WARN) colour=$'\033[33m' ;;
      *)    colour=$'\033[31m' ;;
    esac
    printf '  %s%-6s%s  %-*s  %s\n' "$colour" "$status" "$reset" "$width" "$check" "$detail"
  done
  echo
}

# ------------------------------------------------------------------- .env load

# Values the factory cannot run without and which are NOT credentials. Anything
# marked CHECKPOINT in .env.example is deliberately absent here: those arrive
# with the human checkpoints, and preflight only warns about them.
REQUIRED_VARS=(GH_OWNER GH_REPO JIRA_PROJECT_KEY)
CHECKPOINT_VARS=(FACTORY_APP_ID FACTORY_APP_KEY_PATH FACTORY_BOT_LOGIN JIRA_BASE JIRA_USER JIRA_TOKEN ANTHROPIC_API_KEY)

if [[ -f .env ]]; then
  # Read .env without executing it: only KEY=VALUE lines, no command substitution.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # Real environment wins over the file, so CI can override without editing it.
    [[ -n "${!key:-}" ]] || export "$key=$value"
  done < .env
  pass ".env" "found and parsed"
else
  fail ".env" "missing — copy .env.example to .env and fill it in"
fi

for var in "${REQUIRED_VARS[@]}"; do
  if [[ -n "${!var:-}" ]]; then
    pass "$var" "${!var}"
  else
    fail "$var" "not set in .env"
  fi
done

for var in "${CHECKPOINT_VARS[@]}"; do
  value="${!var:-}"
  if [[ -z "$value" ]]; then
    warn "$var" "not set — supplied at a human checkpoint"
  elif [[ "$value" == *"<"*">"* ]]; then
    # .env.example ships shapes like https://<site>.atlassian.net. A copied
    # placeholder is not a value, and calling Jira with one wastes a round trip.
    warn "$var" "still the .env.example placeholder"
    unset "$var"
  else
    # Never echo the value: these are credentials or point at one.
    pass "$var" "set"
  fi
done

# The App key is the one checkpoint value that is a path rather than a secret,
# so it is the one we can verify beyond "non-empty".
if [[ -n "${FACTORY_APP_KEY_PATH:-}" ]]; then
  if [[ -f "$FACTORY_APP_KEY_PATH" ]]; then
    pass "app private key" "present at $FACTORY_APP_KEY_PATH"
  else
    warn "app private key" "no file at $FACTORY_APP_KEY_PATH — downloaded at Checkpoint A"
  fi
fi

# ------------------------------------------------------------------ toolchain

check_command() {
  local name="$1" label="${2:-$1}"
  if command -v "$name" >/dev/null 2>&1; then
    pass "$label" "$(command -v "$name")"
    return 0
  fi
  fail "$label" "not on PATH"
  return 1
}

if check_command node; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  want_major="$(tr -dc '0-9' < .nvmrc 2>/dev/null || echo 22)"
  if [[ "$node_major" == "$want_major" ]]; then
    pass "node version" "$(node -v) matches .nvmrc"
  elif (( node_major > want_major )); then
    # CI pins .nvmrc, so a newer local Node is a divergence, not a blocker.
    warn "node version" "$(node -v) is newer than .nvmrc ($want_major) — CI builds on $want_major"
  else
    fail "node version" "$(node -v) is older than .nvmrc ($want_major)"
  fi
fi

check_command npm
check_command git
check_command jq

if check_command gh; then
  if ! gh auth status >/dev/null 2>&1; then
    fail "gh auth" "not logged in — run: gh auth login"
  elif [[ -z "${GH_OWNER:-}" ]]; then
    fail "gh auth" "cannot check the account without GH_OWNER"
  else
    # gh can hold several accounts at once and only one is active. Checking the
    # active login (rather than "can I read users/$GH_OWNER", which any token
    # can do for a public profile) is what actually tells us who we push as.
    active_login="$(gh api user --jq .login 2>/dev/null || true)"
    if [[ "$active_login" == "$GH_OWNER" ]]; then
      pass "gh active account" "$active_login"
    elif [[ -n "$active_login" ]]; then
      fail "gh active account" "active as $active_login, expected $GH_OWNER — run: gh auth switch -u $GH_OWNER"
    else
      fail "gh active account" "gh api user returned nothing"
    fi

    # Pushing .github/workflows/** needs the workflow scope, and the scopes
    # belong to a specific account's token — read them from that account's
    # block in gh auth status, not from the whole output.
    scopes="$(gh auth status 2>&1 \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | awk -v want="$GH_OWNER" '
          /account [^ ]+ / { in_block = ($0 ~ ("account " want " ")) }
          in_block && /Token scopes:/ { print; exit }
        ')"
    if [[ -z "$scopes" ]]; then
      fail "gh workflow scope" "no token scopes listed for $GH_OWNER"
    elif [[ "$scopes" == *"'workflow'"* ]]; then
      pass "gh workflow scope" "present on the $GH_OWNER token"
    else
      fail "gh workflow scope" "missing — run: gh auth refresh -h github.com -u $GH_OWNER -s workflow"
    fi
  fi
fi

if command -v claude >/dev/null 2>&1; then
  pass "claude" "$(claude --version 2>/dev/null | head -1)"
else
  fail "claude" "not on PATH — npm i -g @anthropic-ai/claude-code"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "docker" "daemon reachable"
  else
    warn "docker" "installed but the daemon is not running — needed only for preview images"
  fi
else
  warn "docker" "not installed — needed only to build preview images locally"
fi

# ----------------------------------------------------------------- Jira reachability

# The first external call in the whole system, and the last check here: if the
# token is absent we skip rather than fail, because it arrives at Checkpoint B.
if [[ -z "${JIRA_TOKEN:-}" || -z "${JIRA_USER:-}" || -z "${JIRA_BASE:-}" ]]; then
  warn "jira /myself" "skipped — JIRA_BASE, JIRA_USER or JIRA_TOKEN not set"
else
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -u "$JIRA_USER:$JIRA_TOKEN" \
    -H 'Accept: application/json' \
    --max-time 20 \
    "${JIRA_BASE%/}/rest/api/3/myself" 2>/dev/null || echo 000)"
  case "$code" in
    200) pass "jira /myself" "200 — token authenticates against ${JIRA_BASE%/}" ;;
    401|403) fail "jira /myself" "$code — JIRA_USER/JIRA_TOKEN rejected" ;;
    000) fail "jira /myself" "no response from ${JIRA_BASE%/}" ;;
    *) fail "jira /myself" "unexpected HTTP $code" ;;
  esac
fi

# ---------------------------------------------------------------------- report

print_table

if (( FAILED )); then
  echo "  Preflight failed. Fix the FAIL rows above before running any other bootstrap script." >&2
  exit 1
fi

warn_count=0
for row in "${RESULTS[@]}"; do
  [[ "${row%%|*}" == "WARN" ]] && (( warn_count++ ))
done

if (( warn_count )); then
  echo "  Preflight passed with $warn_count warning(s). Checkpoint values can be filled in later."
else
  echo "  Preflight passed."
fi
