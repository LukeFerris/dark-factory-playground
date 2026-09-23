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

## A design question was answered but the card never came back

A card in *Blocked on architect* returns to *Designing* on its own once someone
replies on it. The poller's test is the narrowest one that can work: **the newest
comment on the card is not the factory's**. Ask it directly:

```bash
npm run --silent factory -- jira-answered "Blocked on architect"
```

Keys printed are cards the next poll will pick up. Nothing printed, with a card
plainly answered, is one of three things:

1. **The answer is not the newest comment.** Something commented after the human
   did — including the factory itself, if a turn ran in between. Reply again;
   the check only looks at the last one.
2. **The reply was posted by the factory's account.** Check who Jira thinks
   wrote it, and who the factory is:
   ```bash
   npm run --silent factory -- jira-answered "Blocked on architect"  # exit 2 = auth
   curl -s -u "$JIRA_BOT_EMAIL:$JIRA_BOT_TOKEN" \
     "$JIRA_BASE/rest/api/3/myself" | jq -r '.accountId, .displayName'
   ```
   If that `accountId` is the one on the answering comment, the factory is
   running as you — see *Jira returns 401 or 403* below, and Checkpoint B.
3. **The reply is a Jira worklog, description edit or status note**, none of
   which is a comment. Only comments count.

The card is not stuck: moving it to *Ready for design* by hand starts a fresh
design turn, and the agent still reads the whole comment thread.

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
