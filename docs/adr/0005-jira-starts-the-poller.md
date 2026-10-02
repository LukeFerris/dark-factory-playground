# 5. Jira starts the poller

Date: 2026-09-30

## Status

Accepted. Supersedes the polling decision in
[0001](0001-factory-architecture.md), which stands in every other respect —
including the claim-before-dispatch ordering, which this change depends on
rather than replaces.

## Context

[0001](0001-factory-architecture.md) chose polling over webhooks: "webhooks
would be faster and would need a public endpoint, a shared secret, and something
to run it. Polling needs none of those, and latency here is largely
irrelevant." That was right about webhooks and right about latency. It was
reasoning about a public playground, and the cost of being wrong only appeared
when the question became whether this could be installed anywhere else.

GitHub's `schedule:` floor is five minutes, and scheduled runs arrive far later
than their slot under load — 1.4 to 5 hours apart, measured over two days on this
repository. So coverage could not come from the cron, and came instead from a run
polling in a loop for a window and dispatching its own successor at the end of
it. That keeps a runner up more or less continuously.

On a public repository that is free. On a private one it bills every minute:
roughly **$345 a month, per repository**, to ask a question whose answer is "no"
almost every time. There is no cheaper point on that curve, because GitHub
Actions bills wall-clock presence and a poller needs to be present. Scheduling
less often buys proportionally less coverage at exactly the same rate per minute
of it. Every variation lands on the same line.

The decisive observation is that the factory was never state-driven. Its three
sources are all events:

| Source | Event |
| --- | --- |
| Ready for design | issue transitioned |
| Ready for build | issue transitioned |
| Comment triage | issue commented |

It polled because nothing was telling it, not because the design needed a poll.

## Decision

**Jira starts the poller. The cron is disabled and a run is a single pass.**

Two Jira Automation rules on the project — one on *issue transitioned*, one on
*issue commented* — POST to `poller.yml`'s `workflows/{id}/dispatches` endpoint.
`FACTORY_POLL_WINDOW_SECONDS` defaults to `0`, so a run does one sweep and exits.
The `schedule:` block is commented out. Setup is in
[JIRA-TRIGGERS.md](../factory/JIRA-TRIGGERS.md).

The poller's logic is unchanged. It still sweeps both *Ready for …* columns and
the four `TRIAGE_STATUSES`, and still moves a card before dispatching, which
remains the only gate stopping a card reaching two agents. (Which cards it takes
was narrowed later, by [0006](0006-the-factory-takes-only-cards-assigned-to-it.md).)

### The sweep is not aimed at the card that fired the rule

Automation knows which issue it was, and the workflow ignores it. A full sweep
makes a dropped event self-repairing: whatever one event missed, the next one
picks up. A targeted dispatch would be marginally faster and would strand
anything it failed to deliver — and under a push trigger, a stranded card waits
forever rather than until the next tick.

### The credential is `Actions: write` and nothing else

Something outside GitHub has to hold a GitHub credential, because GitHub has no
unauthenticated trigger — no per-workflow URL carrying a capability token, the
way GitLab has pipeline trigger tokens. Every route in is an authenticated REST
call. Automation has no secret store and no crypto primitives, so it cannot mint
a short-lived token either: what it holds is what it sends. The question is
therefore not how to avoid storing a credential in Jira, but how little that
credential may do.

A fine-grained PAT with `Actions: write` on one repository can start, cancel and
re-run workflows. It cannot push code, read secrets, modify a workflow file or
merge anything.

That is sufficient because **the PAT does not give the run its power.** It only
starts the run; the poller then mints its own App token. A dispatch executes the
workflow file as it exists on the ref, so changing what a run *does* requires
`Contents: write` to push a different one. This is also why the decision is
`workflows/{id}/dispatches` rather than `repository_dispatch`, which needs
`Contents: write` — push access, and a different argument entirely.

## Consequences

Billed minutes now track how much the team uses the board rather than the
passage of time. Latency falls to about 30 seconds, nearly all of it checkout,
`npm ci` and minting the token. The factory becomes installable in a private
repository, which was the point.

The cost is a credential held outside the system, with an expiry, and no alarm.
When the PAT expires the factory goes silent with nothing failing anywhere in
GitHub, because a dispatch that never arrives files no run; the only evidence is
in the Jira rule audit log. A third Automation rule on a 30-minute schedule,
with a JQL matching only the two *Ready for …* columns, reduces a silent factory
to a half-hour delay and — because a JQL that matches nothing runs no action —
files no GitHub run when the board is quiet. It is a backstop, not independent
cover: it fails at the same moment and for the same reason as the other two
rules.

The residual risk of the token itself is that a holder can start factory runs
and cancel them. A spurious design turn burns Anthropic credits and leaves a
draft PR on a card that was not ready. It does not get code merged: CI, the path
allowlist in `factory/src/schema.ts`, and a required human approval with an empty
`bypass_actors` list are all still in the way.

Two exits remain open, and the commented-out `schedule:` is what keeps them
cheap:

- **A self-hosted runner** makes Actions minutes free, at which point continuous
  polling is the cheapest option rather than the dearest and this decision
  becomes optional. Restoring it is one uncommented block and one variable set
  to 3000. The poller is a safe first candidate for a self-hosted runner because
  it runs no agent — triage is a tool-less classifier call — so the containment
  argument in [SECURITY.md](../factory/SECURITY.md) is not what is at stake.
- **An Atlassian Forge app** has encrypted environment variables and a Node
  runtime, so it can hold an App private key and mint a one-hour installation
  token per call, leaving nothing long-lived in Jira. It is the correct answer
  and it is a real application with a real toolchain, so it is recorded here
  rather than built.
