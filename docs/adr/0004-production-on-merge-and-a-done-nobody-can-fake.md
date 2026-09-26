# 4. Production on merge, and a Done nobody can fake

Date: 2026-09-25

## Status

Accepted. Extends [0001](0001-factory-architecture.md) and follows the ordering
rule established by [0003](0003-the-turn-raises-its-own-preview.md).

## Context

The factory could design, build, preview and review software. It had never
shipped any.

A merged pull request landed code on `main`, `ci.yml` ran the tests against it,
and `build-teardown.yml` destroyed the preview it had been demonstrated on.
Nothing replaced that preview. Grepping the repository for "production" returned
nothing at all; Azure was hosting three Container Apps, all of them previews.
The end state of a card was code on the default branch, running nowhere.

The card was in the same condition. Nothing moved a card to *Done* — not on
merge, not ever. A human dragged it when they remembered to, which meant *Done*
recorded somebody's housekeeping rather than any fact about the software. The
two halves were also independent: you could merge without the card moving, or
move the card with nothing merged.

## Decision

**A merged pull request deploys production, and then the factory moves the card
to *Done*. Nobody else can.**

Three parts, and the order between the first two is the substance of the
decision.

### Production is a Container App like any other

Same registry, same Container Apps environment, same managed identity, same
`app/Dockerfile`, built by the same `az acr build`. A production environment
assembled differently from the thing that was reviewed is not a preview of
anything, so the differences are held to two:

| | Preview | Production |
| --- | --- | --- |
| Name | `df-preview-pr-<n>`, one per PR | `df-production`, one forever |
| `min-replicas` | 0 — costs nothing unvisited | **1** — never sleeps |
| Image tag | `pr-<n>` | **`main-<sha>`**, immutable |
| Torn down | on PR close | never |
| Link | through the launcher | direct |

`min-replicas: 1` removes the cold start, which is why production needs no
launcher in front of it. It is also the first thing in this factory that costs
money while nobody is looking at it. `max-replicas: 2` lets a new revision come
up beside the old one during a deploy; at rest only one replica runs, so idle
cost is unchanged.

Tagging by commit rather than `latest` matters more than it looks:
`az containerapp update --image` only creates a new revision when the image
*reference* changes. Pushing new bytes to a fixed tag would leave the old
revision serving — a deployment that appears to work indefinitely.

### Deploy, prove it answers, then move the card

This is [0003](0003-the-turn-raises-its-own-preview.md)'s rule applied one
column further right. There the argument was that a card must not read *In
review* before there is something to review. Here it is that a card must not
read *Done* before the thing is live.

So `production.yml` runs `production-up` first — which builds, deploys, and
blocks until the URL answers — and only then runs `ship`, which comments the
live URL on the card and transitions it. A container that builds but will not
serve fails the first step, and the card never moves.

### The trigger is `pull_request: closed`, not `push: main`

A merge raises both events, concurrently. Only one of them can own the
ordering, and `pull_request` is the better owner:

- **The card key is on the pull request** — in its factory block and in its
  `card/<KEY>-` branch name. A bare push would have to ask the API which pull
  request a commit came from.
- **The main ruleset forbids pushing to the default branch directly**, so every
  commit that should reach production arrives through a pull request by
  construction. Nothing is missed by not listening to pushes.
- **`merged == true` is available on the event**, which is how closing a pull
  request without merging deploys nothing and moves no card.

`build-teardown.yml` keeps listening to the same event and is left alone. The
two run concurrently and touch different resources — teardown deletes
`df-preview-pr-<n>` and its `pr-<n>` tag, production writes `df-production` and
a `main-<sha>` tag — so there is nothing to serialise between them. A
`factory-production` concurrency group serialises production against *itself*,
because two merges in quick succession would otherwise collide on one
Container App and Azure would reject the second with
`ContainerAppOperationInProgress`. That is not hypothetical: it is exactly how
the old `pull_request`-triggered preview failed when it raced a turn.

### Only the bot may set *Done*

A Jira **transition condition** on the DF workflow restricts the transition into
*Done* to the factory's bot account. A condition rather than a permission,
because a condition hides the transition rather than rejecting it: the status
stops being offered on the board, and `factory jira-transition` — which resolves
a transition by destination before using it — fails with
`has no transition to "Done"` instead of an opaque 403.

This is the first place the factory's Jira workflow is not fully connected.
Everywhere else any status is reachable from any other, deliberately, so that a
failed turn can always reach *Blocked on engineer*. *Done* is different because
it is the one status that asserts a fact about the world rather than a position
in a process.

## Consequences

**The board's guarantee gets stronger.** *Done* now means "merged, deployed, and
the deployment answered". Nobody can put a card there by dragging it, including
a project administrator — conditions bind admins too.

**And there is no manual override.** That is the same sentence read the other
way. A card whose deploy succeeded but whose `ship` step failed cannot be
closed by hand; it needs the workflow re-run. An admin-only "Force done"
transition would restore the escape hatch, and was deliberately not added — the
point of the condition is lost the moment there is a second way in, and the
failure mode it protects against (a green board that is not really green) is
worse than the one it creates (a card that needs a re-run). Revisit if that
turns out to be wrong in practice.

**Two identity systems now have to agree.** The last human gate moved out of
Jira and into GitHub: the architect's approval is a pull request review, not a
card drag. GitHub's side of that is the existing `main protection` ruleset —
one approval, `ci` green, branch up to date. Binding it to a *role* rather than
to "anyone" needs CODEOWNERS, and GitHub teams need an organisation, so on a
personal repository that means individual usernames. Fine for now; it does not
survive contact with a real org.

**Production is azure-only.** The `ghcr` backend pushes an image nobody serves,
so there is no URL to prove and no site to point a person at. Rather than close
a card on the strength of a package page, `production.yml` skips entirely and
the card stays in review. A clone with no cloud account keeps working exactly as
before, minus the last step.

**Scale is a create-time decision.** `upsertApp` sets the image on the update
path and nothing else, so changing the replica constants will not move an app
that already exists — unlike the preview cooldown, which is reapplied every
turn precisely so it converges. Changing an app's scale means deleting it and
letting the next run rebuild it. Noted here because it is the kind of thing
that is discovered six months later.

**Rollback exists but is manual.** Every production image is kept under its
commit tag, so rolling back is deploying the previous one. There is no command
for it yet.

**Untested until the first merge.** No build pull request has ever been closed
in this repository, so `build-teardown.yml` has never run either. The first
card merged after this lands exercises both for the first time, simultaneously.
