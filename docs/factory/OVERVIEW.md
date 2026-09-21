# The dark factory

A card goes into a Jira column. Some time later a pull request appears, with a
design, an implementation, tests, and a preview. A human reviews it and merges
it. Nobody opened an editor.

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
                    └──────────────┘
```

Two stages, one card:

1. **Design.** The card reaches *Ready for design*. An agent with no shell reads
   the card and the code, and writes `docs/design/<KEY>/design.md`. The card
   lands in *Design review* with the design attached to a draft PR.
2. **Build.** A human approves the design and moves the card to *Ready for
   build*. An agent implements it, one turn at a time, on a `build/*` branch.
   Each turn after the first is granted by a human comment on the PR.

A human merges. Nothing else does.

## The pieces

| Where | What it is |
| --- | --- |
| `app/` | The example React 19 + TypeScript app the factory writes features into |
| `factory/` | `@factory/cli` — every step of a turn, as TypeScript subcommands |
| `.agent/` | The agent boundary: the two manuals, and the in/out directories |
| `.github/workflows/` | Six workflows: the poller, design, and build start/setup/turn/teardown |
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
3. **The branch rulesets.** The App can push to `design/*` and `build/*` and
   nowhere else. It cannot push to `main`, approve a pull request, or merge.

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
