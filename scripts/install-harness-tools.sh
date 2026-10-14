#!/usr/bin/env bash
# install-harness-tools.sh — the single source of truth for CVC pre-commit
# tooling. Installs (and version-pins) every tool required to commit to a CVC
# repo. Reused by BOTH the dev container's post-create.sh and a host machine:
#
#     bash scripts/install-harness-tools.sh
#
# Idempotent and version-asserting: a pinned tool is (re)installed only when it
# is missing OR not at the pinned version, so running it also self-heals host
# version drift (e.g. a host gitleaks 8.30 that would otherwise run silently).
#
# Stack-aware. The gate tools differ by how the repo runs its hooks:
#   • husky path  (.husky/, package.json) → standalone gitleaks + osv-scanner
#   • pre-commit-framework path (.pre-commit-config.yaml) → the `pre-commit`
#     tool, which pins gitleaks/osv-scanner itself via the config `rev:`.
# git-ai (attribution) and the Claude CLI are universal — installed everywhere.
set -euo pipefail

GITLEAKS_VERSION=8.21.2
OSV_SCANNER_VERSION=2.3.8

cyan='\033[0;36m'; green='\033[0;32m'; yellow='\033[0;33m'; reset='\033[0m'
log()  { echo -e "${cyan}→ $*${reset}"; }
ok()   { echo -e "${green}  ✓ $*${reset}"; }
warn() { echo -e "${yellow}  WARN: $*${reset}" >&2; }

# --- platform detection (host = macOS/Linux, container = Linux) ---
case "$(uname -s)" in
  Linux)  gl_os="linux";  osv_os="linux"  ;;
  Darwin) gl_os="darwin"; osv_os="darwin" ;;
  *) echo "Unsupported OS '$(uname -s)' — install harness tools manually." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  gl_arch="x64";   osv_arch="amd64" ;;
  aarch64|arm64) gl_arch="arm64"; osv_arch="arm64" ;;
  *) echo "Unsupported arch '$(uname -m)' — install harness tools manually." >&2; exit 1 ;;
esac

# Pick the bin dir where a freshly-installed copy of $1 will actually WIN
# `command -v` resolution (gate 0 resolves tools via PATH, so a drifted copy in
# an earlier dir must not shadow the pinned one). Walk PATH left→right: the first
# dir that is writable is chosen; but if a dir holding an existing copy comes
# first and isn't writable, the pinned binary can't win there → fail (caller
# falls back to sudo /usr/local/bin or a clear error). Prints the dir on stdout.
winning_path_dir() {  # $1 = tool name
  local name="$1" d chosen="" oldIFS="$IFS"
  IFS=:
  for d in $PATH; do
    [ -z "$d" ] && continue                 # skip empty entries (CWD) — never a sane target
    if [ -d "$d" ] && [ -w "$d" ]; then chosen="$d"; break; fi
    [ -x "$d/$name" ] && { IFS="$oldIFS"; return 1; }  # earlier non-writable copy shadows us
  done
  IFS="$oldIFS"
  [ -n "$chosen" ] && printf '%s\n' "$chosen"
}

# sudo is usable only if passwordless, or if a TTY exists for it to prompt on.
# In a no-TTY context (agent, CI, pre-commit hook) a prompting sudo just aborts
# with "a terminal is required" — so we must not even attempt it there.
sudo_usable() {
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n true 2>/dev/null && return 0
  [ -t 0 ] && [ -t 1 ]
}

# Move a binary onto PATH so the pinned version wins. Resolution order:
#   1. CVC_TOOLS_BIN override (explicit operator choice)
#   2. first writable on-PATH dir where we'd win command -v
#   3. /usr/local/bin (directly if writable, else via sudo when usable)
# If none of these work unattended, fail with an actionable message rather than
# a bare sudo error.
install_bin() {  # $1 = src path, $2 = dest name
  local src="$1" name="$2" dest
  chmod +x "$src"

  if [ -n "${CVC_TOOLS_BIN:-}" ]; then
    mkdir -p "$CVC_TOOLS_BIN" 2>/dev/null || true
    if [ -d "$CVC_TOOLS_BIN" ] && [ -w "$CVC_TOOLS_BIN" ]; then
      mv -f "$src" "$CVC_TOOLS_BIN/$name"; ok "$name → $CVC_TOOLS_BIN (CVC_TOOLS_BIN)"; return
    fi
    die_no_dest "$name" "CVC_TOOLS_BIN=$CVC_TOOLS_BIN is not a writable directory"
  fi

  if dest=$(winning_path_dir "$name") && [ -n "$dest" ]; then
    mv -f "$src" "$dest/$name"; ok "$name → $dest"; return
  fi

  if [ -w /usr/local/bin ]; then
    mv -f "$src" "/usr/local/bin/$name"; ok "$name → /usr/local/bin"; return
  fi
  if sudo_usable; then
    sudo mv -f "$src" "/usr/local/bin/$name"; ok "$name → /usr/local/bin (sudo)"; return
  fi

  die_no_dest "$name" "no writable dir on PATH and sudo can't run unattended (no passwordless sudo / no TTY)"
}

