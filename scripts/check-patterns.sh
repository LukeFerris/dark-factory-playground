#!/usr/bin/env bash
# Pre-commit gate: ensures /check-patterns has been run against the EXACT
# current staged diff before allowing the commit.
#
# The stamp file (.patterns-checked) stores the sha256 hash of `git diff
# --cached` at the moment the audit completed. On commit, we re-compute
# the hash and only let the commit proceed if it matches — that way:
#   * Adding files after the audit invalidates the stamp.
#   * lint-staged --fix mutating staged files invalidates the stamp.
#   * Stale stamps from previous sessions don't accidentally allow a commit.

set -euo pipefail

STAMP_FILE=".patterns-checked"

# Nothing staged → nothing to audit.
if [ -z "$(git diff --cached --name-only)" ]; then
  exit 0
fi

# AGENT-ONLY gate. This audit's value is an AI cross-referencing the whole
# codebase for reinvented patterns / needless fallbacks — failure modes that
# concentrate in AI-generated diffs — and when an agent drives the commit,
# /check-patterns is right there to produce the stamp. A human committing by
# hand has no way to satisfy it without invoking Claude (or forging the hash),
# so for human-driven commits we skip here by design. The signal is WHO IS
# DRIVING THE COMMIT, not who wrote which lines: Claude Code (and other agent
# harnesses) export these env vars into the commit environment; a human's own
# terminal does not. There is no PR-time backstop — human commits are
# intentionally not pattern-audited.
if [ -z "${CLAUDECODE:-}" ] && [ -z "${AI_AGENT:-}" ]; then
  exit 0
fi

current_hash=$(git diff --cached | sha256sum | awk '{print $1}')

if [ -f "$STAMP_FILE" ]; then
  expected_hash=$(tr -d '[:space:]' < "$STAMP_FILE")
  if [ "$expected_hash" = "$current_hash" ]; then
    rm -f "$STAMP_FILE"
    exit 0
  fi
  # Stamp exists but doesn't match — staged set changed since the audit.
  rm -f "$STAMP_FILE"
  cat <<'MSG' >&2
╔══════════════════════════════════════════════════════════════════╗
║  STAGED DIFF CHANGED SINCE /check-patterns LAST RAN              ║
║                                                                  ║
║  The previous audit no longer matches what's about to be         ║
║  committed (e.g. you `git add`-ed more files, or lint-staged     ║
║  auto-fixed something). Re-run /check-patterns to re-audit.      ║
╚══════════════════════════════════════════════════════════════════╝
MSG
  exit 1
fi

# No stamp at all — audit was never run.
cat <<'MSG' >&2
╔══════════════════════════════════════════════════════════════════╗
║  PATTERN CHECK REQUIRED                                          ║
║                                                                  ║
║  Run /check-patterns to audit staged changes for:                ║
║    • Duplicated patterns / reinvented systems                    ║
║    • Unnecessary fallbacks / backwards-compatibility shims       ║
║                                                                  ║
║  The skill stamps a hash of the current staged diff on success;  ║
║  commit then proceeds. If you re-stage anything after the audit, ║
║  re-run /check-patterns.                                         ║
╚══════════════════════════════════════════════════════════════════╝
MSG

exit 1
