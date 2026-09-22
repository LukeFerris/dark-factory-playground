# Factory changelog

Corrections to the build plan, and changes to the factory's own machinery. When
an API detail in the plan turns out to be wrong, the fix goes in the code and
the reason goes here — not into a silent workaround.

Application changes made by build agents are not recorded here; they are in the
PRs and in each card's `docs/design/<KEY>/build-log.md`.

## 2026-09-22

### The poller polls in a loop, because cron cannot go below five minutes

**Plan said:** a scheduled workflow every ten minutes.

**Actual:** ten minutes is a long time to watch nothing happen, and the obvious
fix does not exist — GitHub's floor for `schedule:` is five minutes, and
scheduled runs are routinely later than their slot under load. There is no cron
that gives a thirty-second reaction.

**Done:** the cron drops to `*/5` and stops being where latency comes from. A
run now loops, polling every `FACTORY_POLL_INTERVAL_SECONDS` (default 30) until
`FACTORY_POLL_WINDOW_SECONDS` (default 270) is up, and the cron only starts the
next run. Both are repository variables and both are overridable per dispatch.
Checkout, `npm ci` and minting the App token dominate the cost of a run, so
passes after the first are nearly free.

Neither value is trusted: a non-numeric or missing one falls back to the
default, the interval is floored at 5s so a bad value cannot spin the loop, and
the window is capped at 3000s because the App token is minted once and lasts an
hour.

**The cost, stated plainly:** a window just under the cron interval means a
runner is up almost continuously. That is free on a public repository and
unremarkable for a playground, but it is a real machine kept busy for something
idle most of the time. `FACTORY_POLL_WINDOW_SECONDS=0` restores exactly the old
one-pass-per-tick behaviour.

### The board existed, worked, and was invisible

**Plan said:** create a filter and a Kanban board over it, then map the statuses
onto columns by hand, because the Agile API cannot do it.

**Actual:** three separate faults, each hidden by the next.

**The board had no project.** `POST /rest/agile/1.0/board` takes an optional
`location`, and without it Jira files the board as cross-project: it exists, it
works, and the project's sidebar never links to it. Nothing reports this.
`GET /board?projectKeyOrId=DF` returns it either way, because that matches on
the board's filter rather than its location — so the check that looked most
like a verification was the one that could not see the problem. The only tells
are `location` missing from `GET /board/{id}` and `isBoardCrossProject: true`
in the config model.

**The template made a second board.** `kanban-classic` creates `DF board`
automatically, with none of the factory's statuses mapped. That one *is*
attached to the project, so it is what the sidebar opens — meaning the board
you land on is the wrong one, and the right one is unreachable from the
project. Seven factory statuses sat in its Unmapped pile.

**The columns were never set.** Correct as documented, but the reason given was
wrong. The *documented* Agile API cannot map statuses to columns —
`/board/{id}/configuration` is read-only. The board settings UI drives
`PUT /rest/greenhopper/1.0/rapidviewconfig/columns`, which works fine, and
`PUT /rest/greenhopper/1.0/rapidviewconfig/boardLocation` attaches an existing
board to a project.

**Done:** `bootstrap/jira.sh` passes `location` on create, repairs a board that
lacks one, maps all ten columns, and warns about any other board on the
project. Both greenhopper calls go through a new `jira_try_write`, which
returns a rejection instead of calling `die` — an undocumented endpoint
changing under us should cost a minute of dragging, not abort the bootstrap.
`smoke.sh` now checks the board's location and that all ten statuses are
mapped, instead of only that a board by that name exists.

**Worth keeping in mind:** "the API returned it" is not "a person can reach it".
Both the board and its columns were present and queryable the whole time. The
check that passed was asking a question adjacent to the one that mattered.

### Every secret was set to a single hyphen

**Plan said:** `bootstrap/github.sh` sets three secrets from `.env`.

