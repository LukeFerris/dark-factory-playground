# Factory changelog

Corrections to the build plan, and changes to the factory's own machinery. When
an API detail in the plan turns out to be wrong, the fix goes in the code and
the reason goes here — not into a silent workaround.

Application changes made by build agents are not recorded here; they are in the
PRs and in each card's `docs/design/<KEY>/build-log.md`.

## 2026-09-21

### `claude --max-turns` does not exist; turns are bounded by spend instead

**Plan said:** run the agent with `--max-turns <n>`.

**Actual:** Claude Code 2.1.224 has no `--max-turns` flag. `claude --help` lists
no turn-count limiter at all. The nearest equivalent is `--max-budget-usd
<amount>`, which caps what a single `--print` run may spend on API calls.

**Done:** every agent step uses `--max-budget-usd`, read from the repository
variables `FACTORY_DESIGN_BUDGET_USD` (default 5) and `FACTORY_BUILD_BUDGET_USD`
(default 10). This is arguably the better bound for the thing we actually care
about — a runaway agent costing money — since turn count is only a proxy for it.
The containment guarantee is unaffected: it never rested on the turn cap, but on
the tool allow-list and the diff-scope check in `factory validate`.

**Watch for:** the flag is version-coupled. If a future Claude Code drops or
renames `--max-budget-usd`, the agent step fails loudly at start-up rather than
running unbounded, because the flag is passed unconditionally.

### Agent steps also pass `--strict-mcp-config`

**Plan said:** run headless `claude -p` with an explicit tool allow-list.

**Done:** the allow-list is there, and the agent steps additionally pass
`--strict-mcp-config` and an explicit `--disallowedTools` list. Without
`--strict-mcp-config`, a runner-level or user-level MCP configuration would be
loaded and could add tools the allow-list never anticipated. The design stage
denies `Bash` outright; both stages deny `WebFetch`, `WebSearch`, `Task` and
`NotebookEdit`.

### Vitest 3, not Vitest 2

**Plan said:** tests with Vitest.

**Actual:** Vitest 2 pins Vite 5. With Vite 6 in `app/`, npm installed a second
copy of Vite nested under `vitest/`, and `vite.config.ts` stopped typechecking:
`vitest/config`'s `defineConfig` expected the nested copy's `Plugin` type while
`@vitejs/plugin-react` returned the root copy's.

**Done:** both workspaces use Vitest 3, which supports Vite 6, so npm dedupes to
a single Vite install and the config typechecks.

### The first build turn runs in `build-start.yml`

**Plan said:** six workflows, with `build-start` opening the work and
`build-turn` running turns granted by a human comment.

**Done:** `build-start.yml` runs turn 1 itself. `factory publish` needs a commit
to open a pull request, and a branch cut from `main` with no commits has nothing
to open a PR against. Turn 1 is granted by the card reaching "Ready for build" —
itself a human action — and every turn after it is granted by a human comment, as
planned. Auto-continue remains off.
