# Runbook

What to do when the factory does not do what `SETUP.md` said it would.

Start here, always:

```bash
bootstrap/smoke.sh              # names the missing secret, variable or status
gh run list --repo "$GH_OWNER/$GH_REPO" --limit 10
```

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
gh workflow run poller.yml --repo "$GH_OWNER/$GH_REPO"   # don't wait 10 minutes
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

## A card is claimed but nothing is running

The poller moves a card to *Designing* / *Building* **before** dispatching, so
that a failed dispatch leaves the card visibly claimed rather than handing it to
two agents on the next poll. If a card sits in *Designing* with no run:

```bash
gh workflow run design.yml -f key=DF-1 --repo "$GH_OWNER/$GH_REPO"
```

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

`build-turn.yml` requires all four of:

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

---

## The card did not move, but the PR is fine

Exit code 3: the comment posted, the transition did not. `factory report` treats
this as non-fatal on purpose, so that re-running does not double-comment.

```bash
npm run --silent factory -- jira-transition DF-1 "In review"
```

If that fails too, the status name in Jira no longer matches
`STATUS_TRANSITIONS`. `smoke.sh` lists all ten.

---

## Jira returns 401 or 403

Exit code 2. Atlassian API tokens expire, and the message is the same as for a
wrong email.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -u "$JIRA_USER:$JIRA_TOKEN" "$JIRA_BASE/rest/api/3/myself"
```

200 locally but 401 in Actions means the repository copy is stale:

```bash
gh secret set JIRA_BOT_TOKEN --repo "$GH_OWNER/$GH_REPO"
gh variable set JIRA_BOT_EMAIL --repo "$GH_OWNER/$GH_REPO" --body "$JIRA_USER"
```

---

## The preview is missing

First: which backend?

```bash
gh variable get FACTORY_PREVIEW_BACKEND --repo "$GH_OWNER/$GH_REPO"   # ghcr or azure
```

**`build-setup.yml` never ran.** It triggers on the PR's own `labeled` and
`synchronize` events, not on a dispatch from `build-start.yml`. Check the label
is actually there:

```bash
gh pr view <n> --repo "$GH_OWNER/$GH_REPO" --json labels
gh run list --workflow build-setup.yml --repo "$GH_OWNER/$GH_REPO" --limit 5
```

If `factory:active` is present but no run exists, the label was probably applied
with `GITHUB_TOKEN` rather than the App token — events made with `GITHUB_TOKEN`
do not start workflow runs. `factory publish` uses the App token precisely for
this. Re-applying the label by hand also works, and so does the manual path:

```bash
gh workflow run build-setup.yml -f pr=<n>
```

**The preview is stale rather than missing.** It should follow the branch — the
`synchronize` trigger re-raises it on every push. A preview stuck on turn 1
means the `synchronize` runs are failing; read them, they are separate runs.

### `ghcr` backend

`build-setup.yml` needs `packages: write` and `deployments: write`, and the App
needs Packages and Deployments write. If the image pushed but the Deployment did
not appear, it is the App's permissions; a permission added after installation
needs accepting on the installation page. Nothing serves the image — that is
expected, see `SELF-HOSTING.md`.

### `azure` backend

**UNVERIFIED — this path has not been run against a live subscription.** Expect
the first failures to be setup rather than code.

| Symptom | Usually |
| --- | --- |
| `AADSTS700213` / no matching federated identity | The federated credential's subject does not match. It needs one for `repo:<owner>/<repo>:pull_request`, not just `ref:refs/heads/main` |
| `Missing required environment variable AZURE_…` | A repository variable is unset; the message names which |
| `az acr build` denied | The service principal needs `AcrPush` on the registry |
| Create succeeds, app never starts, `ImagePullFailure` | The app's managed identity has no `AcrPull`. `--registry-identity system` only grants it if the deploying principal can make role assignments — see SELF-HOSTING |
| `no ingress FQDN` | The app exists but ingress is internal or absent. Delete it and let the next push recreate it |
| The URL resolves but the first request hangs a few seconds | Cold start. `--min-replicas 0` is deliberate |

```bash
az containerapp show -n df-preview-pr-<n> -g "$AZURE_RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv
az containerapp logs show -n df-preview-pr-<n> -g "$AZURE_RESOURCE_GROUP" --tail 50
```

**Previews that outlived their PRs** are a running cost, not just clutter.
`build-teardown.yml` deletes the app and the image tag, and logs rather than
fails if either step cannot. To sweep by hand:

```bash
az containerapp list -g "$AZURE_RESOURCE_GROUP" --query "[].name" -o tsv | grep -- '-preview-pr-'
az containerapp delete -n df-preview-pr-<n> -g "$AZURE_RESOURCE_GROUP" --yes
```

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