**Actual:** it set all three to the literal string `-`. `set_secret` piped the
value into `gh secret set … --body -`, borrowing a stdin convention that `gh`
does not have: `--body` takes the value verbatim, and reads standard input only
when the flag is omitted entirely. The pipe was written and then discarded.

Nothing caught it. A secret cannot be read back, so `smoke.sh` can only check
that a name exists — and all three did exist. The first symptom arrived from a
workflow days later, as `actions/create-github-app-token@v1` failing with
`Invalid keyData` / `ERR_OSSL_ASN1_NOT_ENOUGH_DATA`. That is OpenSSL's way of
saying the PEM it was handed is one byte long.

**Done:** dropped the flag so the pipe is actually read. The App key now goes
through a separate `set_secret_file`, redirected straight from the file, because
`$(cat …)` strips the trailing newline and a PEM is the one value here where the
exact bytes are not worth reasoning about. The dry run prints byte counts, which
is what makes the failure visible next time: 1 byte is obviously wrong, 1679 is
obviously a key.

**Worth keeping in mind:** this class of bug is invisible by design. Write-only
values cannot be verified through the API that stores them, so the only proof a
secret is right is a workflow using it successfully. Until a run passes, treat
every ✓ next to a secret as "a name was created".

### Two bootstrap scripts wrote log output where a caller expected JSON

Both found by running the bootstrap for the first time against a live account
and a live Jira site. Neither could have been caught by unit tests: both only
appear when a real API answers.

**`jira.sh` — `--dry-run` could not get past the first write.** `jira_write`
printed its "would call" rehearsal — the method, the path and the pretty-printed
payload — to stdout. Every caller captures that stdout and pipes it to `jq`
(`PROJECT_ID="$(jira_write POST /rest/api/3/project "$payload" | jq -r '.id')"`),
so `jq` was handed the log text and died with `Invalid numeric literal at line
1, column 4`. The rehearsal now goes to stderr: still on the terminal, no longer
mistaken for a response body. Four capture sites were affected. One of them,
the board creation, redirected stdout to `/dev/null`, so its payload had never
been visible in a dry run at all — it is now.

**`github.sh` — a 403 was parsed as a ruleset id.** `upsert_ruleset` read the
existing id with `gh api .../rulesets --jq ... 2>/dev/null || true`. Rulesets
need GitHub Pro on a private repository; on a free plan the call returns a JSON
error body, which `--jq` passed straight through into `$id`. The script then
believed the ruleset existed and would have issued
`PUT repos/<slug>/rulesets/{"message":"Upgrade to GitHub Pro..."}`. It now lists
first, checks the call succeeded, and dies with the plain reason — a missing
ruleset is a normal state, an unreachable ruleset API is not. This matters more
than a tidy error message: the `main protection` ruleset is the entire
containment story, and failing silently on it means the App is uncontained.

### The documented bootstrap order could not succeed on an empty repository

**Plan said:** run `bootstrap/github.sh`, then `git push -u origin main`.

**Actual:** the push is rejected. `github.sh` creates the `main protection`
ruleset, which requires a pull request and a green `ci` and has no bypass
actors — deliberately, including the human running it. On an empty repository
nothing can satisfy that: `ci` cannot run until the workflows are on the default
branch, and they cannot get there except by this push. GitHub answers
`Required status check "ci" is expected`.

**Done:** `SETUP.md` now pushes before `github.sh`, and documents the
disable/push/re-enable recovery for anyone who has already created the ruleset,
with a verification step — an unenforced `main protection` is the single failure
mode the design exists to prevent, and it is invisible once you have moved on.

`SETUP.md` also now states the prerequisite that made this visible: rulesets
need GitHub Pro on a private repository. On a free plan every ruleset call
returns 403 and the factory has no containment at all.

### Notes from the first live bootstrap

Not defects, but each looked like one for a while.

*Jira ships a global status called "Building".* `jira.sh` creates nine of its
ten statuses and reuses that one. The skip is the idempotency check working, not
a missing status.

