#!/usr/bin/env bash
# check-tools.sh — fail-closed pre-commit preflight. THE HARD GATE.
#
# Runs as the FIRST step of every pre-commit hook (husky and pre-commit
# framework alike). Verifies that every pinned harness tool is present AT its
# pinned version before any other gate runs. A missing OR wrong-version tool
# aborts the commit — there is no bypass and no environment is exempt. This is
# what makes it impossible to commit from a machine that isn't correctly
# equipped (drifted host gitleaks, missing git-ai, etc.).
#
# Environment detection (dev container vs CI vs host) ONLY tailors the
# remediation message; it never relaxes or skips the check.
#
# Stack-aware, matching install-harness-tools.sh:
#   • pre-commit-framework repos pin gitleaks/osv via the config `rev:`, so we
#     only require the `pre-commit` tool itself (+ universal git-ai).
#   • husky repos run standalone binaries, so we assert their pinned versions.
set -uo pipefail   # deliberately NOT -e: collect all problems, then exit once.

GITLEAKS_VERSION=8.21.2
OSV_SCANNER_VERSION=2.3.8

red='\033[0;31m'; reset='\033[0m'
problems=()
missing_capture_hook=0   # set when the user-scope git-ai capture hook is absent

check_pinned() {  # $1 = tool name, $2 = expected version, $3 = actual version
  local name="$1" want="$2" got="$3"
  if   [ -z "$got" ];        then problems+=("$name is not installed (need v$want)")
  elif [ "$got" != "$want" ]; then problems+=("$name is v$got but v$want is required")
  fi
}

# --- Universal: git-ai must be installed (every commit must be attributed) ---
command -v git-ai >/dev/null 2>&1 || \
  problems+=("git-ai is not installed (required — every commit must be attributed)")

# --- Universal: the git-ai CAPTURE hook must be wired at USER scope ---
# Attribution is captured by a Claude Code checkpoint hook in ~/.claude/
# settings.json. It MUST be at user scope, not only in a repo's committed
# .claude/settings.json: an agent that CREATES a repo starts its session OUTSIDE
# it, so per-repo hooks never load for the repo's own commits and every note's
# `sessions` block comes out empty — attribution silently lost (the failure that
# shipped 3 empty-attribution commits to cvc-animal-dictionary). We require the
# GUARDED, PATH-resolved form (`command -v git-ai … && git-ai checkpoint …`); the
# hardcoded-path form `git-ai install-hooks` writes is broken across the
# host<->devcontainer ~/.claude bind-mount. install-harness-tools.sh wires it.
user_settings="${HOME}/.claude/settings.json"
if ! grep -q 'git-ai checkpoint claude' "$user_settings" 2>/dev/null \
  || ! grep -q 'command -v git-ai' "$user_settings" 2>/dev/null; then
  problems+=("git-ai capture hook is not wired at user scope (~/.claude/settings.json) — AI attribution would be silently empty for new/agent-created repos")
  missing_capture_hook=1
fi

# --- Stack-specific gate tools ---
if [ -f .pre-commit-config.yaml ]; then
  command -v pre-commit >/dev/null 2>&1 || \
    problems+=("pre-commit is not installed (this repo's hooks run via the pre-commit framework)")
elif [ -d .husky ] || [ -f package.json ]; then
  gl=""; command -v gitleaks    >/dev/null 2>&1 && gl=$(gitleaks version 2>/dev/null | tr -d 'v[:space:]')
  osv=""; command -v osv-scanner >/dev/null 2>&1 && osv=$(osv-scanner --version 2>/dev/null | sed -n 's/.*version:[[:space:]]*//p' | head -1)
  check_pinned gitleaks    "$GITLEAKS_VERSION"    "$gl"
  check_pinned osv-scanner "$OSV_SCANNER_VERSION" "$osv"
fi

[ ${#problems[@]} -eq 0 ] && exit 0

# --- Failure: report problems + environment-aware (but always-safe) remedy ---
in_container=0
if [ "${CVC_IN_DEVCONTAINER:-}" = "1" ] || [ -f /usr/local/share/cvc/in-devcontainer ]; then
  in_container=1
fi

{
  echo -e "${red}✗ CVC pre-commit tooling check failed:${reset}"
  for p in "${problems[@]}"; do echo "    • $p"; done
  echo ""
  if [ "$in_container" = 1 ]; then
    echo "  You're in the CVC dev container but required tooling is missing/outdated —"
    echo "  the post-create build likely didn't finish. Rebuild the container:"
    echo "    F1 → \"Dev Containers: Rebuild Container\""
  elif [ -n "${CI:-}" ]; then
    echo "  This CI runner is missing the pinned tooling. The workflow must run"
    echo "    bash scripts/install-harness-tools.sh"
    echo "  before any commit step."
  else
    echo "  You appear to be committing from the host. Either:"
    echo "    • Reopen in the dev container:  F1 → \"Dev Containers: Reopen in Container\""
    echo "    • Or install the pinned tooling on this host:"
    echo "        bash scripts/install-harness-tools.sh"
  fi
  if [ "$missing_capture_hook" = 1 ]; then
    echo ""
    echo "  NOTE on the capture hook: git-ai checkpoints are captured live, as code"
    echo "  is written. Wiring the hook now does NOT retroactively attribute code you"
    echo "  already wrote in this session before it was wired — those lines stay"
    echo "  unattributed. So the fix is install-then-(re-generate/re-touch the affected"
    echo "  files, or restart the session)-then-commit, not just install-then-commit."
  fi
} >&2
exit 1
