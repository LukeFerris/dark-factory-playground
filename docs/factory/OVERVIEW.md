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
    ┌──────────────────────┴─────────────────────────────────────────────────────┐
    │  one turn                                                                  │
    │                                                                            │
    │  gather ─▶ announce ─▶ prepare ─▶ merge ─▶ AGENT ─▶ validate ─▶ publish    │
    │    │        │                      │        │          │         │         │
    │  .agent/in card says            conflicts .agent/out   scope   draft PR    │
    │  task.md   it has               go to an  result.json  check   as the      │
    │  meta.json started              agent too transcript           App         │
    └────────────────────────────────────────────────────────────────────────────┘
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

Every turn in there brackets itself with a comment on the card: one when it
picks the card up, one when it puts it down. A Jira status change notifies
nobody and does not show up in the comment stream, so without the first of those
a card being worked on for ten minutes reads exactly like a card being ignored.

Two things a card carries are not comments. A card is only the factory's when
it is in a *Ready for …* column **and assigned** to the factory, so the board can
hold cards it never touches. While a turn runs the factory keeps it, so the
board view shows an avatar on whatever is being worked on right now, and at the
end it hands the card back to whoever sent it in, mentioning them in the report
comment so that Jira notifies them. And where to look — the
pull request, the preview, and the live URL once it ships — goes on as
**remote links**, one row each, replaced in place as they change, rather than a
fresh comment per turn that the reader has to date-sort to use.

### A card the factory is working is locked

While a turn runs, the card sits in *Designing* or *Building*. Jira lets only
the factory move a card out of those statuses or reassign it. A person
dragging it elsewhere, an admin included, gets a refusal. That keeps one card
in one pair of hands: a drag can't start a second turn on a branch the first is
still writing, or be quietly overwritten when the first one reports. Runs on
the same card queue behind each other. To take a card back mid-turn, comment
"@Enki stop" on it: the run is cancelled and the card returns to where it was,
assigned to you. A run that dies without reporting has its card let go
automatically by the next poll.
[ADR 0007](../adr/0007-cards-lock-while-the-factory-works-them.md) has the
reasoning.

### Comments are the third entrance

Dragging a card is not the only way to start work. Wherever the factory has
stopped and is waiting on a person, a comment addressed to it is read on the
next poll by a small model, which answers with one of three words: start a
design turn, start a build turn, or do nothing. In the two *Blocked on …*
statuses, where it asked a question, any comment counts. In *Design review* and
*In review*, where people are mostly talking to each other, only a comment that
@mentions the factory does. It then takes the card back, moves it, says on the
card why it moved, and dispatches the runner.

Most comments are `none`, and `none` is silent. The point is that a change of
mind is a sentence on the ticket rather than a status the commenter has to work
out for themselves. `docs/factory/STATE-MACHINE.md` has the details, including
why a comment on a card in *In review* can legitimately start a *design* turn.

### Nothing is allowed to go stale

Two rules, both about the fact that `main` moves while a card is in flight.

**Every turn merges main into the branch before the agent runs.** Not only for
the card's own sake: the manual the agent is about to be prompted with and the
validator about to judge it are both files in that branch, so a branch a week
behind runs a week-old prompt against a week-old validator, and a fix to either
silently misses every card in flight.

**Every merge to main fans out over every card still in review.** One job per
card, in parallel. A card in review is waiting on a person, and a person takes
days; by the time they look, the diff, the preview and the green tick are all
statements about a world that has ended. If the branch takes main cleanly and the
checks still pass, it is pushed and the card is told — including that the push
has dismissed any approval that was on it. If not, the card goes back to
*Building* and the build agent works it through.

A conflict is not, on its own, a reason to interrupt a person. An agent tries
first, under a manual of its own (`.agent/merge.md`) and confined to the files
git marked conflicted. Only a genuine disagreement about what the software should
do comes back as a question — and then it names the file and offers the options,
rather than saying "merge conflict".

## The pieces

| Where | What it is |
| --- | --- |
| `app/` | The example React 19 + TypeScript app the factory writes features into |
| `factory/` | `@factory/cli` — every step of a turn, as TypeScript subcommands |
| `.agent/` | The agent boundary: the three manuals, and the in/out directories |
| `.github/workflows/` | Ten workflows: the poller, design, build start/setup/turn/comment/teardown, refresh, stop, and production |
| `.github/actions/merge-main/` | Bringing a card branch up to main, with an agent for the conflicts |
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

The merge agent gets a fourth. It may edit only the paths git itself marked
conflicted, it holds read-only git and no other command, and it cannot commit —
`factory merge-finish` checks its work and writes the commit. A conflict inside
`.agent/`, `.github/` or `factory/` never reaches it: the resolution it wrote
would be the code running the next step.

And one that is not a technical control at all: **a human grants every build
turn.** There is no auto-continue. A confused agent costs one turn.

`docs/factory/SECURITY.md` goes through the threat model properly, including
what happens when the card text itself is hostile.

## Where to go next

| You want to | Read |
| --- | --- |
| Set this up from scratch | `SETUP.md` |
| Make Jira start the factory | `JIRA-TRIGGERS.md` |
| Know what each Jira status means | `STATE-MACHINE.md` |
| Fix a stuck card or a failed turn | `RUNBOOK.md` |
| Understand the containment argument | `SECURITY.md` |
| Run it on your own infrastructure | `SELF-HOSTING.md` |
| Know why it is built this way | `../adr/0001-factory-architecture.md` |
| See what the plan got wrong | `CHANGELOG.md` |