*The `kanban-classic` template creates `Backlog` and `Done` itself.* So the run
that appears to create seven statuses has in fact produced all ten: seven new,
one pre-existing global, two from the template. Check
`/rest/api/3/project/DF/statuses` rather than counting the log lines.

### The custom fields were created and then left on no screen

**Plan said:** `jira.sh` creates `Acceptance criteria` and `Design owner`, and
`factory gather` resolves them by name.

**Actual:** both fields existed and neither was usable. `jira.sh` created them
and stopped there, never associating them with the project's screens. A field on
no screen is invisible twice over: it does not appear on the create or edit form,
so no human can put acceptance criteria on a card at all, and — the part that
cost the time — `GET /rest/api/3/field` does not return it. That is the endpoint
`factory/src/gather.ts:26` uses, and a miss there is silent: the criteria render
as `_(none given)_` and the agent simply works without them.

`smoke.sh` reported both as missing and was right to. The first reading was that
Jira's field index lagged behind creation, because `/rest/api/3/field/search`
listed both and each resolved by id. It was not lag. Polling `/rest/api/3/field`
every thirty seconds returned nothing for seven attempts and then both fields on
the eighth — the attempt immediately after they were added to a screen by hand.

**Done:** `ensure_field` now resolves the project's screens through its issue
type screen scheme (`project_screen_ids`) and adds each field to the first tab
of every screen the project uses. A field already on the screen answers 400,
which is the idempotent case and is tolerated rather than fatal.

The same function also now looks fields up through `/rest/api/3/field/search`
rather than `/rest/api/3/field`. This was a second bug hiding behind the first:
a field that exists but is on no screen is absent from `/field`, so a re-run
after a partial bootstrap would not have found it and would have created a
duplicate of the same name on every attempt.

Two portability notes, both from macOS shipping bash 3.2: `readarray` does not
exist, and `"${arr[@]}"` on an empty array is an unbound-variable error under
`set -u`. The array is built with a read loop and the loop is guarded.

## 2026-09-21

### The preview was raised once and never rebuilt, and nothing served it

**Plan said:** a preview environment per pull request, raised by `build-setup`.

**Actual:** two separate gaps, one of them silently wrong in the documentation.

*It was raised once.* `build-start.yml` dispatched `build-setup.yml` at the end
of turn 1, and nothing dispatched it again. `build-turn.yml` did not. So the
preview showed turn 1's build for the life of the PR, while every diagram and
document in the repository described it as tracking the branch. A preview that
is confidently stale is worse than no preview: a reviewer clicks it, sees the
old build, and reports a bug that does not exist.

*Nothing served it.* The GHCR path builds a real image and records a real
Deployment, but the "preview URL" was a link to a container registry page.

**Done, for the trigger:** `build-setup.yml` now runs on the pull request's own
`labeled` and `synchronize` events instead of a dispatch. The hand-off step and
the now-unused PR-number step are gone from `build-start.yml`. This works
because `factory publish` applies `factory:active` with the **App installation
token**, and events made with an App token start workflow runs where events made
with `GITHUB_TOKEN` do not — the same distinction the poller already depends on.
`synchronize` covers every later turn, so the preview follows the branch. The
`labeled` gate matches `github.event.label.name` exactly rather than testing the
label set, or adding any unrelated label to an active PR would re-post the
kickoff comment; the kickoff step is additionally skipped on `synchronize`.
Checkout takes the head SHA, not the merge commit — a preview of a merge commit
is a preview of something that exists nowhere.

**Done, for the hosting:** a second backend, selected by the
`FACTORY_PREVIEW_BACKEND` repository variable. `azure` builds the image with
`az acr build` (in ACR Tasks, so the runner needs no Docker daemon) and runs it
as one Azure Container App per PR with external ingress on 8080. Azure issues
and renews the certificate and hands back an
`https://<app>.<region>.azurecontainerapps.io` FQDN, which becomes the
Deployment URL, the PR factory block's `preview_url` and the agent's
`PREVIEW_URL`. `--min-replicas 0` means an unvisited preview costs nothing, at
the price of a few seconds of cold start. Teardown deletes the app and the image
tag as two independent attempts, because an app that outlives its PR bills by
the hour while a stray image tag only bills for storage.

