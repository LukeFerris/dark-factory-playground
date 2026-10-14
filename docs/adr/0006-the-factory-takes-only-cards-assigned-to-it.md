# 6. The factory takes only cards assigned to it

Date: 2026-10-02

## Status

Accepted. Narrows which cards [0001](0001-factory-architecture.md) and
[0005](0005-jira-starts-the-poller.md) hand to the factory; the
claim-before-dispatch ordering is unchanged.

## Context

A card used to become the factory's by being in a column. Any card in _Ready
for design_ or _Ready for build_ was taken, and any comment on a card in _Design
review_, _In review_ or either _Blocked on …_ status was read by triage and
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
card in a _Ready for …_ column only when it is assigned to the factory's Jira
account (`assignee = currentUser()`; the poller runs as that account). Two
Automation flows cover the two orders, one on the transition and one on the
assignment, and the sweep's JQL carries the same condition.

**A comment takes a card back only when it is addressed to the factory.** In the
two _Blocked on …_ statuses the factory has asked something, so any comment from
a person is read, whoever the card is assigned to. In _Design review_ and _In
review_ most comments are between people, so only one that @mentions the
factory is read — the newest since the factory last spoke, so that a
colleague's reply underneath does not hide it. Either way, if the comment asks
for work, the factory takes the card back. Dragging a reviewed card to a _Ready
for …_ column and assigning it to the factory works too.

**The card goes back to a person, by name.** At the start of a turn the factory
records who the card goes back to: whoever dragged it into the _Ready for …_
column, from the card's history, falling back to whoever assigned it to the
factory; or, for a turn started by a comment, whoever wrote it. At the end it assigns
the card to them and opens the report comment with an @mention, because a
mention notifies whatever the project's notification scheme says about
assignment.

## Consequences

- People can share the board with the factory, and a card the factory is not
  assigned never costs a run.
- Starting work is two gestures instead of one. A card dragged into a _Ready_
  column without the assignment waits, silently; the runbook's _Nothing happens
  at all_ names that first.
- A comment in a review status starts a turn only if it @mentions the factory.
  A name typed as plain text is not a mention. Comments on the pull request in
  GitHub still start build turns (`build-turn.yml`'s `issue_comment` trigger),
  and that path is not gated by the Jira assignee.
- A review mention costs a Jira Automation condition (`{{comment.body}}`
  contains `[~accountid:…]`) as well as triage's own check, so ordinary review
  conversation never starts a run.
- After a triage turn the card goes to the person who answered, not to the
  person who originally sent it in. That is the person most likely to be waiting
  on the result.
