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
                      └─────┬─────┘               │ poller, once a human
                            │                     │ has answered on the card
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
| **Designing** | In progress | A design turn is running | Poller (from *Ready for design*, or from *Blocked on architect* once answered) |
| **Design review** | In progress | A design is waiting for a human to read it | Factory |
| **Blocked on architect** | In progress | The design agent asked a question | Factory |
| **Ready for build** | To do | Design approved; the next poll will pick it up | Human |
| **Building** | In progress | A build turn is running, or waiting for the next to be granted | Poller |
| **In review** | In progress | The PR is ready for a human | Factory |
| **Blocked on engineer** | In progress | The build agent asked a question | Factory |
| **Done** | Done | Merged | Human |

The two *Ready for …* statuses are the only entry points. Everything the factory
does starts from a human putting a card in one of them.

## The design loop

*Blocked on architect* is the one status the factory leaves on its own. The card
sits there until someone answers the agent's question, and then comes back to
*Designing* with nobody dragging it — one design turn per answer, repeating until
a turn has nothing left to ask. Only then does the card reach *Design review*,
and a human still has to move it on from there.

Two things make that work:

- **Questions are never written into the design document.** They go on the card,
  all of them in one comment, addressed to a reader who is not going to open the
  branch. `docs/design/README.md` has no "Open questions" heading for this
  reason.
- **The factory has its own Jira account.** "Someone answered" means *the newest
  comment on the card is not ours*, which is only a question with an answer if
  the factory is a distinct author. `report()` comments before it transitions, so
  a blocked card always carries the agent's question as its last word — anything
  newer is the reply.

The poller runs `factory jira-answered "Blocked on architect"` alongside its two
`jira-search` calls and dispatches `design.yml` for each key that comes back. A
card whose question is still unanswered is not waiting on the factory, so it is
not dispatched: sending it back would put the agent in front of its own question
with nothing new to read.

On the next turn `gather` marks the factory's own comments as *yours, on an
earlier turn* in `task.md`, and tells the agent which round it is — counted from
those same comments, so nothing has to store a counter.

The build side has the same shape but a different trigger: *Blocked on engineer*
is left by a human commenting on the **pull request**, which grants one more
turn. Design has no PR thread worth reading at that point, so its conversation
is the card.

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

The factory has two identities, one per system, and neither of them is you.

| | Comment on a card | Move a card | Delete a card | Push to `card/*` | Push to `main` | Approve | Merge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The Jira bot user | ✅ | ✅ | ❌ | — | — | — | — |
| The factory App | — | — | — | ✅ | ❌ | ❌ | ❌ |
| You | ✅ | ✅ | ✅ | ❌ | ❌ (needs a PR) | ✅ | ✅ |

Neither party can do the whole job alone, which is the point.

The Jira bot is a plain licensed user, which on the project's default permission
scheme is exactly what the factory needs — browse, comment, transition, edit,
create — and nothing more: *Delete Issues* and *Administer Projects* are granted
to a project role the bot is not in. Your own Jira credentials stay on your
machine for `bootstrap/`, which creates the project and its statuses; they are
never stored in GitHub. `bootstrap/github.sh` refuses to run if `JIRA_BOT_EMAIL`
is your account, because a factory that comments as you cannot tell your answers
from its own questions, and the design loop above silently stops working.
