# DF-11 — Drag and drop deal cards between columns

## Context

[DF-11](https://jira.local/browse/DF-11) says "the user should be able to drag
and drop cards from one column to another". It has no description and no
acceptance criteria.

The cards are the deal cards on the Deal Pipeline board (DF-8). Each column is a
stage. Today the only way to move a deal is to pick a new stage from the
"Stage" picker on its card. That works, but it doesn't feel like a board: people
expect to pick a card up and put it in the next column. This card adds that.
The "Stage" picker stays. It is the keyboard and touch alternative, and it
means dragging is never the only way to do something.

DF-8's scope questions got the answer "this is a proof of concept; pick
whatever keeps it simplest". DF-9 followed the same rule, and so does this
design.

## Current state

Read in full: `app/src/App.tsx`, `app/src/App.test.tsx`,
`app/src/components/PipelineBoard.tsx`, `app/src/components/PipelineBoard.test.tsx`,
`app/src/crm/useDeals.ts`, `app/src/crm/types.ts`, `app/src/crm/seed.ts`,
`app/src/index.css`, `app/package.json`, `app/e2e/pipeline.spec.ts`, and
`docs/design/DF-9/design.md`.

- `useDeals` (`app/src/crm/useDeals.ts`) owns the only deal state, a `Deal[]`
  that is saved to `localStorage` (`df-crm.deals.v1`) on every change.
  `moveDeal(id, stage)` maps over the array and changes that deal's `stage`. It
  keeps the deal's position in the array, so a moved card appears in its new
  column in the same order it has in the array. It does not go to the bottom.
- `App` wraps `moveDeal` in `handleMove`, which also sets the polite live region
  to "Moved <company> to <stage>". It passes `handleMove` to `PipelineBoard` as
  `onMove`.
- `PipelineBoard` renders one `<section className="column" aria-label={stage}>`
  per stage in a CSS grid. Each section has an `<h2>` with a count, then either
  "No deals" or a `DealCard` per deal. Grid items stretch by default, so every
  column is as tall as the tallest one. An empty column is therefore still a
  full-height area.
- `PipelineBoard.handleMove` records the moved id in a ref and, after the next
  render, focuses that card's stage select. This exists because a moved card
  re-mounts in a new column and loses focus. It only makes sense when the move
  came from the select.
- `DealCard` is a private function in `PipelineBoard.tsx`. It is an `<article>`
  labelled by its `<h3>`. It has local `editing` state. While editing, it shows
  `EditDealForm` instead of the details, the stage select and the Edit button.
- There is no drag-and-drop code and no drag-and-drop dependency. The only
  runtime dependencies are `react` and `react-dom`.
- `app/e2e/pipeline.spec.ts` is the reviewer walkthrough. Its `uatStep`
  numbers are the flattened acceptance-criteria steps. Its header says each card
  replaces the previous card's walkthrough.

## Proposed approach

Use the browser's built-in HTML drag and drop (`draggable`, `dragstart`,
`dragover`, `drop`, `dragend`). No new dependency.

**Cards are draggable.** A `DealCard` sets `draggable` on its `<article>` while it
is not being edited. While its edit form is open it is not draggable, so
dragging inside a text field still selects text. On `dragstart` the card:

- calls a new `onDragStart(deal)` prop, so the board knows what is being dragged;
- sets `event.dataTransfer.setData('text/plain', deal.id)` (Firefox won't start
  a drag without data) and `effectAllowed = 'move'`.

On `dragend` it calls a new `onDragEnd()` prop.

**Columns are drop targets.** `PipelineBoard` keeps the dragged deal's `id` and
`stage` in a ref (`dragged`) and the highlighted column in state
(`dropTarget: Stage | null`). Each `<section>` gets:

- `onDragOver`: if something is being dragged and this column is not the
  dragged deal's current stage, call `preventDefault()` (which makes it a valid
  drop target), set `dropEffect = 'move'`, and set `dropTarget` to this stage
  (only if it changed). Otherwise do nothing. The browser then shows its
  "can't drop here" cursor. Drags that didn't start on a card, such as files or
  selected text, are ignored the same way, because `dragged` is empty.
- `onDragLeave`: if `event.relatedTarget` is outside this section, clear
  `dropTarget`. Without that check, moving over a child card would flicker the
  highlight.
- `onDrop`: `preventDefault()`, then call `onMove(dragged.id, stage)` directly.
  Do not go through `handleMove`, which would move focus to the select after a
  mouse drop. Then clear `dragged` and `dropTarget`.

`onDragEnd` from the card always clears `dragged` and `dropTarget`. That covers
a drop outside any column, a drop on the card's own column, and Escape pressed
mid-drag. In each case nothing moves.

