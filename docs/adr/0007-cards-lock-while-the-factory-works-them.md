# 7. Cards lock while the factory works them

Date: 2026-10-05

## Status

Accepted. Builds on [0006](0006-the-factory-takes-only-cards-assigned-to-it.md),
which made a card the factory's by assignment; this makes it the factory's
*alone* for as long as a turn runs.

## Context

Several cards can be worked at once, each by its own run. Nothing stopped two
runs working the same card, or a person moving a card while a run had it.

- **Runs raced each other on one card.** design.yml, build-start.yml and
  build-turn.yml each had a concurrency group of their own, and build-turn's
  was keyed on the PR number for a PR comment and on the card key for a
  dispatch, so even one workflow could run twice for one card. A refresh leg
  shared build-start's group and no other.
- **The board raced the runs.** Say the factory is fixing a merge conflict and
  someone drags the card to *Ready for build*. That starts a second turn on the
  same branch, and the first turn's report then moves the card back from under
  it. A drag to *Done* or *Backlog* is overwritten the same way, without
  anyone being told.
- **A turn from a PR comment never touched the card.** It stayed in *In
  review* while a build ran against it, so nothing on the board showed it was
  in use.
- **There was no way to stop a turn from Jira.** You had to find the run in
  the Actions tab and cancel it, and the card then sat in *Designing* or
  *Building* until someone moved it by hand.

## Decision

**Jira holds the lock.** The Factory workflow sets two status properties on
*Designing* and *Building*:

- `jira.permission.transition.user`
- `jira.permission.assign.user`

Both are set to the factory's account id. On a card in either status, Jira
refuses a transition or an assignment by anyone else, admins included, and the
board will not accept the drop. No webhook, revert or apology comment is
needed. `bootstrap/jira.sh` reconciles the properties on every run.

Only status and assignee are locked. Comments, fields, links and attachments
stay open, because they are how people talk to a turn.

**Holding a card means being in a locked status.** Every way into a turn
already moves the card there first except the PR-comment path. That path now
goes through a new workflow, `build-comment.yml`, which reads the key from the
PR title and dispatches build-turn.yml with it. build-turn's first act is
`factory jira-take`, which moves the card to *Building*.

**One concurrency group per card.** design.yml, build-start.yml, build-turn.yml
and the refresh leg for the card all share `factory-card-<KEY>`, so only one of
them works a card at a time. A second one waits its turn.

**"@Enki stop" stops it.** A comment on a locked card that mentions the factory
and starts with "stop" triggers the *Factory: stop* Automation flow, which
dispatches `stop.yml` with the key. `factory stop` then:

1. checks everything again from Jira;
2. marks the comment as handled;
3. cancels the card's runs and waits for them to end, force-cancelling any that
   don't;
4. gives the card to the person who said stop and moves it back to the status
   it came from, assigning first and moving second.

If the run reported before the cancel landed, the card has already left the
lock and stays where the run put it.

**Orphans are let go.** A run that dies without reporting (cancelled by hand,
timed out, lost with its runner) leaves a card nobody can move. Every poller
pass runs `factory release-orphans`. A locked card with no unfinished run,
and in its status for more than ten minutes, goes back where it came from and
to whoever sent it in, with a comment explaining why. The sweep flow now
starts the poller while any card is locked, so this happens even on a quiet
board.

## Consequences

- A person cannot move a card the factory is working, and Jira does not say
  why. The *turn started* comment does: it says the card is locked and how to
  stop the turn.
- Admins are locked out too. That is the point, and it is also the risk: a
  card is stuck if the factory's code cannot let it go. The ways out are the
  stop command, the orphan check, `factory release-orphans` run locally with
  the bot's token, or removing the two properties in the workflow editor.
- Runs are found by name. Each card workflow sets `run-name: <KEY> …`. A run
  started before this change has no such name, is invisible to the orphan
  check, and could have its card let go under it. This applies once, at
  rollout.
- The refresh leg that merges main cleanly takes a minute and runs with the
  card in *In review*, unlocked. That is accepted: its push is not a force
  push, so a racing turn makes it fail loudly rather than overwrite anything.
- A mention other than stop, during a locked turn, is still not read until a
  later poll finds the card back in review. The stop flow starts on it and
  `factory stop` returns `not-a-stop`.
- Stopping costs one short run, and so does every other mention on a locked
  card, since the flow cannot tell them apart.

## Sources

- [Use workflow properties](https://support.atlassian.com/jira-cloud-administration/docs/use-workflow-properties/)
  (Atlassian Support): `jira.permission.*` properties, including the `user`
  form used here.
- [Workflows REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows/)
  (Atlassian Developer): `POST /rest/api/3/workflows` to read,
  `POST /rest/api/3/workflows/update` to write.
