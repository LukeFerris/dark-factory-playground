# Runbook

What to do when the factory does not do what `SETUP.md` said it would.

Start here, always:

```bash
bootstrap/smoke.sh              # names the missing secret, variable or status
bootstrap/trace.sh --once       # every card's status next to the recent runs
```

`trace.sh` without `--once` refreshes every five seconds and marks the cards
waiting on a human. Most "nothing is happening" turns out to be a card sitting
in a status the factory does not own, and that is the first thing it shows you.

Most failures are a missing repository variable or a renamed Jira status, and
`smoke.sh` names both.

## Reading a failure

Every turn uploads `.agent/in/` and `.agent/out/` as an artifact, retained 14
days. `out/` holds `result.json` (what the agent decided) and `transcript.json`
(what it actually did); `in/` holds the card, the design and `meta.json` — the
exact inputs the agent was handed. The Jira comment always links the Actions run
that produced it.

```bash
gh run view <run-id> --repo "$GH_OWNER/$GH_REPO" --log-failed
gh run download <run-id> --repo "$GH_OWNER/$GH_REPO"
jq . design-DF-1-*/result.json
```

The CLI's exit codes are a contract:

| Code | Means | Look at |
| --- | --- | --- |
| 0 | Fine | — |
| 1 | Unexpected error | The step log |
| 2 | Jira rejected the credentials | `JIRA_BOT_EMAIL` variable, `JIRA_BOT_TOKEN` secret |
| 3 | No transition to that status | Jira status names vs `STATUS_TRANSITIONS` |
| 4 | Validation rejected the turn | `result.json`'s `reason` |

### Replaying a turn on your own machine

The runner is destroyed when the job ends, so there is nothing to shell into.
There does not need to be: a turn is a pure function of `.agent/in/`. The agent
reads files and writes files and touches nothing else, so the artifact is a
complete reproduction and replays locally, as many times as you like, for free.

```bash
gh run download <run-id> --repo "$GH_OWNER/$GH_REPO"
rm -rf .agent/in && cp -R <artifact-dir>/in .agent/in
```

Then run the same `claude -p` invocation as the workflow's Agent step. Copy it
from `.github/workflows/design.yml` or `build-turn.yml` rather than from here,
so the allow-list cannot drift out of sync with what actually ran.

**Install the same CLI version, or it is not the same turn.** Agent steps pin
`@anthropic-ai/claude-code` to the repository variable `FACTORY_AGENT_VERSION`,
defaulting to the version in the workflow. Read the pin, do not guess it:

```bash
gh variable get FACTORY_AGENT_VERSION --repo "$GH_OWNER/$GH_REPO" 2>/dev/null \
  || grep -m1 claude-code .github/workflows/design.yml
```

Bump it deliberately — the flag surface is version-coupled, and a CLI release
can change how a turn behaves:

```bash
gh variable set FACTORY_AGENT_VERSION --repo "$GH_OWNER/$GH_REPO" --body 2.1.230
```

---

## Nothing happens at all

**The poller is not running.** Scheduled workflows are disabled automatically
after 60 days of repository inactivity, and silently.

```bash
gh workflow list --repo "$GH_OWNER/$GH_REPO" --all
gh workflow enable poller.yml --repo "$GH_OWNER/$GH_REPO"
gh workflow run poller.yml --repo "$GH_OWNER/$GH_REPO"   # start a run now
```

**The workflows are not registered.** They only exist once they are on the
default branch. `smoke.sh` checks this.

**The card is not in a *Ready for …* status.** Those are the only two entry
points. Check the card, not the pipeline.

**The App cannot dispatch.** The poller dispatches with the App token precisely
because a `workflow_dispatch` made with `GITHUB_TOKEN` does not start a new run.
If the poller logs a successful dispatch and nothing runs, check that the App
still has **Actions: read and write**.

---

## Every run fails at "Mint App token"

```
Invalid keyData … ERR_OSSL_ASN1_NOT_ENOUGH_DATA
```

