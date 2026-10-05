# DF-13 — Say in the README how to stop a factory turn

## Context

Jira card DF-13 began as a test card for the Jira triggers.
Its description now asks for one real change: a short note in the top-level
README saying that a factory turn can be stopped by commenting "@Enki stop" on
its card. The card's own acceptance line is "the README has that note".

Today someone who only reads the README has no way to learn that a running turn
can be stopped from Jira. The instructions exist, but only deep in the runbook.

## Current state

- `README.md` (read in full) has an intro, a setup snippet, *Layout*, *Checks*,
  *Documentation* (a bulleted list of links into `docs/factory/` and
  `docs/adr/`), and *The short version of the safety argument*. It never
  mentions stopping a turn.
- `docs/factory/RUNBOOK.md`, section *A card is locked and will not move*
  (around line 262), is the authoritative how-to: comment on the card, mention
  the factory picked from the mention list (plain typed text is not a
  mention), make "stop" the first word; within about a minute the run is
  cancelled, the card goes back to the status it came from assigned to the
  person who said stop, and a *Stopped, as asked* comment links the run.
  Anything already pushed stays on the branch.
- `docs/factory/STATE-MACHINE.md` and ADR 0007 describe the same behaviour.
  Nothing in them needs to change.

## Proposed approach

Add one short section to `README.md`, titled `## Stopping a turn`, placed
directly after *Documentation* and before *The short version of the safety
argument*. It says, in two to four sentences:

1. A turn in progress can be stopped from its Jira card by commenting
   `@Enki stop` — the factory picked from the mention list, with "stop" as the
   first word.
2. The run is cancelled and the card goes back to where it was, assigned to
   whoever said stop; anything already pushed stays on the branch.
3. A link to the runbook section for what to check if nothing happens:
   `[docs/factory/RUNBOOK.md](docs/factory/RUNBOOK.md#a-card-is-locked-and-will-not-move)`.

The README stays a pointer, not a second copy of the runbook: no
troubleshooting table, no `gh` commands. That keeps the two from drifting.

## Components affected

| File | Change |
| --- | --- |
| `README.md` | New `## Stopping a turn` section between *Documentation* and *The short version of the safety argument*. No other line changes. |

## State and data flow

Not applicable — this is a documentation change; no code or state is touched.

## Accessibility and UX notes

The note is plain Markdown: a heading, a short paragraph, and a link whose text
says where it goes (for example "the runbook"), not "click here". Write
`@Enki stop` in inline code so it reads as the exact text to type.

## Risks and alternatives

- **Drift from the runbook.** If the stop behaviour changes, the README could
  go stale. Mitigated by keeping the note to the command and the outcome and
  linking the runbook for everything else.
- **Alternative: a bullet in *Documentation*.** Rejected; that list is links to
  documents, and a how-to sentence would not fit its shape.
- **Alternative: only link the runbook.** Rejected; the card asks for the note
  itself to be in the README.

## Acceptance criteria

#### The README's front page tells you a turn can be stopped by commenting "@Enki stop" on its card

1. Open the repository's front page on GitHub, where the README is shown.
2. Scroll to the heading "Stopping a turn".
3. The text under it says that commenting "@Enki stop" on the card stops a running factory turn, and that "stop" must be the first word after the mention.

#### The note says what happens after you stop a turn

1. Open the repository's front page on GitHub.
2. Read the text under "Stopping a turn".
3. It says the run is cancelled, the card goes back to where it was, and anything already pushed stays on the branch.

#### The note links to the runbook for when the stop does not work

1. Open the repository's front page on GitHub.
2. Under "Stopping a turn", select the link to the runbook.
3. The runbook opens at the section "A card is locked and will not move".

#### Nothing else in the README has changed

1. Open the repository's front page on GitHub.
2. Look at the headings.
3. They are, in order: "Layout", "Checks", "Documentation", "Stopping a turn", "The short version of the safety argument", with the same content as before apart from the new section.

## Test strategy

There is no automated test for README prose, and adding one would be scope
creep. The build stage should check by reading the diff that:

- only `README.md` changed, and only by the new section;
- the runbook link's anchor (`#a-card-is-locked-and-will-not-move`) matches the
  runbook heading *A card is locked and will not move* exactly;
- the existing `npm run lint` and `npm run build` still pass (they do not read
  the README, so this is a guard against accidental edits elsewhere).