# Abort with guidance the operator can act on without a TTY.
die_no_dest() {  # $1 = tool name, $2 = reason
  warn "cannot install $1 — $2"
  {
    echo "  Provide a writable, on-PATH install dir, then re-run this script:"
    echo "    • Homebrew (Apple silicon): /opt/homebrew/bin is writable and already"
    echo "      shadows /usr/local/bin — install there with no sudo."
    echo "    • Or point CVC_TOOLS_BIN at a writable on-PATH dir, e.g.:"
    echo "        CVC_TOOLS_BIN=\"\$HOME/.local/bin\" bash scripts/install-harness-tools.sh"
    echo "      (ensure that dir is on PATH, ahead of any drifted copy)."
  } >&2
  exit 1
}

gitleaks_current() { command -v gitleaks >/dev/null 2>&1 && gitleaks version 2>/dev/null | tr -d 'v[:space:]'; }
osv_current()      { command -v osv-scanner >/dev/null 2>&1 && osv-scanner --version 2>/dev/null | sed -n 's/.*version:[[:space:]]*//p' | head -1; }

install_gitleaks() {
  if [ "$(gitleaks_current)" = "$GITLEAKS_VERSION" ]; then ok "gitleaks already at v${GITLEAKS_VERSION}"; return; fi
  log "Installing gitleaks v${GITLEAKS_VERSION} (${gl_os}/${gl_arch})..."
  local tmp; tmp=$(mktemp -d)
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${gl_os}_${gl_arch}.tar.gz" \
    | tar -xz -C "$tmp" gitleaks
  install_bin "$tmp/gitleaks" gitleaks; rm -rf "$tmp"
  ok "gitleaks $(gitleaks_current)"
}

install_osv_scanner() {
  if [ "$(osv_current)" = "$OSV_SCANNER_VERSION" ]; then ok "osv-scanner already at v${OSV_SCANNER_VERSION}"; return; fi
  log "Installing osv-scanner v${OSV_SCANNER_VERSION} (${osv_os}/${osv_arch})..."
  local tmp; tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/osv-scanner" \
    "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_${osv_os}_${osv_arch}"
  install_bin "$tmp/osv-scanner" osv-scanner; rm -rf "$tmp"
  ok "osv-scanner v${OSV_SCANNER_VERSION}"
}

install_precommit() {
  if command -v pre-commit >/dev/null 2>&1; then ok "pre-commit already installed"; else
    log "Installing pre-commit..."
    if   command -v uv   >/dev/null 2>&1; then uv tool install pre-commit
    elif command -v pipx >/dev/null 2>&1; then pipx install pre-commit
    elif command -v pip3 >/dev/null 2>&1; then pip3 install --user pre-commit
    else warn "no uv/pipx/pip3 found — install pre-commit manually"; return 1; fi
  fi
  [ -d .git ] && pre-commit install >/dev/null 2>&1 || true
}

