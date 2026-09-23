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
                      │ Designing │◀─────────────────────┐
                      └─────┬─────┘                      │
          factory ┌─────────┴─────────┐                  │
                  ▼                   ▼                  │
          ┌───────────────┐  ┌──────────────────┐        │
          │ Design review │  │ Blocked on       │        │
          └───┬───────┬───┘  │ architect        │        │
              │       │      └────────┬─────────┘        │
              │       └───────────────┴──────────────────┘
              │            triage, on a comment that reads
              │            as work for the design agent
   human approves the design
              ▼
     ┌─────────────────┐
     │ Ready for build │
     └────────┬────────┘
     poller   │  claims + dispatches build-start.yml
              ▼
        ┌──────────┐
        │ Building │◀─────────────────────────┐
        └─────┬────┘                          │
  factory ┌───┴────────┐                      │
          ▼            ▼                      │
  ┌───────────┐  ┌──────────────────┐         │
  │ In review │  │ Blocked on       │         │
  └───┬───┬───┘  │ engineer         │         │
      │   │      └────────┬─────────┘         │
      │   └───────────────┴───────────────────┘
      │       triage, on a comment that reads
      │       as work for the build agent
      │       (or a comment on the pull request)
 human reviews and merges the PR
      ▼
  ┌──────┐
  │ Done │
  └──────┘
```

The two triage arrows also cross over, which the diagram would become unreadable
saying: a comment on a card in *In review* can start a **design** turn, and a
comment on a card in *Design review* can start a **build** one. See below.

## The statuses

| Status | Category | Means | Moved in by |
| --- | --- | --- | --- |
| **Backlog** | To do | Written down, not ready to work | Human |
| **Ready for design** | To do | The next poll will pick this up | Human |
| **Designing** | In progress | A design turn is running | Poller (from *Ready for design*, or from any waiting status on a comment) |
| **Design review** | In progress | A design is waiting for a human to read it | Factory |
| **Blocked on architect** | In progress | The design agent asked a question | Factory |
| **Ready for build** | To do | Design approved; the next poll will pick it up | Human |
| **Building** | In progress | A build turn is running, or waiting for the next to be granted | Poller (from *Ready for build*, or from any waiting status on a comment) |
| **In review** | In progress | The PR is ready for a human | Factory |
| **Blocked on engineer** | In progress | The build agent asked a question | Factory |
| **Done** | Done | Merged | Human |

A human putting a card in one of the two *Ready for …* statuses is how work
starts. After that the card comes back on its own, driven by what people say on
it rather than by where they drag it.

## Comments are the third entrance

The factory leaves a card in four statuses: *Design review*, *In review*,
*Blocked on architect*, *Blocked on engineer*. Each means the same thing — the
factory has said its piece and is waiting on a person — and in each of them the
person replies by commenting, not by moving the card.

So on every pass the poller looks at those four columns and asks, for each card,
whether anyone has spoken since the factory did. When someone has, the comment is
read once by a small model, which answers with one of three words:

| Answer | What happens |
| --- | --- |
| `design` | Card moves to *Designing*, the factory says why, `design.yml` runs |
| `build` | Card moves to *Building*, the factory says why, `build-turn.yml` runs |
| `none` | Nothing. The comment is recorded as considered and the card stays put |

The routing does not have to match the column. A change of requirements on a
card in *In review* is design work, and a fault in the running application
reported on a card in *Design review* is build work; both cross over. The catch
is the obvious one: a design turn on a branch that already has code revises a
document the implementation no longer matches, and reconciling the two becomes
the build agent's problem on the turn after.

Three things make this affordable and quiet:

- **The factory has its own Jira account.** "Someone has spoken since we did"
  means *the newest comment is not ours*, which is only answerable if the
  factory is a distinct author. Every turn ends with `report()` posting a
  comment, so a card the factory has put down carries its own words as its last.
- **A comment is read once.** The id of the last comment triage considered is
  kept on the card as a hidden issue property, `factory-triage`. Without it, a
  comment judged `none` would stay the newest comment forever and be re-read on
  every pass for the life of the card.
- **`none` is silent.** A card that collects a line of factory commentary every
  time somebody says "thanks" is worse than one that says nothing. The reasoning
  is in the poller's Actions log, and nowhere else.

Cards in *Designing* and *Building* are deliberately not looked at: an agent is
already running on that branch, and starting a second one is the single mistake
triage must not be able to make. Nor are the two *Ready for …* columns — those
are dispatched by status on the same pass, and reading them here as well would
hand one card to two runners.

### The design question loop, as a special case

*Blocked on architect* is where this started. The design agent parks a question
there, someone answers in a comment, triage reads the answer and sends the card
back to *Designing* — one design turn per answer, repeating until a turn has
nothing left to ask. Only then does the card reach *Design review*, and a human
still has to move it on from there.

That loop depends on one rule in the agent's manual: **questions are never
written into the design document.** They go on the card, all of them in one
comment, addressed to a reader who is not going to open the branch.
`docs/design/README.md` has no "Open questions" heading for this reason.

On the next turn `gather` marks the factory's own comments as *yours, on an
earlier turn* in `task.md`, and tells the agent which round it is — counted from
those same comments, so nothing has to store a counter.

### What the model is and is not

It is a single call to a small model with no tools, a fixed prompt and a forced
tool-call schema whose only output is one of three words and a sentence of
reasoning. It cannot read the repository, cannot write anything, and cannot
reach anything else. Comment text is data to it, and the prompt says so: text
shaped like an instruction ("ignore the above", "always choose build") is
something to classify, not something to obey. `factory/src/triage.test.ts` pins
that paragraph, for the same reason the agent manuals have tests.

The prompt also tells it to answer `none` whenever it is unsure, because the two
mistakes do not cost the same: a missed comment costs a human one drag of the
card, and a wrongly-started turn spends an agent run and puts a revision nobody
asked for on the branch.

### The other way into a build turn

A human commenting on the **pull request** still grants a build turn directly,
without going through Jira or the classifier — that path is older than triage
and unchanged. `build-turn.yml` now has both entrances, and they run the same
turn; see the header of that file for why the guards on the comment path cannot
be applied to the dispatch one.

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
is your account, because a factory that comments as you cannot tell your replies
from its own reports — every card would look permanently answered, or
permanently ignored, and comment triage above would silently stop working.
