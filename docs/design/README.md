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

### Test strategy

The tests the build stage should write: what each one asserts and at what level
(unit, component, integration). Name the behaviours, not the test framework. A
design with no test strategy produces untested code.

### Open questions

Anything genuinely undecided, each phrased as a question with the options. If
the answer blocks implementation, the turn's result status should be `question`
or `blocked`, not `ready_for_review` — this section is not a place to park
decisions and carry on.

## Build logs

`build-log.md` accumulates one section per build turn:

```markdown
## Turn 3 — 2026-09-21

Changed: app/src/components/NameField.tsx, app/src/components/NameField.test.tsx

Added the empty-name case from the design's test strategy and fixed the focus
order the reviewer flagged on turn 2.

Ran: lint ✓ typecheck ✓ test ✓ (14 passing) build ✓

Outstanding: the debounce question in the design's Open questions is still open;
currently implemented without one.
```

It exists so that turn N+1 — which is a fresh agent with no memory of turn N —
can pick up where the last one stopped. Write it for that reader.