**Registry is ACR, not GHCR,** deliberately. Container Apps pulling from a
private GHCR repository would need a durable GitHub credential stored inside
Azure — exactly the credential-spreading the security model exists to prevent.
ACR pulls with the app's system-assigned managed identity and stores nothing.

**Azure sign-in is OIDC,** so the repository holds no Azure secret at all: nine
repository variables and zero secrets. `id-token: write` is granted only in
`build-setup.yml` and `build-teardown.yml`, neither of which runs an agent.

**Container Apps, not Static Web Apps,** which the plan named. The app is
already a container carrying its own nginx config; Static Web Apps serves static
files only, so the SPA fallback and cache headers would have to be re-expressed
in its config format. The commented-out `deploy-azure` job is deleted.

**Not verified.** No part of the Azure path has run against a live subscription.
The `az` command shapes follow the documented CLI surface and are pinned by 13
unit tests through a stubbed runner, but a passing test of a command string is
not evidence the command works — see the `shellcheck`/`actionlint` entry below
for why that distinction is worth stating twice. The default stays `ghcr` until
someone has watched it work. `preflight.sh` fails loudly on a half-configured
`azure` backend rather than letting it fail mid-build.

**Watch for:** `--registry-identity system` asks Azure to grant the app's own
identity `AcrPull` at create time, which only succeeds if the deploying
principal can make role assignments. That is the most likely first failure, and
it presents as a successful create followed by `ImagePullFailure`.

**Also watch for:** `build-setup.yml` now builds the PR's own code while holding
`packages: write` and an Azure credential. The workflow file is read from the
base branch so the agent cannot change what runs, and `factory validate` keeps
`.github/`, `factory/` and `bootstrap/` out of reach — but `npm ci` and the
Docker build still run install scripts from `app/package.json`. Recorded in
SECURITY.md under what this does not defend against.

### The agent CLI was installed unpinned, and turns were not reproducible

**Plan said:** install the agent on the runner and run it headless.

**Actual:** all three agent workflows ran `npm i -g @anthropic-ai/claude-code`
with no version. Every job pulled whatever was latest at that moment. That is a
live risk rather than a theoretical one: the `--max-turns` entry below is this
repo already having been bitten by version-coupled flags, and an unpinned
install means a CLI release can change how a turn behaves at 3am with nobody
watching. Turns were also not reproducible after the fact — the artifact
carried `.agent/out/` but not `.agent/in/`, so a failed turn shipped the answer
without the question.

**Done:** the install is pinned to `${{ vars.FACTORY_AGENT_VERSION || '2.1.224' }}`
in `design.yml`, `build-start.yml` and `build-turn.yml`, matching how the budget
variables already work. Artifacts now carry `.agent/in/` as well as
`.agent/out/`. Because a turn is a pure function of `.agent/in/`, those two
changes together make any turn replayable on a laptop with no runner involved —
see RUNBOOK, "Replaying a turn on your own machine". That is a better debugging
story than shelling into a live runner would have been, because it repeats.

**Not done, deliberately:** caching or pre-baking the CLI. Measured, a cold
install is ~2–4s and the payload is a ~270MB platform binary delivered as an
optional dependency. A cache restore or a container pull moves the same 270MB
over the same network, so on an ephemeral runner there is nothing to win. It
only pays off on a persistent self-hosted runner, where a layer cache survives
between jobs — see SELF-HOSTING.md.

**Watch for:** `create-github-app-token@v1` and the other actions are still
mutable major tags rather than commit SHAs. That is the remaining unpinned
dependency, and it is the one that mints the App token.

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
