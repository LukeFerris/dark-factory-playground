# The state machine

Ten Jira statuses. Five are moved by the factory, five by a human. Which is
which is the whole design: **the factory never moves a card into a state that
means "approved".**

```
                       ┌─────────┐
                       │ Backlog │
                       └────┬────┘
                    human   │
                            ▼
                   ┌──────────────────┐
                   │ Ready for design │
                   └────────┬─────────┘
                   poller   │  claims + dispatches design.yml
                            ▼
                      ┌───────────┐
                      │ Designing │◀──────────────┐
                      └─────┬─────┘               │ human answers
                            │                     │
          factory ┌─────────┴─────────┐           │
                  ▼                   ▼           │
          ┌───────────────┐  ┌──────────────────┐ │
          │ Design review │  │ Blocked on       ├─┘
          └───────┬───────┘  │ architect        │
                  │          └──────────────────┘
          human approves the design
                  ▼
         ┌─────────────────┐
         │ Ready for build │
         └────────┬────────┘
         poller   │  claims + dispatches build-start.yml
                  ▼
            ┌──────────┐
            │ Building │◀──────────────────────┐
            └─────┬────┘                       │ human comments
                  │                            │ (grants a turn)
      factory ┌───┴────────┐                   │
              ▼            ▼                   │
      ┌───────────┐  ┌──────────────────┐      │
      │ In review │  │ Blocked on       ├──────┘
      └─────┬─────┘  │ engineer         │
            │        └──────────────────┘
    human reviews and merges the PR
            ▼
        ┌──────┐
        │ Done │
        └──────┘
```

## The statuses

| Status | Category | Means | Moved in by |
| --- | --- | --- | --- |
| **Backlog** | To do | Written down, not ready to work | Human |
| **Ready for design** | To do | The next poll will pick this up | Human |
| **Designing** | In progress | A design turn is running | Poller |
| **Design review** | In progress | A design is waiting for a human to read it | Factory |
| **Blocked on architect** | In progress | The design agent asked a question | Factory |
| **Ready for build** | To do | Design approved; the next poll will pick it up | Human |
| **Building** | In progress | A build turn is running, or waiting for the next to be granted | Poller |
| **In review** | In progress | The PR is ready for a human | Factory |
| **Blocked on engineer** | In progress | The build agent asked a question | Factory |
| **Done** | Done | Merged | Human |

The two *Ready for …* statuses are the only entry points. Everything the factory
does starts from a human putting a card in one of them.

## How a turn's result maps onto a move

`factory report` reads `.agent/out/result.json` and moves the card by the
destination status **name**. The table lives in `factory/src/schema.ts` as
`STATUS_TRANSITIONS` and is the single definition:

| Result status | Design turn → | Build turn → |
| --- | --- | --- |
| `ready_for_review` | Design review | In review |
| `blocked` | Blocked on architect | Blocked on engineer |
| `question` | Blocked on architect | Blocked on engineer |
| `failed` | Blocked on architect | Blocked on engineer |
| `continue` | *(no move)* | *(no move)* |

`continue` is the interesting one: the card stays in *Building* and the PR gets
a comment. Nothing happens next until a human comments, which grants the next
turn. That is how a multi-turn build stays under control without anyone having
to watch it.

A turn that is rejected by `factory validate` reports as `failed` — validation
overwrites `result.json` with a synthetic failure naming the problem, so the
card still moves and still gets a comment, rather than sitting in *Building*
with nobody told.

## Why transitions are matched by destination, not by name

Jira transitions have their own names, independent of the status they lead to,
and those names differ per workflow. `factory jira-transition` asks Jira for the
available transitions and picks the one whose `to.name` matches, case
insensitively. Rename a transition in Jira and nothing breaks. Rename a
**status** and reporting breaks until `STATUS_TRANSITIONS` is changed to match —
which is why `bootstrap/smoke.sh` asserts all ten names.

The `Factory` workflow that `bootstrap/jira.sh` creates gives every status a
global transition, so any status is reachable from any other. That is deliberate:
a failed turn must be able to reach *Blocked on engineer* from wherever the card
happens to be, and a workflow drawn to match the diagram above would turn that
into a `JiraTransitionError` after the turn had already done its work. The gate
on this pipeline is the pull request review, not the Jira workflow.

## Who can do what

| | Move a card | Push to `card/*` | Push to `main` | Approve | Merge |
| --- | --- | --- | --- | --- | --- |
| The factory App | ✅ | ✅ | ❌ | ❌ | ❌ |
| You | ✅ | ❌ | ❌ (needs a PR) | ✅ | ✅ |

Neither party can do the whole job alone, which is the point.
