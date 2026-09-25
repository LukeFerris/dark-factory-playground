# 3. The turn raises its own preview

- **Status:** Accepted
- **Date:** 2026-09-25
- **Supersedes:** the "The preview is raised by the pull request, not by a
  dispatch" decision in [0001](0001-factory-architecture.md)

(Numbered 3 because 2 is taken by an ADR sitting on an unmerged card branch.
Better a gap in the sequence than two documents with the same number.)

## Context

ADR 0001 put preview deployment in its own workflow, `build-setup.yml`,
triggered by the pull request's own `labeled` and `synchronize` events. The
reason was a real one and still holds: `packages: write`,
`deployments: write` and `id-token: write` must never be in scope while an
agent is running, and a separate workflow guarantees that.

What it got wrong was the *ordering*, and the symptom took five cards to
notice. `report` — the step that comments on the Jira card and transitions it
to *In review* — ran at the end of the agent's workflow. The label that
triggered the deploy was applied by `publish`, a step earlier in that same
workflow. So the sequence was:

1. `publish` pushes the branch, opens the PR, applies `factory:active`
2. `report` comments on Jira and moves the card to *In review*
3. *…the label event fires…*
4. `build-setup.yml` starts, builds an image, waits for a container

Two consequences, both visible on live cards:

- **Turn 1's Jira comment can never carry a preview link.** `report` reads the
  URL from `meta.json`, and on turn 1 nothing has written one yet — the deploy
  has not started. Confirmed on DF-4: PR #16's factory block has the preview
  URL; none of the card's Jira comments do.
- **The card reaches *In review* before there is anything to review.** *In
  review* is not a status, it is an instruction to a human to go and look. On
  the Azure backend the deploy that follows takes minutes.

The second is the real defect. Appending the link to the Jira comment once the
deploy finished would have made the card *eventually* correct; the card needs
to be correct *when it is read*.

## Decision

**A preview is raised by the turn that produced the code, never by a pull
request event.**

`build-start.yml` and `build-turn.yml` each gained a second job:

| Job | Holds | Does |
| --- | --- | --- |
| `turn` | `contents: read` | Runs the agent, validates, publishes, uploads `.agent/` as an artifact |
| `preview` | `packages: write`, `deployments: write`, `id-token: write`, `pull-requests: write` | Restores the artifact, deploys, waits for a 200, then reports |

`report` is the last step of `preview`. By the time the card moves, the preview
serving that turn's code has answered — or the job failed and the card says so.

The credential boundary is unchanged. **Jobs carry their own `permissions:`
block**, so a second job enforces it exactly as strongly as a second workflow
did, and it gets `needs:`, job outputs and same-run artifact passing for free.
The agent job never holds a deploy credential; nothing about that is weakened
by the two living in one file.

`build-setup.yml` loses both `pull_request` triggers and survives as a
`workflow_dispatch`-only manual retry — the thing a human runs when a
`preview` job failed and the fix is "deploy again", not "run the turn again".
It gained a `kickoff` boolean input, off by default, because turn 1 now posts
the kickoff comment itself.

## Consequences

**Good.** The card is correct when it is read. Turn 1's Jira comment carries a
preview link for the first time. There is one run to read per turn rather than
two, and the deploy's logs sit next to the agent's. The `labeled`-must-be-an-
App-token subtlety stops being load bearing for previews — it still matters for
the poller.

**Bad.** A turn's wall-clock now includes the image build, because reporting
waits on it. That is the cost of the guarantee and is not avoidable: to say
"there is something to look at" you have to wait until there is.

**Bad.** Pushing a commit to a card branch by hand no longer redeploys. Run
`build-setup.yml`. In practice a human pushing to a card branch was already
going to check the result by hand.

**Watch for.** The OIDC subject changed shape. Previews used to deploy on
`pull_request` events; they now deploy from `workflow_dispatch` and
`issue_comment`, both of which Actions runs against the default branch and
which therefore present `…:ref:refs/heads/main`. That federated credential
already existed — it was the retry path — so no Azure change was needed, but
the two subjects have swapped which one is the common case.
