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

Every turn uploads `.agent/out/` as an artifact, retained 14 days. It contains
`result.json` (what the agent decided) and `transcript.json` (what it actually
did). The Jira comment always links the Actions run that produced it.

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

The preview is a stub: an image at `ghcr.io/<owner>/<repo>:pr-<n>` and a GitHub
Deployment pointing at it. Nothing serves it — see `SELF-HOSTING.md`.

`build-setup.yml` needs `packages: write` and `deployments: write`, and the App
needs Packages and Deployments write. If the image pushed but the Deployment did
not appear, it is the App's permissions; a permission added after installation
needs accepting on the installation page.

To retry: `gh workflow run build-setup.yml -f pr=<n>`.

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
