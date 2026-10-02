# 6. The factory takes only cards assigned to it

Date: 2026-10-02

## Status

Accepted. Narrows which cards [0001](0001-factory-architecture.md) and
[0005](0005-jira-starts-the-poller.md) hand to the factory; the
claim-before-dispatch ordering is unchanged.

## Context

A card used to become the factory's by being in a column. Any card in *Ready
for design* or *Ready for build* was taken, and any comment on a card in *Design
review*, *In review* or either *Blocked on …* status was read by triage and
could start a turn.

That makes the board the factory's alone. A team that wants to keep its own
cards on it — work done by hand, or not yet meant for an agent — cannot, because
the only way to stop the factory picking a card up is to keep it out of the
columns that describe it. And in the review statuses people talk to each other
about the work; every such comment cost a triage call and could be read as an
instruction.

The hand-back mattered too. A turn returned the card to whoever held it before,
which for a card nobody had assigned was nobody, so the person waiting on the
work heard about it only if they were watching the card.

## Decision

**A card is sent in by column and assignment together.** The poller takes a
card in a *Ready for …* column only when it is assigned to the factory's Jira
account (`assignee = currentUser()`; the poller runs as that account). Two
Automation flows cover the two orders, one on the transition and one on the
assignment, and the sweep's JQL carries the same condition.

**Only questions are answered by comment.** Triage reads the two *Blocked on …*
statuses, where the factory has asked something, regardless of who the card is
assigned to, and takes the card back when a comment answers it. *Design review*
and *In review* are not read: to send a reviewed card back, a person drags it to
a *Ready for …* column and assigns it to the factory.

**The card goes back to a person, by name.** At the start of a turn the factory
records who the card goes back to: whoever dragged it into the *Ready for …*
column, from the card's history, falling back to whoever assigned it to the
factory; or, for a triage turn, whoever wrote the comment. At the end it assigns
the card to them and opens the report comment with an @mention, because a
mention notifies whatever the project's notification scheme says about
assignment.

## Consequences

- People can share the board with the factory, and a card the factory is not
  assigned never costs a run.
- Starting work is two gestures instead of one. A card dragged into a *Ready*
  column without the assignment waits, silently; the runbook's *Nothing happens
  at all* names that first.
- A comment in a review status no longer starts a turn. Comments on the pull
  request in GitHub still do (`build-turn.yml`'s `issue_comment` trigger), and
  that path is not gated by the Jira assignee.
- After a triage turn the card goes to the person who answered, not to the
  person who originally sent it in. That is the person most likely to be waiting
  on the result.
