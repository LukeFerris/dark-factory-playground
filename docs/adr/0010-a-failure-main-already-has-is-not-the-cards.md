# 10. A failure main already has is not the card's

Date: 2026-10-14

## Status

Accepted. Extends `verify` from
[0009](0009-a-finished-build-waits-for-mains-required-checks.md).

## Context

Since 0009, `verify` dispatches the workflows in `FACTORY_VERIFY_WORKFLOWS`
and then waits only for the checks main requires. A suite that skips drafts
but is not required was started and then ignored. On Workbench that was the
end-to-end suite. One PR left draft on the other gates alone, and the E2E run
that `ready_for_review` started cancelled the run `verify` had asked for.

Waiting for the suite does not fix that by itself. Workbench's main failed four
E2E tests that no card touched. Gating on the suite as it stood would have sent
every card back to build for failures it could not fix, and then to a person.
This happens often, and not only with E2E. Anything that changes outside the
PR, such as a package, a date or a service, can turn a check red on every branch
at once.

## Decision

**`verify` waits for the workflows it dispatches.** It finds each one's run by
the tag it dispatched it with, and waits for the run to finish within the same
budget as the required checks. A run that passes or skips counts as a pass.

**A failure is the PR's unless main fails the same way.** When a dispatched run
fails, `verify` reads which tests failed. It then dispatches the same workflow
on main for those tests only, at the main commit the branch was last merged
from. A test that fails there too is excused. A test that fails only on the
PR's branch is the PR's, and the card goes back to build as before. The agent
sees only the PR's own failures, and is told to leave main's alone.

**The test is mechanical.** The agent does not decide what is unrelated,
because it has every reason to excuse its own failures. Anything `verify`
cannot compare counts against the PR:

- no list of failed tests;
- a failure outside any test;
- an empty list from a run that failed;
- a baseline run that errors or never finishes.

**An excused failure gets a card.** `report` looks for an open card labelled
for that failure, `enki-main-red-<hash>`. If there is none, it creates one in
the space's first status, with the card's own work type, assigned to nobody. A
person decides when the fix is worth doing. `report` raises at most ten cards
in one report. The PR body and the card's comment list the excused failures
with their cards, so the reviewer sees everything that was red.

**Required checks are never excused.** A required check that is red blocks the
merge however the factory judges it, and the factory never bypasses one. So
excusing applies only to the workflows `verify` dispatches. A suite that main
fails cannot be made a required check until main is green, either by fixing or
by quarantining what fails there.

### What a verify workflow can offer

This is a menu, not an install. A workflow in `FACTORY_VERIFY_WORKFLOWS` already
accepts `workflow_dispatch` with a `pr` input, and that is all `verify` needs to
wait for it. To have its failures compared with main, it also:

- accepts `sha`, a commit to check out instead of the branch's head;
- accepts `tests`, a JSON array of test ids, and runs only those (all of them
  when it is empty);
- accepts `tag`, and ends the run's name with it (`run-name`), so `verify` can
  tell its own runs, and each card's baseline, from everyone else's;
- uploads an artifact named `failed-tests` holding `failed-tests.json`,
  `{"failed": [<id>, ...], "errors": <n>}`, whenever its tests ran. `errors`
  counts failures outside any test: a setup that threw, a server that never
  came up, or no report at all.

A test id is opaque to the factory. It only hands ids back in `tests`, so any
form works that the runner can take back as a filter. For a reference, see
Workbench's `e2e-tests.yml`. It uses Playwright's `[project] › file › describe ›
title`, which `--test-list` reads, and turns the JSON reporter's output into the
list with `jq`.

Points to settle when adapting it:

- **The baseline needs a concurrency group of its own.** If it shares the PR's
  group, it cancels the PR's run or is cancelled by it.
- **Ask for the report on the command line, not in the runner's config.** A
  baseline checks out an older commit, and that commit's config cannot be
  changed.
- **The runner has to report failures by test.** A runner that cannot gives no
  list, and the workflow's failures are never excused. They still count, as
  they did before this decision.
- **A sharded suite gathers its shards into one list.** `verify` reads one
  artifact from the run, so a last job merges the shards' lists into
  `failed-tests.json` and counts a shard that left none as an error.
  Otherwise a run whose other failures main shares is excused, and that
  shard's tests never ran. That job keeps the check's name.
  Give each shard a database of its own, and a baseline a single shard: it
  runs a handful of tests, and every shard pays the setup. Workbench's
  `e2e-tests.yml` runs three, which took its suite from about 19 minutes to
  about 10.

A workflow that offers none of this still works. If its dispatch is refused
with "Unexpected inputs", `verify` starts it without a tag and finds its run by
commit and time. Its failures are never excused.

## Consequences

- A baseline only runs when a dispatched run fails, and only for the tests that
  failed. It costs the suite's setup plus those tests, on top of the full run,
  and it counts against `FACTORY_VERIFY_TIMEOUT_MINUTES`. While main is red,
  that is every card.
- A baseline is dispatched on main, because a run uses the workflow file of the
  ref it is dispatched on. A main whose copy of the workflow cannot take the
  inputs fails the dispatch, and nothing is excused. Its check run lands on
  main's head commit, not on the PR.
- The baseline is the commit the branch was merged from, not main's head. It is
  the same code the PR's run had, apart from the PR. A failure that main has
  fixed since is still excused, and its card stays open until someone closes
  it.
- A test that the PR renamed or added does not exist at the baseline. It passes
  there, and so counts against the PR.
- When a PR's run fails only on excused tests, a suite that also runs on
  `ready_for_review` fails again once the PR is marked ready, unless it skips
  commits that already passed. The PR then shows a red check that its body
  explains.
- The labels mean one card per failure, however many PRs trip over it, until
  that card is done.
- A subtask cannot be raised without a parent. When the card being verified is
  a subtask, `report` raises nothing, but it still finds cards that are already
  open.
