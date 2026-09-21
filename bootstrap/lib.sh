# Shared helpers for the bootstrap scripts. Sourced, never executed.
#
# preflight.sh deliberately does NOT use this file. It is the gate everything
# else sits behind, so it carries no dependencies of its own — a broken lib.sh
# should be something preflight can still tell you about.

# shellcheck shell=bash

BOOTSTRAP_LIB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=0

# ------------------------------------------------------------------- output

_colour() { printf '\033[%sm%s\033[0m' "$1" "$2"; }

info()  { printf '  %s %s\n' "$(_colour 36 '·')" "$*"; }
ok()    { printf '  %s %s\n' "$(_colour 32 '✓')" "$*"; }
warn()  { printf '  %s %s\n' "$(_colour 33 '!')" "$*" >&2; }
die()   { printf '  %s %s\n' "$(_colour 31 '✗')" "$*" >&2; exit 1; }

section() { printf '\n%s\n' "$(_colour '1' "$*")"; }

# ------------------------------------------------------------------- dry run

# Parses --dry-run out of the argument list. Call as: parse_common_args "$@"
parse_common_args() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help) return 1 ;;
      *) ;;
    esac
  done
  return 0
}

# Runs a command, or prints it when --dry-run is set. Every call that changes
# remote state goes through this, so --dry-run is a complete rehearsal rather
# than a best effort.
run() {
  if (( DRY_RUN )); then
    printf '  %s %s\n' "$(_colour 90 'would run:')" "$*"
    return 0
  fi
  "$@"
}

# Same, but for commands whose failure is expected and tolerable — creating a
# label that already exists, say. Prints the reason rather than aborting.
run_ok_if_exists() {
  local what="$1"; shift
  if (( DRY_RUN )); then
    printf '  %s %s\n' "$(_colour 90 'would run:')" "$*"
    return 0
  fi
  if "$@" >/dev/null 2>&1; then
    ok "$what"
  else
    info "$what — already present, or unchanged"
  fi
}

# ------------------------------------------------------------------ env file

# Reads .env into the environment without executing it. Real environment
# variables win, so CI can override any of it without editing the file.
load_env() {
  local file="${1:-$BOOTSTRAP_LIB_ROOT/.env}"
  [[ -f "$file" ]] || die "$file is missing. Copy .env.example to .env and fill it in."

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" != *=* ]] && continue
    key="$(printf '%s' "${line%%=*}" | tr -d '[:space:]')"
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!key:-}" ]] || export "$key=$value"
  done < "$file"
}

# Fails with a useful message rather than a blank API error. Placeholder values
# copied straight from .env.example count as missing.
require_env() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    if [[ -z "$value" ]]; then
      die "$name is not set in .env. See docs/factory/SETUP.md."
    fi
    # Written as an `if`, not `[[ … ]] && die`: under `set -e` a false `&&`
    # chain returns 1 and takes the whole script down without a word.
    if [[ "$value" == *"<"*">"* ]]; then
      die "$name is still the .env.example placeholder. See docs/factory/SETUP.md."
    fi
  done
  return 0
}

# Refuses to run against a repository the .env does not name, so a stray
# `gh repo set-default` cannot point a bootstrap script at the wrong repo.
assert_repo() {
  require_env GH_OWNER GH_REPO
  REPO_SLUG="${GH_OWNER}/${GH_REPO}"
  export REPO_SLUG
}
