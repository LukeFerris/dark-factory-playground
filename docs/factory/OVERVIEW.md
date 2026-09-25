# The dark factory

A card goes into a Jira column. Some time later a pull request appears, with a
design, an implementation, tests, and a preview. A human reviews it and merges
it; the merge puts it into production and the card closes itself. Nobody opened
an editor.

That is the whole idea. This repository is a working, deliberately small proof
of it: an example React app that the factory builds features into, and the
machinery that makes the loop run.

## The loop

```
                    ┌──────────────────────────────────────────┐
                    │                  Jira                    │
                    └──────────────────────────────────────────┘
                           ▲                          │
              status moves │                          │ every 10 min
              + ADF comment │                          ▼
                    ┌──────┴───────┐          ┌─────────────────┐
                    │ factory report│◀────────│  poller.yml     │
                    └──────┬───────┘          └────────┬────────┘
                           │                           │ dispatch
                           │                           ▼
    ┌──────────────────────┴───────────────────────────────────────┐
    │  one turn                                                    │
    │                                                              │
    │  gather ──▶ prepare-branch ──▶ AGENT ──▶ validate ──▶ publish │
    │    │                            │           │          │     │
    │  .agent/in                 .agent/out    scope      draft PR │
    │  task.md                   result.json   check      as the   │
    │  meta.json                 transcript               App      │
    └──────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   GitHub PR  │──▶ human comment grants the next build turn
                    └──────┬───────┘
                           │ a human merges
                           ▼
                    ┌──────────────┐
                    │  production  │──▶ once it answers, the card moves to Done
                    └──────────────┘
```

Two stages and an ending, one card:

1. **Design.** The card reaches *Ready for design*. An agent with no shell reads
   the card and the code, and writes `docs/design/<KEY>/design.md` on a new
   `card/<KEY>` branch, opening a pull request for it. Anything it cannot decide
   goes on the card as a question and the card stops at *Blocked on architect*;
   once someone answers, the poller starts another design turn on the same
   branch, and that repeats until a turn has nothing left to ask. Only then does
   the card reach *Design review*.
2. **Build.** A human approves the design on the card and moves it to *Ready
   for build*. An agent implements it, one turn at a time, on the same branch
   the design came in on — so the design document is simply already there.
   Each turn after the first is granted by a human comment on the PR.
3. **Ship.** A human merges — nothing else can. The merge builds that commit,
   deploys it to the always-on production app, waits for it to answer, and only
   then moves the card to *Done*. That last transition is restricted to the
   factory's own account in Jira, so *Done* means the software is live rather
   than that somebody tidied the board.

### Comments are the third entrance

Dragging a card is not the only way to start work. Wherever the factory has
stopped and is waiting on a person — *Design review*, *In review*, and the two
*Blocked on …* statuses — a comment on the card is read on the next poll by a
small model, which answers with one of three words: start a design turn, start a
build turn, or do nothing. It then moves the card, says on the card why it
moved, and dispatches the runner.

Most comments are `none`, and `none` is silent. The point is that a change of
mind is a sentence on the ticket rather than a status the commenter has to work
out for themselves. `docs/factory/STATE-MACHINE.md` has the details, including
why a comment on a card in *In review* can legitimately start a *design* turn.

## The pieces

| Where | What it is |
| --- | --- |
| `app/` | The example React 19 + TypeScript app the factory writes features into |
| `factory/` | `@factory/cli` — every step of a turn, as TypeScript subcommands |
| `.agent/` | The agent boundary: the two manuals, and the in/out directories |
| `.github/workflows/` | Seven workflows: the poller, design, build start/setup/turn/teardown, and production |
| `bootstrap/` | Four scripts that configure GitHub and Jira from nothing |
| `docs/design/<KEY>/` | One directory per card: the design, and the build log |

## What makes it safe to leave running

Three independent layers, each of which would have to fail:

1. **The tool allow-list.** The design agent has no `Bash` at all. The build
   agent has six commands, and `npm install` is not one of them.
2. **The diff-scope check.** `factory validate` rejects any turn that touched a
   path outside its stage's allow-list, and always rejects `.agent/`,
   `.github/`, `factory/`, `bootstrap/` and the tooling configs — the agent
   cannot edit its own manual, its own workflow, or its own validator.
3. **The branch rulesets.** The App can push to `card/*` and nowhere else. It
   cannot push to `main`, approve a pull request, or merge.

And one that is not a technical control at all: **a human grants every build
turn.** There is no auto-continue. A confused agent costs one turn.

`docs/factory/SECURITY.md` goes through the threat model properly, including
what happens when the card text itself is hostile.

## Where to go next

| You want to | Read |
| --- | --- |
| Set this up from scratch | `SETUP.md` |
| Know what each Jira status means | `STATE-MACHINE.md` |
| Fix a stuck card or a failed turn | `RUNBOOK.md` |
| Understand the containment argument | `SECURITY.md` |
| Run it on your own infrastructure | `SELF-HOSTING.md` |
| Know why it is built this way | `../adr/0001-factory-architecture.md` |
| See what the plan got wrong | `CHANGELOG.md` |
