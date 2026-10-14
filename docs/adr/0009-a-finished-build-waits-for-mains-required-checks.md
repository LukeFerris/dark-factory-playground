# 9. A finished build waits for main's required checks

Date: 2026-10-13

## Status

Accepted. Adds a trusted job, `verify`, to the turn of
[0008](0008-code-the-agent-touched-never-shares-a-job-with-a-token.md), and a
fourth sender of `build-turn.yml` beside the three of
[0007](0007-cards-lock-while-the-factory-works-them.md).

## Context

A build turn that ended `ready_for_review` marked its PR ready and moved the
card to *In review* the moment it had pushed. The checks main requires ran
after that, and nothing in the factory read them. A reviewer could open a card
in *In review* and find a red PR. Whether the agent ran the suite itself was up
to the agent, and some suites cannot run inside its job: a full end-to-end
suite against a database the agent is not allowed to hold keys for, for
instance.

Running the full suite on every push is not the answer either. A multi-turn
build pushes once per turn, and a suite that takes a quarter of an hour would
run for every one of them.

## Decision

**A build turn's PR stays a draft until its checks are green.** `publish`
keeps it a draft on every build turn. Expensive suites can skip drafts.

**The turn asks for the full run when the agent says it is done.** A trusted
`verify` job, beside the preview and the walkthrough, runs only for a build
turn that validated and ended `ready_for_review`. It dispatches the workflows
named in `FACTORY_VERIFY_WORKFLOWS` on the PR's branch, so a draft-skipping
suite runs once, and waits for every check main requires (from its rulesets and
classic protection) on the pushed commit. It writes a verdict: green, red or
timeout. A run skipped before the dispatch does not count as passing until a
newer run replaces it.

**A dispatch, not a label.** The first version labelled the PR `factory:verify`
for suites to run on `pull_request: labeled`. But such a workflow runs on every
label anyone adds, skips on the ones that are not the factory's, and a skipped
run newer than a failed one passes branch protection. Adding a label would have
made a red PR mergeable.

**`report` acts on the verdict.** Green marks the PR ready and moves the card to
*In review*. Red starts another build turn, up to two in a row, and the next
turn's `task.md` carries the failing checks' logs. After two, or on a timeout,
or when the checks could not be read, the card goes to *Blocked on engineer*.

**The retry count is a workflow input.** `report` dispatches `build-turn.yml`
with `retry: n+1`. Nothing stores it, so any turn a person starts begins again
at 0. `report` is the only sender that sets it.

**Checks are read with the job's `GITHUB_TOKEN`.** `checks`, `statuses` and
`actions` read, in a job that runs no card code. The App needs no new
permission.

## Consequences

- A card can sit in *Building* for up to `FACTORY_VERIFY_TIMEOUT_MINUTES` (60 by
  default) after its agent has finished. The card is locked and the turn's run
  is still in progress, so neither the orphan sweep nor a second turn can take
  it.
- During an automatic retry, the card stays in *Building* and assigned to the
  factory. `report` dispatches before its own run ends, and a queued run counts
  as unfinished for the orphan sweep.
- Failing logs reach the agent. They are printed by the PR's code and its
  dependencies, so they are untrusted input, marked as such in `task.md`, read
  by a job that holds only the Anthropic key.
- Nothing about a failure is posted on the PR, because `gather` counts the
  factory's PR comments as turns. The next turn reads the checks afresh instead.
- A repository whose required suites skip drafts must name them in
  `FACTORY_VERIFY_WORKFLOWS` and let them run on `workflow_dispatch`. One that
  does not will time out every finished build. A suite that also runs on
  `ready_for_review` runs a second time once the factory marks the PR ready,
  unless it skips a commit it has already passed.
- A dispatched run tests the branch's head, not the merge with main that a
  `pull_request` run tests. Every turn merges main first, and `refresh` merges
  it again whenever main moves, so the two differ only between those.
- A design turn is unchanged: it still marks its PR ready when the design is
  done, and design PRs are not gated.