`FACTORY_APP_KEY` is not a PEM. OpenSSL is saying the key it was given ran out
of bytes, which usually means the secret holds something much shorter than a
key — an empty value, a path, or a shell artefact. `smoke.sh` cannot catch this:
secrets are write-only, so it can only confirm the name exists.

Set it again, from the file, and never through a shell variable:

```bash
gh secret set FACTORY_APP_KEY --repo "$GH_OWNER/$GH_REPO" < secrets/factory-app.pem
```

Check the file first — `openssl rsa -in secrets/factory-app.pem -noout -check`
should say `RSA key ok`. If it does not, the key was truncated on download and
there is no repairing it: generate a new one on the App's page, which also
revokes the old one.

A `401` from the same step is a different fault — the key is valid but does not
belong to `FACTORY_APP_ID`, or the App is not installed on this repository.

---

## A card is claimed but nothing is running

The poller moves a card to *Designing* / *Building* **before** dispatching, so
that a failed dispatch leaves the card visibly claimed rather than handing it to
two agents on the next poll. Both entrances do this — the status sweep and
comment triage — so a card can arrive here from either.

**Read the card before the logs.** A dispatched turn comments *design turn N
started* within a few seconds of the run beginning. A card in *Designing* with
no such comment was claimed and never dispatched, which is this section. A card
that has one, and nothing since, has a run that started and is either still
going or died — that is [Reading a failure](#reading-a-failure), and the comment
links the run. The comment is best-effort, so its absence is evidence rather
than proof; the Actions tab settles it.

If a card sits in *Designing* with no run:

```bash
gh workflow run design.yml -f key=DF-1 --repo "$GH_OWNER/$GH_REPO"
```

A card claimed into *Building* by triage needs the same dispatch against
`build-turn.yml`, which takes the key rather than the PR:

```bash
gh workflow run build-turn.yml -f key=DF-1 --repo "$GH_OWNER/$GH_REPO"
```

Triage says so explicitly when this happens, in the poller's log:

```
::error::DF-1 was moved to Building but build-turn.yml could not be dispatched
```

That branch of `act()` is the only one that leaves the card claimed with nothing
running, and it is deliberate: the alternative is moving the card back, which
races the next poll. Re-dispatching by hand is the recovery.

---

## A turn was rejected by validation

The Jira comment says which paths were out of scope. Read `result.json`'s
`reason`.

This is usually the agent doing exactly what it should not: editing
`app/eslint.config.js` to silence a lint error, or a `tsconfig` to silence a
type error. The manual tells it to report `blocked` instead. If it keeps trying,
the design is probably asking for something the allow-list does not permit —
fix the design, not the allow-list.

To genuinely widen a stage's scope, edit `ALLOWED_PATHS` in
`factory/src/schema.ts`, run `npm run --silent factory -- emit-schema`, and
update the corresponding section of the stage's manual. CI fails if the schema
and the committed `.agent/result.schema.json` disagree. Never add anything under
`.agent/`, `.github/`, `factory/` or `bootstrap/` — that is the boundary itself.

---

## A build turn will not start from a comment

`build-turn.yml` has two entrances and they fail differently. A comment on the
**pull request** goes through the four guards below. A comment on the **card**
goes through triage instead, which dispatches the workflow with a key and no
guards at all — if that is the path you expected, read *A comment on a card did
nothing* further down instead of this section.

The pull-request path requires all four of:

1. the comment is on a pull request
2. the PR carries **`factory:active`**
3. the commenter is **not** `FACTORY_BOT_LOGIN`
4. `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`

```bash
gh pr view <n> --repo "$GH_OWNER/$GH_REPO" --json labels,headRefName
gh variable get FACTORY_BOT_LOGIN --repo "$GH_OWNER/$GH_REPO"
```

`factory:active` is removed when the PR closes. Re-add it to resume work on a
reopened PR.

If `FACTORY_BOT_LOGIN` is wrong or unset, guard 3 fails open and the factory's
own report comment grants the next turn — a loop. That variable is worth getting
right; it is `<app-slug>[bot]`.

The dispatch path has one failure of its own. It resolves the PR by looking for
an open one whose head branch starts with `card/<KEY>-`, and says so if there is
none:

```
::error::DF-1 was routed to a build turn but has no open pull request.
```

That means triage sent a card to the build agent before the design was approved
and `build-start.yml` had opened the branch. Nothing is broken — move the card
to *Ready for build* by hand and let the normal entrance run. Ask the same
question locally with:

```bash
npm run --silent factory -- card-pr DF-1
```

---

## A comment on a card did nothing

Comments on cards in *Design review*, *In review*, *Blocked on architect* and
*Blocked on engineer* are read by triage on each poll, which decides whether to
start an agent. Nothing happening is the **designed** outcome for most comments,
so before treating it as a fault, see what triage actually decided:

```bash
npm run --silent factory -- triage --dry-run
```

That prints a line per card it would act on and changes nothing — no transition,
no comment, no mark, no dispatch. It is safe to run against the live board while
the poller is running. To see what a past pass decided, read the poller's log:
the reasoning is only ever there, never on the card.

```bash
gh run list --workflow poller.yml --repo "$GH_OWNER/$GH_REPO" --limit 5
gh run view <run-id> --repo "$GH_OWNER/$GH_REPO" --log | grep '^triage:'
```

`--dry-run` printing nothing, with a comment plainly on the card, is one of
five things:

1. **The card is in a status triage does not watch.** *Designing* and *Building*
   are skipped because a turn is already running on that branch; *Backlog*,
   *Done* and the two *Ready for …* columns are skipped because they are not
   the factory's to act on. Comment on a card in *Backlog* and nothing will
   ever read it.
2. **The comment is not the newest one.** Triage looks only at the last comment
   on the card, and if the factory commented after you did, the card reads as
   waiting on nobody. Comment again.
3. **The comment was already considered.** Its id is stored on the card in a
   hidden issue property, so each comment is read exactly once even when the
   answer was `none`. Read the mark:
   ```bash
   curl -s -u "$JIRA_BOT_EMAIL:$JIRA_BOT_TOKEN" \
     "$JIRA_BASE/rest/api/3/issue/DF-1/properties/factory-triage" | jq .value
   ```
   `{"commentId":"10042","action":"none",…}` means it was read and judged not to
   need an agent. A `404` means no comment on this card has ever been triaged.
   To force a re-read, comment again — do not delete the property, since the
   next comment supersedes it anyway.
4. **The comment was posted by the factory's account.** Triage's first filter is
   *the newest comment is not ours*, so a factory that runs as you sees every
   card as permanently answered by itself. Check both ends:
   ```bash
   curl -s -u "$JIRA_BOT_EMAIL:$JIRA_BOT_TOKEN" \
     "$JIRA_BASE/rest/api/3/myself" | jq -r '.accountId, .displayName'
   ```
   If that `accountId` is the author of your comment, see *Jira returns 401 or
   403* below and Checkpoint B.
5. **It is a worklog, a description edit or a status note**, none of which is a
   comment. Only comments count.

If none of those apply, the model decided `none` — which it is told to do
whenever it is unsure, because a missed comment costs one drag of the card and a
wrongly-started turn spends an agent run. The card is never stuck: moving it to
*Ready for design* or *Ready for build* by hand starts a fresh turn, and the
agent reads the whole comment thread regardless of how it was woken.

### Triage itself is failing

Three warnings can appear in the poller's log, and they mean different things:

| Log line | State it leaves | What to do |
| --- | --- | --- |
| `::warning::could not triage DF-1: …` | Nothing happened; no mark written | Nothing — the next pass reconsiders the same comment. Persisting means the model call is failing; check `ANTHROPIC_API_KEY` |
| `::warning::could not move DF-1 to Designing: …` | Nothing happened; no mark written | Usually a renamed Jira status. `bootstrap/smoke.sh` asserts all ten |
| `::error::DF-1 was moved to Building but build-turn.yml could not be dispatched` | Card claimed, nothing running | Dispatch by hand — see *A card is claimed but nothing is running* |

A fourth, `::warning::moved DF-1 but could not say why`, is cosmetic: the turn
still starts, the card just does not carry the factory's explanation.

The first of those is the one to watch, because it is the only step that talks
to a third party. `poller.yml` needs `ANTHROPIC_API_KEY` — the same secret the
agent steps use — and optionally `FACTORY_TRIAGE_MODEL`, which is a repository
**variable** and defaults to `claude-haiku-4-5-20251001` when unset.
`smoke.sh` does not check the variable, since not setting it is the normal
case:

```bash
gh variable set FACTORY_TRIAGE_MODEL --repo "$GH_OWNER/$GH_REPO" --body claude-haiku-4-5-20251001
```

If the whole pass fails, the poller says so and carries on:

```
::warning::the triage pass failed; the next one will pick up the same comments
```

The order inside `act()` — move, explain, mark, dispatch — is chosen so that
every half-failure leaves the least-bad state, and the mark comes late for that
reason: a card that could not be moved is not recorded as considered, so the
next pass tries again. The one exception is the dispatch failure above, which
marks the comment and leaves the card claimed. That is why it is the only one
logged as an `::error::` rather than a warning.

---

## The card did not move, but the PR is fine

Exit code 3: the comment posted, the transition did not. `factory report` treats
this as non-fatal on purpose, so that re-running does not double-comment.

```bash
npm run --silent factory -- jira-transition DF-1 "In review"
```

If that fails too, the status name in Jira no longer matches
`STATUS_TRANSITIONS`. `smoke.sh` lists all ten.

*Done* is the exception and does not belong here: it is restricted to the bot
by a workflow condition, and nothing but `production.yml` should be setting it.
See *The PR is merged but the card is still in review*.

---

## Jira returns 401 or 403

Exit code 2. Atlassian API tokens expire, and the message is the same as for a
wrong email.

The workflows run as the factory's own Jira account, not yours, so test that
one — `JIRA_BOT_EMAIL`/`JIRA_BOT_TOKEN` from `.env`, not `JIRA_USER`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -u "$JIRA_BOT_EMAIL:$JIRA_BOT_TOKEN" "$JIRA_BASE/rest/api/3/myself"
```

200 locally but 401 in Actions means the repository copy is stale:

```bash
gh secret set JIRA_BOT_TOKEN --repo "$GH_OWNER/$GH_REPO"   # paste the bot's token
gh variable set JIRA_BOT_EMAIL --repo "$GH_OWNER/$GH_REPO" --body "$JIRA_BOT_EMAIL"
```

**Never set `JIRA_BOT_EMAIL` to your own address to get past this.** It
authenticates fine and the factory then comments as you, at which point the
poller can no longer tell your answers from the design agent's own questions and
every card in *Blocked on architect* stays there silently. See
`docs/factory/SETUP.md`, Checkpoint B.

---

## The preview is missing

First: which backend?

```bash
gh variable get FACTORY_PREVIEW_BACKEND --repo "$GH_OWNER/$GH_REPO"   # ghcr or azure
```

**The `preview` job failed.** A preview is raised by the turn that produced the
code, in a second job of the same run — not by a pull request event, and not by
a separate workflow. So there is only one run to read, and it is the build run:

```bash
gh run list --workflow build-start.yml --repo "$GH_OWNER/$GH_REPO" --limit 5
gh run list --workflow build-turn.yml  --repo "$GH_OWNER/$GH_REPO" --limit 5
gh run view <run-id> --repo "$GH_OWNER/$GH_REPO" --log-failed
```

If the `turn` job is green and `preview` is red, the code is on the branch and
the deploy is what failed. Fix the cause, then redeploy without re-running the
agent:

```bash
gh workflow run build-setup.yml -f pr=<n>
```

That workflow is the manual retry and nothing dispatches it. Add
`-f kickoff=true` **only** if turn 1's preview job died before posting the
kickoff comment — otherwise you get a second one.

**The card is in "In review" but there is no preview.** This should no longer
be reachable: `report` is the last step of the `preview` job, after the deploy
has answered. If you see it, the `preview` job's `Report` step ran while
`DEPLOYABLE` was false — which means validation rejected the turn, and the card
should be in *Blocked on engineer*, not *In review*. Read the Jira comment.

**The preview is stale rather than missing.** Every build turn redeploys before
reporting, so a preview stuck on turn 1's code means the later turns' `preview`
jobs are failing. They are jobs within those runs, not runs of their own.

**A commit pushed to the card branch by hand did not redeploy.** Correct, and
deliberate — pushing no longer triggers anything. Run `build-setup.yml` for it.

### `ghcr` backend

The `preview` job needs `packages: write` and `deployments: write`, and the App
needs Packages and Deployments write. If the image pushed but the Deployment did
not appear, it is the App's permissions; a permission added after installation
needs accepting on the installation page. Nothing serves the image — that is
expected, see `SELF-HOSTING.md`.

### `azure` backend

**The estate is real and one preview has come up through it** — PR #16, on a
re-run. Teardown has never run. The Terraform re-plans clean, so if something
fails here, suspect the `az` calls in `azure.ts` before the infrastructure.

The estate is Terraform, so the first question for anything that smells like
configuration is whether the estate still matches it. A plan changes nothing
and answers that in one command:

```bash
az login
infra/azure/apply.sh            # any diff here is drift; empty is a clean bill
```

A variable someone set by hand shows up as a diff, because Terraform owns all
twelve of them.

| Symptom | Usually |
| --- | --- |
| `AADSTS700213` / no matching federated identity | The federated credential's subject does not match. Both are needed: `repo:<owner>/<repo>:pull_request` for the PR events and `repo:<owner>/<repo>:ref:refs/heads/main` for the dispatch retry |
| `Missing required environment variable AZURE_…` | A repository variable is unset; the message names which. `apply.sh` sets all of them — a missing one means the apply did not finish, or somebody deleted it |
| `az acr build` denied | `Contributor` on the resource group covers ACR Tasks by inheritance. If it is denied, the role assignment is missing rather than too narrow |
| `--user-assigned` denied on create | The CI principal lacks `Managed Identity Operator` **on the identity**. `Contributor` on the group is not enough to attach one |
| Create succeeds, app never starts, `ImagePullFailure` | The identity named by `AZURE_PREVIEW_IDENTITY` has no `AcrPull` on the registry. If that variable is unset the code falls back to `--registry-identity system`, which only grants it when the deploying principal can make role assignments — see SELF-HOSTING |
| `no ingress FQDN` | The app exists but ingress is internal or absent. Delete it and let the next push recreate it |
| `… did not answer within 180s` | The image built and deployed but the container is not serving. This is the warm-up step refusing to publish a link to a dead preview, so read the console logs below — the build was not the problem |
| The URL resolves but the first request hangs ~20 seconds | Cold start. `--min-replicas 0` is deliberate; the launcher is what makes it legible. See below |

```bash
az containerapp show -n df-preview-pr-<n> -g "$AZURE_RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv
az containerapp logs show -n df-preview-pr-<n> -g "$AZURE_RESOURCE_GROUP" --tail 50
```

**The launcher** is the loading page in front of every preview link a human
clicks — a static page on Azure Storage, always awake, which forwards as soon
as the app answers. Its URL is `AZURE_PREVIEW_LAUNCHER`, and the raw preview
URL it was asked to open is in its own address bar under `?u=`, so anything it
cannot fix can be diagnosed by opening that directly.

| Symptom | Usually |
| --- | --- |
| "That link was not opened" | The `?u=` target is not an `https://…azurecontainerapps.io` URL. The page refuses anything else rather than being an open redirect |
| It spins past "taking longer than usual" | The preview is not coming up. Open the `?u=` URL directly and check the app's logs; if the PR is closed, its preview was torn down and there is nothing to wake |
| The page itself 404s | The blob was never uploaded. `infra/azure/apply.sh` re-uploads it; it is one `azurerm_storage_blob` |
| An edit to the page has not appeared | It is served `no-cache`, so this is Terraform not having applied rather than a stale browser |

**Previews that outlived their PRs** are a running cost, not just clutter.
`build-teardown.yml` deletes the app and the image tag, and logs rather than
fails if either step cannot. To sweep by hand:

```bash
az containerapp list -g "$AZURE_RESOURCE_GROUP" --query "[].name" -o tsv | grep -- '-preview-pr-'
az containerapp delete -n df-preview-pr-<n> -g "$AZURE_RESOURCE_GROUP" --yes
```

If `az containerapp list` returns `(InvalidApiVersionParameter)`, the CLI's
`containerapp` extension is older than the API version it is asking for. Update
it (`az extension update -n containerapp`), or list through the generic
resource API, which does not pin one:

```bash
az resource list -g "$AZURE_RESOURCE_GROUP" \
  --resource-type Microsoft.App/containerApps --query "[].name" -o tsv
```

---

## The PR is merged but the card is still in review

`production.yml` is what closes a card, and it does two things in order: deploy
production, then move the card to *Done*. Which one failed decides what to do,
and the run log says plainly.

```bash
gh run list --workflow production.yml --repo "$GH_OWNER/$GH_REPO" --limit 5
```

| What the run shows | Meaning |
| --- | --- |
| No run at all | The gate did not match. It needs `merged == true`, a `card/` head branch, and `FACTORY_PREVIEW_BACKEND == azure`. Closing a PR without merging is a no-op by design, and on the `ghcr` backend shipping is skipped entirely |
| Failed in **Deploy production** | Nothing shipped and the card is correctly still in review. Same failures as a preview — see the `azure` table above, substituting `df-production` for the app name |
| `production-up printed no URL; refusing to close the card` | The deploy step did not end with a URL on stdout. The card is deliberately left alone rather than closed on a guess |
| Failed in **Move the card to Done** | **Production is live and the card is wrong.** The Jira call failed after the site came up |

That last row is the one that needs a decision, because the transition into
*Done* is restricted to the bot by a Jira workflow condition — and conditions
bind administrators too, so you cannot finish the move by dragging the card.
The intended fix is to re-run the failed job:

```bash
gh run rerun <run-id> --failed --repo "$GH_OWNER/$GH_REPO"
```

That redeploys the same commit, which is idempotent, and retries the
transition. If it keeps failing, the usual cause is the condition itself: the
bot is not in the group the condition names, so Jira stops offering the
transition and `ship` reports `has no transition to "Done"` rather than a 403.
Check what the bot is actually offered:

```bash
curl -s -u "$JIRA_BOT_EMAIL:$JIRA_BOT_TOKEN" \
  "$JIRA_BASE/rest/api/3/issue/$KEY/transitions" | jq -r '.transitions[].to.name'
```

If *Done* is missing from that list, fix the group membership — see the
*Locking Done to the factory* section of `SETUP.md` — and re-run. A card left
in review with production already serving is untidy, not dangerous; resist the
temptation to add a second transition into *Done* to get out of it, because
that is the escape hatch [ADR 0004](../adr/0004-production-on-merge-and-a-done-nobody-can-fake.md)
deliberately did not build.

**Rolling production back** is deploying the previous commit's tag. Every
merge keeps its own:

```bash
az acr repository show-tags -n "$AZURE_ACR_NAME" --repository "$AZURE_PREVIEW_REPOSITORY" \
  --orderby time_desc -o tsv | grep '^main-' | head
az containerapp update -n df-production -g "$AZURE_RESOURCE_GROUP" \
  --image "$AZURE_ACR_NAME.azurecr.io/$AZURE_PREVIEW_REPOSITORY:main-<sha>"
```

The next merge will deploy over it, so a rollback buys time rather than
settling anything.

---

## Costs are climbing

Each agent step is capped by `--max-budget-usd`, from the repository variables
`FACTORY_DESIGN_BUDGET_USD` (default 5) and `FACTORY_BUILD_BUDGET_USD`
(default 10). Lower them:

```bash
gh variable set FACTORY_BUILD_BUDGET_USD --repo "$GH_OWNER/$GH_REPO" --body 3
```

There is no auto-continue, so cost scales with turns granted, which scales with
comments written. If a card is burning money, stop commenting on it.

---

## Stop everything

```bash
gh workflow disable poller.yml --repo "$GH_OWNER/$GH_REPO"
```

Nothing new starts. In-flight runs continue; `gh run cancel <id>` each one. To
stop a single card, remove `factory:active` from its PR.
