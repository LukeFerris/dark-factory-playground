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

### `preview-down` assumed the repo owner was a user, not an org

**Plan said:** `preview-down` "marks the deployment inactive and deletes the
package version". `GH_OWNER` is specified as "GitHub user **or org**".

**Actual:** the GHCR cleanup was hardcoded to `/users/{owner}/packages/...`.
GitHub scopes package routes by owner kind, and `/users/…` and `/orgs/…` are
different endpoints rather than aliases — pointing the user route at an
organisation is a 404, not a redirect. Because `previewDown` wraps the cleanup
in a `try` that only logs (a failed teardown should not fail the workflow), an
org-owned playground would have silently accumulated one container image per
merged card, forever, while reporting success.

Checked as part of a sweep of every GitHub endpoint the repo calls against
GitHub's published `api.github.com.json` (spec version 1.1.4). That sweep found
nothing else: all 17 endpoints exist and none are deprecated. The drift was
confined to Jira, and this one bug was ours rather than GitHub's.

**Done:** `packageVersionsPath()` in `factory/src/github.ts` resolves the owner
kind from `GET /repos/{owner}/{repo}` and builds the right route; `preview-down`
derives both the list and the delete path from it, so the two can no longer
disagree. Three unit tests pin both owner kinds and the lookup itself.

**Not** `/user/packages/...`, which is the obvious-looking third option: that
route means "the authenticated user", and `preview-down` runs under
`GITHUB_TOKEN`, an installation token with no user behind it.

### `shellcheck` and `actionlint` were never actually installed

**Plan said:** validate all YAML with `actionlint` ("install it if missing").

**Actual:** neither tool was present on the machine when the earlier phases
reported "shellcheck clean across all 5 scripts" and "actionlint clean across all
7 workflows". Those claims could not be reproduced, because the commands that
produced them cannot have run.

**Done:** both installed (shellcheck 0.11.0, actionlint 1.7.12) and run for
real. Both claims turned out to be *true* — all 5 scripts and all 7 workflows
are genuinely clean, including the Jira fixes above. The finding is about the
verification, not the code: a green claim from a tool that is not installed is
indistinguishable from a green claim from a tool that is, unless someone checks.
Worth remembering before trusting the next "X passes" in this repo.

### The first build turn runs in `build-start.yml`

**Plan said:** six workflows, with `build-start` opening the work and
`build-turn` running turns granted by a human comment.

**Done:** `build-start.yml` runs turn 1 itself. `factory publish` needs a commit
to open a pull request, and a branch cut from `main` with no commits has nothing
to open a PR against. Turn 1 is granted by the card reaching "Ready for build" —
itself a human action — and every turn after it is granted by a human comment, as
planned. Auto-continue remains off.

### `/rest/api/3/workflow/search` was removed on 1 June 2026

**Plan said:** nothing specific; `bootstrap/jira.sh` was written against the
workflow-search endpoint that was current when the plan was drafted.

**Actual:** `GET /rest/api/3/workflow/search` (singular *workflow*) is gone —
Atlassian removed it on 1 June 2026, three months before this build, per
changelog CHANGE-2569. The replacement is `GET /rest/api/3/workflows/search`
(plural), which also changed response shape: a workflow's name is a plain
`.name` string, where the removed endpoint nested it under `.id.name`.

**Done:** `bootstrap/jira.sh` calls the plural endpoint and selects on `.name`.
The query string is URI-encoded, matching how the filter and board lookups
further down the script already build theirs.

**How it was found:** by checking every endpoint the repo calls against
Atlassian's published OpenAPI spec (`swagger-v3.v3.json`) rather than against
the prose docs. The `deprecated: true` flag on the removed path is what
surfaced it. The same sweep confirmed every other endpoint in `jira.sh` and all
seven used by the factory CLI (`search/jql`, issue read, comment read/write,
transition list/execute, field list) are current and undeprecated.

### The bulk workflow-create payload was missing three required fields

**Plan said:** create the workflow via `POST /rest/api/3/workflows/create`.

**Actual:** the endpoint is correct and current, but the payload the script
built would have been rejected. Checked against the OpenAPI schema:

- `WorkflowStatusUpdate` (the top-level `statuses[]`) marks **`name` and
  `statusCategory`** required. The script sent only `statusReference` and `id`.
- `StatusLayoutUpdate` (the per-workflow `statuses[]`) marks **`properties`**
  required even when empty. The script omitted it.

`id` was already being sent, which is the field that makes the call reuse the
statuses created in the previous step instead of trying to mint new ones — its
absence is the widely-reported `Status name "..." must be unique` failure.

**Done:** `STATUS_SPEC`'s name, category and description are now carried through
into both arrays, and the inner array sends `properties: {}`. The constructed
payload was checked field-by-field against the schema's required lists with the
real `STATUS_SPEC` and a simulated status-search response: 10 statuses, 11
transitions (1 `INITIAL` + 10 `GLOBAL`), unique transition ids, and every
`toStatusReference` resolving to a declared status.

**Still unverified:** this is schema conformance, not a live call. `jira.sh` has
still never run against a real Jira site — that needs Checkpoint B. What changed
is that the first live run should now fail for interesting reasons, if at all,
rather than on three missing required fields.