**Why the drop goes to `App`'s `onMove`.** It reuses exactly the path the stage
select uses. The deal is updated, saved and announced ("Moved <company> to
<stage>") with no new code in `useDeals` or `App`.

**Highlight.** While a valid column is under the pointer, it gets the class
`column--drop-target`: a 2px dashed outline in the accent colour and a slightly
tinted background. Cards get `cursor: grab` while draggable. The dragged card
itself is not restyled. The browser's drag image is enough, and changing the
DOM of the dragged element during `dragstart` can cancel the drag in some
browsers.

**Where the card lands in its new column.** It lands where its array position
puts it, as with the stage select. Reordering within a column is not part of
this card.

## Components affected

| File | Change |
| --- | --- |
| `app/src/components/PipelineBoard.tsx` | `PipelineBoard`: a `dragged` ref, `dropTarget` state, and `onDragOver`/`onDragLeave`/`onDrop` on each column section. Adds `column--drop-target` to the highlighted section. `DealCard`: new props `onDragStart(deal: Deal)` and `onDragEnd()`; `draggable={!editing}` on the article with `dragstart`/`dragend` handlers. No change to the public `PipelineBoardProps` |
| `app/src/components/PipelineBoard.test.tsx` | New drag-and-drop cases (below) |
| `app/src/App.test.tsx` | One new integration case: a drop moves the deal, updates the summary and announces it |
| `app/src/index.css` | `.column--drop-target` (dashed accent outline, tinted background) and `cursor: grab` on draggable cards (`.deal[draggable='true']`) |
| `app/e2e/pipeline.spec.ts` | Replaced with DF-11's walkthrough, one `uatStep` per flattened step below, following the file's existing pattern |

Unchanged: `useDeals.ts`, `types.ts`, `App.tsx`, `EditDealForm.tsx`. No new
dependencies. No change to the stored data or its storage key.

## State and data flow

- **Deal data** is still owned only by `useDeals`. A drop ends in the same
  `onMove(id, stage)` call as the stage select: `App.handleMove` →
  `moveDeal` → the existing effect saves to `localStorage`.
- **What is being dragged** is a ref in `PipelineBoard` (`{ id, stage } | null`),
  set by `DealCard`'s `dragstart` through `onDragStart` and cleared on drop or
  `dragend`. It is a ref, not state, because nothing renders from it.
- **Which column is highlighted** is `useState<Stage | null>` in
  `PipelineBoard`. It is set on `dragover` and cleared on `dragleave` (when the
  pointer leaves the section), `drop` and `dragend`. It is never saved.
- **Whether a card is draggable** is derived from `DealCard`'s existing
  `editing` state.
- `dataTransfer` data is written but never read. It exists only so that Firefox
  starts the drag.

## Accessibility and UX notes

- **Dragging is never the only way.** The "Stage" picker on every card is
  unchanged and stays the keyboard, screen-reader and touch route. That
  satisfies the "dragging movements" rule (WCAG 2.5.7) without a custom
  keyboard drag mode.
- **No new focusable elements and no change to tab order.** The article isn't
  given a `tabindex`. `draggable` does not make it focusable.
- **Announcements.** A successful drop announces "Moved <company> to <stage>"
  through the existing live region, the same as the picker. A cancelled drag, a
  drop outside any column, or a drop on the card's own column announces nothing.
- **Focus.** A drop doesn't move focus. This is unlike the picker, where focus
  follows the card because the person was on its select.
- **Highlight.** The target column shows a dashed outline as well as a tint, so
  it doesn't rely on colour alone. The outline is the accent colour (#1e3a5f),
  which is above 10:1 against the page, so it clears the 3:1 non-text contrast
  rule easily. The tint is decorative.
- **No ARIA drag attributes.** `aria-grabbed` and `aria-dropeffect` are
  deprecated and poorly supported. The picker is the accessible route.
- **Editing card.** Not draggable while its form is open, so selecting text in
  a field by dragging works normally.
- **Touch.** Built-in HTML drag and drop is unreliable on phones and tablets.
  There, people use the picker.
- **No loading or error state.** Moves are synchronous and local.

## Risks and alternatives

- **Text on a card can't be selected by dragging** while the card is draggable,
  because the browser treats the drag as a card drag. Minor: nothing on a card
  needs copying, and the edit form, where text selection matters, turns
  dragging off.
- **Flickering highlight** from `dragenter`/`dragleave` firing on child
  elements. It is handled by setting the highlight on `dragover` and clearing on
  `dragleave` only when `relatedTarget` is outside the section. Tests cover
  leaving the section.
- **jsdom has no `DataTransfer`.** Component tests must pass a stub
  (`{ setData: vi.fn(), effectAllowed: '', dropEffect: '' }`) through
  `fireEvent.dragStart/dragOver/drop`. Handlers must not rely on reading data
  back.
- **Rejected: a library (`@dnd-kit`, `react-beautiful-dnd`).** These give
  keyboard dragging, touch and smooth animation, but they add a dependency and
  a lot of structure for a proof of concept that already has an accessible
  alternative. `react-beautiful-dnd` is also unmaintained. If reordering within a
  column or touch dragging is wanted later, that is the point to reconsider.
- **Rejected: pointer events with a hand-rolled drag.** More code (hit testing,
  a drag preview, scroll handling) for the same result as the built-in API.
- **Rejected: a keyboard "pick up, arrow, drop" mode.** It duplicates the stage
  picker.
- **Rejected: letting a drop on the card's own column count as a move.** It
  would announce "Moved X to <same stage>" and churn storage for no change.

## Acceptance criteria

The steps follow on from each other on the seeded board, starting from a first
visit.

#### While a card is being dragged, the column it would land in is highlighted, and letting go outside every column leaves the card where it was

1. Press and hold on the "Northwind Analytics" card in "Sourcing" and, without
   letting go, move it over the "Screening" column.
2. The "Screening" column has a dashed outline and no other column does.
3. Still holding, move the card up over the "Deal Pipeline" heading.
4. No column is outlined.
5. Let go.
6. "Northwind Analytics" is still in "Sourcing" and no column is outlined.

#### Dropping a card on another column moves the deal to that stage

1. Drag the "Northwind Analytics" card from "Sourcing" and drop it on the
   "Screening" column.
2. "Northwind Analytics" is in "Screening", whose count reads 2. "Sourcing"
   reads "No deals" with a count of 0, and the card's "Stage" picker reads
   "Screening".

#### A card can be dropped on an empty column

1. Drag the "Brightline Packaging" card from "Due diligence" and drop it on the
   now-empty "Sourcing" column, below its "No deals" message.
2. "Brightline Packaging" is in "Sourcing", "No deals" has gone from
   "Sourcing", and "Due diligence" now reads "No deals".

#### Dropping a card on "Closed" or "Passed" updates the summary

1. Check that the summary line beneath "Deal Pipeline" reads "4 active deals ·
   £210m in pipeline".
2. Drag the "Harbour Dental Group" card from "Screening" and drop it on the
   "Passed" column.
3. "Harbour Dental Group" is in "Passed" and the summary reads "3 active deals
   · £185m in pipeline".

#### Dropping a card back on its own column changes nothing

1. Drag the "Kestrel Energy Services" card and drop it on an empty part of its
   own "Investment committee" column.
2. "Kestrel Energy Services" is still in "Investment committee", whose count
   still reads 1, and the summary still reads "3 active deals · £185m in
   pipeline".

#### A card whose edit form is open can't be dragged

1. On the "Meridian Foods" card in "Closed", press "Edit".
2. Press and hold on the "Meridian Foods" heading and drag it onto the "Passed"
   column, then let go.
3. "Meridian Foods" is still in "Closed" with its edit form still open.

#### Moves made by dragging survive a reload

1. Reload the page.
2. "Northwind Analytics" is in "Screening", "Brightline Packaging" is in
   "Sourcing" and "Harbour Dental Group" is in "Passed".

#### The "Stage" picker still moves a card

1. On the "Kestrel Energy Services" card, choose "Closed" in its "Stage" picker.
2. "Kestrel Energy Services" is in "Closed" and the summary reads "2 active
   deals · £100m in pipeline".

## Test strategy

- **`PipelineBoard` (component)**, using `fireEvent` drag events with a stub
  `dataTransfer`:
  - every card that isn't being edited has `draggable="true"`; a card whose
    edit form is open does not;
  - `dragStart` on a card, then `dragOver` and `drop` on another column, calls
    `onMove` once with that deal's id and the column's stage;
  - `drop` on the card's own column does not call `onMove`, and `dragOver` there
    is not prevented (`fireEvent.dragOver` returns `true`);
  - `dragOver`/`drop` on a column with no card drag in progress (no
    `dragStart` first) does not call `onMove`;
  - `dragStart` then `dragEnd` with no drop does not call `onMove`;
  - while dragging over a column, that section has `column--drop-target` and no
    other section does; after `dragLeave` to an element outside the section, or
    after `drop`, or after `dragEnd`, no section has it;
  - a drop does not move focus to the moved card's stage select. The existing
    picker test that focus follows the select stays unchanged.
- **`App` (integration):** drag "Harbour Dental Group" to "Passed" with
  `fireEvent`. It appears in "Passed", the summary reads "3 active deals · £185m
  in pipeline", the live region reads "Moved Harbour Dental Group to Passed",
  and after unmounting and re-rendering it is still in "Passed".
- **Existing tests** for the picker, editing and adding pass unchanged.
- **Walkthrough (`app/e2e/pipeline.spec.ts`, end to end):** replaced by DF-11's
  walkthrough. It has one `uatStep` per flattened acceptance-criteria step
  above, in order on one page, using Playwright's `dragTo` for drops and
  `mouse.down`/`mouse.move`/`mouse.up` for the hold-and-hover highlight steps.
  Escape pressed mid-drag is not in the walkthrough, because it can't be
  driven reliably. It ends in the same `dragend` as any other cancelled drag,
  and the component test for `dragEnd` with no drop covers it.
