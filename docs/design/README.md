# Design documents

One directory per card, named for the Jira key:

```
docs/design/
└── DF-14/
    ├── design.md      written by the design agent, reviewed by a human
    └── build-log.md   appended to by the build agent, one section per turn
```

`design.md` is the handover between the two stages. The build agent implements
what it says and nothing else, so a vague design produces vague code and an
over-specified one produces code nobody asked for.

## Required headings

Every `design.md` uses these headings, in this order, all of them. A section that
genuinely does not apply keeps its heading and gets one line explaining why —
an absent heading reads as an oversight, an explicit "not applicable here,
because…" reads as a decision.

### Context

The problem, in the language of whoever raised the card. What someone is trying
to do and cannot. Link the Jira key. Do not restate the acceptance criteria
verbatim; say what they are for.

### Current state

How the relevant part of the code works today, described from having read it.
Name the files. If behaviour is surprising, say so here rather than burying it
in the proposal.

### Proposed approach

What changes, and why this shape rather than another. Enough detail that the
build agent does not have to invent structure, but not so much that it is the
diff written in prose.

### Components affected

The files and modules that change, and for each one a line on what happens to
it. New files included. This is what the reviewer checks the eventual diff
against.

### State and data flow

Where the state lives, who owns it, how it moves. For a React change: which
component holds it, what is derived rather than stored, what crosses a boundary.
If the change adds no state, say so.

### Accessibility and UX notes

Keyboard reachability, focus order, labels and roles, colour contrast, what a
screen reader announces, what happens on error and while loading. This is not a
formality: the build agent writes tests from this section, so anything unstated
goes untested.

### Risks and alternatives

What could go wrong, and the approaches considered and rejected — with the
reason. A reviewer disagreeing with the design usually wants to reopen an
alternative, and it saves them re-deriving it.

### Acceptance criteria

What has to be true when this card is done, and for each one the exact steps a
person takes in the browser to prove it.

Two different things, kept apart on purpose. A **criterion** is a claim about
the finished app, written so a reviewer can agree or disagree with it before any
code exists. Its **steps** are what that reviewer actually does to find out
whether it holds. Merge them and you lose the first: a list of clicks never says
what "done" means.

One subsection per criterion, the criterion as the heading, its steps numbered
beneath:

```markdown
#### The greeting reads "Hi there, world" when the page loads

1. Open the app.
2. Look at the line beneath the heading.
3. It reads "Hi there, world".

#### The word "Hello" appears nowhere on the page

1. Press Cmd-F and search the page for "Hello".
2. No match is found.
```

Criteria are outcomes, not actions and not implementation: "the greeting updates
as you type" and not "add an onChange handler" or "NameField re-renders". Steps
start from the app already open — not building it, not starting a server — and
the last step of each group is an observation rather than an action, because
that is the bit that decides whether the criterion holds.

Cover the empty and error cases, not just the happy path. If part of the card
cannot be checked in a browser at all, say so in the criterion's steps in one
line and cover it under Test strategy instead.

This section and the `acceptance_criteria` field in `result.json` say the same
thing — the field is what reaches the Jira card, this is what the build agent
reads. A criterion you cannot write steps for is a requirement you have not
pinned down, and that is an open question rather than a vague criterion.

### Test strategy

The tests the build stage should write: what each one asserts and at what level
(unit, component, integration). Name the behaviours, not the test framework. A
design with no test strategy produces untested code.

These are not the same as the acceptance criteria above. The criteria are what a
person checks by hand once; the tests are what stops it regressing. A criterion
with no test behind it is a criterion that holds exactly until the next card.

## Open questions do not live here

There is no "Open questions" heading, on purpose. A question written into a
design document is a question nobody has been asked: it sits in a file on a
branch, the card says the design is ready, and the first person to find it is
the build agent — for whom it is far too late.

Unresolved decisions go on the Jira card instead, in `questions[]`, which puts
them all in one comment addressed to a human. The card moves to *Blocked on
architect* and stops. When someone answers, the poller starts a fresh design
turn, the agent reads the replies alongside its own earlier questions, and the
design is finished properly. That repeats until a turn comes back with nothing
to ask.

So a design document is only ever written as though everything in it is
decided, because by the time it is finished, everything in it is. The cost of
being wrong about that is a round trip; the cost of parking it is shipped code
built on a guess.

## Build logs

`build-log.md` accumulates one section per build turn:

```markdown
## Turn 3 — 2026-09-21

Changed: app/src/components/NameField.tsx, app/src/components/NameField.test.tsx

Added the empty-name case from the design's test strategy and fixed the focus
order the reviewer flagged on turn 2.

Ran: lint ✓ typecheck ✓ test ✓ (14 passing) build ✓

Outstanding: the focus ring is still the browser default on Safari; asked about
it on the card.
```

It exists so that turn N+1 — which is a fresh agent with no memory of turn N —
can pick up where the last one stopped. Write it for that reader.