# Install the git-ai capture hook at USER scope (~/.claude/settings.json) so AI
# authorship is checkpointed in EVERY Claude Code session regardless of cwd.
# This is the load-bearing fix for the agent-creates-repo case: an agent that
# CREATES a new repo starts its session OUTSIDE it, so the repo's COMMITTED
# .claude/settings.json hooks aren't loaded when the repo's first commits are
# made — without a user-scope hook every note's `sessions` block comes out empty
# and attribution is silently lost. A user-scope hook fires anyway, and git-ai
# resolves each checkpoint to the right repo from the edited file's path (so a
# parent-rooted session that creates + commits a sub-repo still gets correct
# per-line AI attribution). Idempotent: replaces any prior git-ai checkpoint hook
# (including the bad hardcoded-path form) and preserves all other settings.
install_user_capture_hook() {
  local settings="${HOME}/.claude/settings.json"
  local guarded='command -v git-ai >/dev/null 2>&1 && git-ai checkpoint claude --hook-input stdin || true'
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found — cannot wire the user-scope git-ai capture hook into $settings"
    warn "  add a PreToolUse + PostToolUse 'command' hook manually: $guarded"
    return 0
  fi
  mkdir -p "$(dirname "$settings")"
  if GUARDED_CMD="$guarded" SETTINGS_PATH="$settings" node <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS_PATH;
const guarded = process.env.GUARDED_CMD;
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch (_) { s = {}; }
if (typeof s !== 'object' || s === null || Array.isArray(s)) s = {};
s.hooks = (s.hooks && typeof s.hooks === 'object' && !Array.isArray(s.hooks)) ? s.hooks : {};
const isGitAi = (c) => typeof c === 'string' && /git-ai\s+checkpoint/.test(c);
for (const event of ['PreToolUse', 'PostToolUse']) {
  const groups = (Array.isArray(s.hooks[event]) ? s.hooks[event] : [])
    // Drop any prior git-ai checkpoint hook (incl. the bad hardcoded-path form
    // `git-ai install-hooks` writes) so we never duplicate and always land on
    // the guarded, PATH-resolved form.
    .map((g) => (g && Array.isArray(g.hooks))
      ? { ...g, hooks: g.hooks.filter((h) => !isGitAi(h && h.command)) }
      : g)
    .filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
  groups.push({ matcher: '*', hooks: [{ type: 'command', command: guarded }] });
  s.hooks[event] = groups;
}
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
NODE
  then ok "git-ai capture hook wired at user scope ($settings)"
  else warn "could not update $settings — wire the git-ai checkpoint hook manually"; fi
}

# === Universal: git-ai (cross-platform official installer) ===
# AI-code attribution. Capture happens via a Claude Code checkpoint hook
# (PreToolUse/PostToolUse -> git-ai checkpoint) that MUST live at USER scope
# (~/.claude/settings.json), not only in a repo's committed .claude/settings.json
# — see install_user_capture_hook above for why. We install the GUARDED,
# PATH-RESOLVED form, NOT the hook `git-ai install-hooks` writes: that form
# hardcodes an absolute binary path (e.g. /Users/<you>/.git-ai/... or
# /home/node/.git-ai/...) which breaks across the host<->devcontainer ~/.claude
# bind-mount. The guarded form resolves git-ai via PATH and no-ops outside a git
# repo, so it is safe at user scope and silent in unrelated dirs. Gate 0
# (check-tools.sh) asserts this hook is wired, so a commit is impossible from a
# machine where attribution can't be captured.
if ! command -v git-ai >/dev/null 2>&1; then
  log "Installing git-ai (AI-code attribution)..."
  curl -sSL https://usegitai.com/install.sh | bash
else
  ok "git-ai already installed"
fi
if command -v git-ai >/dev/null 2>&1; then
  install_user_capture_hook
fi
if command -v git-ai >/dev/null 2>&1 && [ -d .git ]; then
  # git-ai 1.5.x writes notes to refs/notes/ai; point rewriteRef there so
  # amend/rebase/squash propagate the note. (The old refs/notes/git-ai/* was an
  # empty namespace, so notes never rode along on a history rewrite.)
  git config --local notes.rewrite.amend true || true
  git config --local notes.rewriteRef 'refs/notes/ai' || true
fi

# === Universal: Claude Code CLI (convenience; not a commit gate) ===
if ! command -v claude >/dev/null 2>&1; then
  log "Installing Claude Code CLI (@anthropic-ai/claude-code)..."
  if npm install -g @anthropic-ai/claude-code 2>/dev/null; then :; else sudo npm install -g @anthropic-ai/claude-code; fi
else
  ok "claude CLI already installed"
fi

# === Stack-specific gate tools ===
if [ -f .pre-commit-config.yaml ]; then
  install_precommit
elif [ -d .husky ] || [ -f package.json ]; then
  install_gitleaks
  install_osv_scanner
else
  # Bare template (no stack scaffolded yet) — only the universal tools apply.
  warn "no .husky / .pre-commit-config.yaml / package.json detected; installed universal tools only."
fi

echo -e "${green}✓ CVC harness tools ready${reset}"
