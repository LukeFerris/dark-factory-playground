# DF-10 — Drag deal cards between columns

## Context

[DF-10](https://jira.local/browse/DF-10) says "the user should be able to drag
and drop cards from one column to the next". There is no description and there
are no acceptance criteria.

The cards are the deal cards on the Deal Pipeline board (DF-8, DF-9). The only
way to change a deal's stage today is the "Stage" picker on each card. That
works, but it isn't how people expect a pipeline board to behave. They expect
to pick a card up and put it in another column. DF-8 rejected drag-and-drop
because it said doing it accessibly needed a library or a lot of keyboard code.
This card asks for it anyway. The design gets round that objection by keeping
the "Stage" picker as the keyboard and screen-reader way to move a card. Drag
is an extra way to do the same thing with a mouse.

Earlier scope questions on this board got the answer "this is a proof of
concept; pick whatever keeps it simplest". This design follows the same rule.
"From one column to the next" is read as "into any other column", not only the
column next to it. The picker already allows any stage, and limiting drag to
the next column would make the two ways of moving a card behave differently.

## Current state

Read in full: `app/src/App.tsx`, `app/src/components/PipelineBoard.tsx`,
`app/src/components/PipelineBoard.test.tsx`, `app/src/components/PipelineSummary.tsx`,
`app/src/crm/useDeals.ts`, `app/src/crm/types.ts`, `app/src/crm/seed.ts`,
`app/src/index.css`, `app/e2e/pipeline.spec.ts`, `app/e2e/uat.ts`,
`app/playwright.config.ts`, `app/package.json`, and `docs/design/DF-8/design.md`
and `docs/design/DF-9/design.md`.

- `useDeals` owns the only state, a `Deal[]`, and saves it to `localStorage`
  (`df-crm.deals.v1`) on every change. `moveDeal(id, stage)` maps over the
  array and changes that deal's `stage`. The deal keeps its place in the array.
- `App.handleMove(id, stage)` calls `moveDeal` and announces "Moved <company>
  to <stage>" in the polite live region. It announces even if the stage hasn't
  changed, but the picker's `onChange` never fires for the same value, so that
  can't happen today.
- `PipelineBoard` renders one `<section className="column" aria-label={stage}>`
  per stage. It filters `deals` by stage, so **a card's position inside a
  column follows its place in the array, not the order of moves**. A deal moved
  into a column can land above cards that were already there. That is how the
  picker already behaves, and drag will behave the same way.
- The board wraps `onMove` in `handleMove`, which remembers the moved id and
  refocuses that card's picker after it re-mounts in its new column. That is
  for keyboard users, whose focus was on the picker.
- `DealCard` is an `<article>` with local `editing` state. While editing, it
  shows `EditDealForm` instead of the details and picker.
- The board is a CSS grid of columns. Grid items stretch, so every column is as
  tall as the tallest one. An empty column shows "No deals".
- Dependencies are React 19 and react-dom only. The e2e suite runs Chromium
  only. `app/e2e/pipeline.spec.ts` holds the current card's walkthrough (DF-9's
  editing), with step numbers tied to `result.json`'s acceptance steps. DF-9
  replaced DF-8's walkthrough in the same way.

## Proposed approach

Use the browser's **built-in HTML drag-and-drop**, with no new dependency.

- **Card.** When it is not being edited, each deal card's `<article>` is
  `draggable`. On `dragstart` the card sets `dataTransfer.effectAllowed =
  'move'` and `dataTransfer.setData('text/plain', deal.id)`. Firefox won't
  start a drag without some data. It then tells the board which deal is being
  dragged. On `dragend`, whether or not it was dropped, the board clears the
  drag state. While its edit form is open the card is not draggable, so text
  selection in the fields works as normal.
- **Column.** Each column `<section>` is a drop zone over its full height,
  including the "No deals" placeholder. On `dragover`, if a deal from this
  board is being dragged, it calls `preventDefault()` (which is what allows a
  drop), sets `dropEffect = 'move'` and marks itself as the column under the
  pointer. On `dragleave` it clears that mark, but only when the pointer has
  actually left the column (`relatedTarget` is outside the section), not when
  it moves between the column's children. On `drop` it calls `preventDefault()`,
  and if the dragged deal's stage differs from this column's stage it calls the
  board's `onMove(id, stage)`. Dropping on the card's own column does nothing.
- **Which deal is dragged** comes from board state, not from `dataTransfer`.
  So dragging text or files from outside the page is never accepted and never
  moves anything, and jsdom tests don't need a working `DataTransfer`.
- **Focus.** A drop calls the board's `onMove` prop directly, not `handleMove`.
  Focus doesn't move on a mouse drop. The picker-refocus behaviour stays for
  picker moves only.
- **Announcement.** A drop goes through `App.handleMove`, so it announces
  "Moved <company> to <stage>" exactly as the picker does. `App` doesn't change.
- **Look.** Cards get `cursor: grab`. The card being dragged is faded
  (`opacity: 0.5`). The column under the pointer gets a 2px dashed accent
  outline and a light tint of the page colour, so it's clear where the card
  will land. Both clear when the drag ends.
- **Escape** during a drag cancels it. That is built into the browser: `dragend`
  fires with no `drop`, so nothing moves and the highlight clears.

**Why this shape.** Built-in drag-and-drop covers mouse use on desktop with a
few event handlers and no dependency. The keyboard and screen-reader objection
from DF-8 is already met by the "Stage" picker, which stays unchanged. See
Risks for what this leaves out.

## Components affected

| File | Change |
| --- | --- |
| `app/src/components/PipelineBoard.tsx` | Board gains `draggingId: string \| null` and `overStage: Stage \| null` state. Each column `<section>` gets `onDragOver`, `onDragLeave` and `onDrop`, plus the class `column--drop-target` when `overStage` is its stage. `DealCard` gets two new props, `onDragStart(id)` and `onDragEnd()`, and a `dragging` flag. Its `<article>` gets `draggable={!editing}`, the drag handlers, and the class `deal--dragging` while dragged |
| `app/src/components/PipelineBoard.test.tsx` | New drag cases (below). Existing cases unchanged |
| `app/src/App.test.tsx` | New integration case: a drop moves the deal, announces it and updates the summary |
| `app/src/index.css` | `.deal[draggable='true'] { cursor: grab }` (so a card with its edit form open keeps the normal cursor), `.deal--dragging`, `.column--drop-target` |
| `app/e2e/pipeline.spec.ts` | Replaced by DF-10's walkthrough, one `uatStep` per acceptance step below, numbered 1..N in order. Uses Playwright's mouse drag (`locator.dragTo`, or `page.mouse` down/move/up where a step has to look at the page mid-drag). Editing stays covered by the unit tests |

No change to `useDeals`, `types`, `App.tsx`, the stored data or the storage
key. No new dependencies.

## State and data flow

- **Deal data** is still owned only by `useDeals`. A drop ends in the existing
  `moveDeal`, so saving and the summary work as they do today.
- **Drag state** is two `useState` values in `PipelineBoard`: `draggingId` (the
  deal being dragged) and `overStage` (the column under the pointer). They are
  state rather than refs because they drive the faded card and the highlighted
  column. They are never saved or lifted up. Both reset to `null` on `dragend`
  and on `drop`.
- **Flow:** card `dragstart` → `setDraggingId(id)` → column `dragover` →
  `setOverStage(stage)` → column `drop` → if the deal's stage ≠ column stage,
  `onMove(id, stage)` → `App.handleMove` → `moveDeal` + announcement → card
  re-mounts in the new column. `dragend` fires on the original element, which
  may already be unmounted. So the reset happens in the drop handler as well,
  and does not depend on `dragend` alone.
- **Derived, not stored:** which column the dragged deal is in comes from
  `deals.find(d => d.id === draggingId)`. Column counts and the summary still
  recompute from `deals`.

## Accessibility and UX notes

- **Drag is mouse-only by design. The "Stage" picker is the equivalent way to
  move a card for keyboard, screen-reader and switch users.** Every move that
  drag can make, the picker can make too. That meets WCAG 2.5.7 (Dragging
  Movements). The picker, its label "Stage for <company>", its tab order and
  its refocus-after-move stay exactly as they are.
- No `aria-grabbed` or `aria-dropeffect`: both are deprecated and screen readers
  ignore them. The card's role and name don't change. `draggable` doesn't make
  the article focusable, so the tab order is unchanged.
- A successful drop is announced in the existing live region: "Moved
  <company> to <stage>". A cancelled drag, or a drop on the card's own column,
  announces nothing.
- The drop highlight is an outline and tint in the existing accent and page
  colours, not colour alone: the dashed outline shape is the cue. The faded
  card is only decoration while the drag is in progress.
- A card with its edit form open can't be dragged, so clicking and dragging
  inside a text field selects text as usual.
- Nothing loads and nothing can fail: moves are synchronous.

## Risks and alternatives

- **Touch screens.** Built-in drag-and-drop doesn't start from a finger on most
  phones. On touch devices people keep using the "Stage" picker. Moderate, and
  accepted for a proof of concept. Touch dragging needs pointer-event code or a
  library.
- **Position within a column.** A dropped card lands where its place in the list
  puts it, not where the pointer was. That matches the picker. Reordering
  inside a column needs a stored order field, which is a separate card. Minor.
- **`dragend` on an unmounted card.** The card re-mounts in its new column
  before `dragend` fires, so the old element's handler may never run. The drop
  handler clears the drag state itself for this reason. The test for
  "highlight clears after a drop" guards it.
- **jsdom has no real drag-and-drop.** Component tests use `fireEvent.dragStart`,
  `dragOver`, `drop` and `dragEnd` with a stub `dataTransfer`
  (`{ setData() {}, effectAllowed: '', dropEffect: '' }`). The real browser
  path is proven by the Playwright walkthrough in Chromium.
- **Rejected: a drag library (dnd-kit, react-beautiful-dnd).** It would bring
  touch and keyboard dragging, but it's a new dependency and a larger change,
  and the picker already covers keyboard use. It would be the right step if
  touch dragging or reordering becomes a requirement.
- **Rejected: hand-written pointer-event dragging.** It works on touch, but
  hit-testing, a drag preview and scrolling would all be custom code. Too much
  for this card.
- **Rejected: only allowing a drop on the next column.** It's a literal reading
  of the card, but it would stop drag doing what the picker does, including
  moving a deal straight to "Passed".
- **Rejected: refocusing the picker after a drop.** A mouse user didn't have
  focus there. Moving focus could scroll the page and show a focus ring nobody
  asked for.

## Acceptance criteria

The steps start from the sample board on a first visit (one deal per column,
summary "4 active deals · £210m in pipeline") and follow on from each other.

#### A card dragged onto another column moves to that column

1. Drag the "Northwind Analytics" card from "Sourcing" and drop it on the "Due
   diligence" column.
2. "Northwind Analytics" is now in "Due diligence", its "Stage" picker reads
   "Due diligence", the "Due diligence" count reads 2, and "Sourcing" shows "No
   deals" with a count of 0.

#### While dragging, the column under the card is highlighted

1. Press and hold on the "Harbour Dental Group" card and move the pointer over
   the "Investment committee" column without letting go.
2. "Investment committee" has a dashed outline and "Harbour Dental Group" looks
   faded.
3. Let go outside any column, above the board.
4. The outline and fading are gone and "Harbour Dental Group" is still in
   "Screening".

#### Dropping a card back on its own column changes nothing

1. Drag the "Brightline Packaging" card and drop it back on the "Due diligence"
   column.
2. "Brightline Packaging" is still in "Due diligence", the count still reads 2,
   and the summary still reads "4 active deals · £210m in pipeline".

#### Dragging a deal to "Passed" takes it out of the pipeline summary

1. Drag the "Harbour Dental Group" card and drop it on the "Passed" column.
2. "Harbour Dental Group" is in "Passed" and the summary reads "3 active deals ·
   £185m in pipeline".

#### A card being edited cannot be dragged

1. On the "Kestrel Energy Services" card, press "Edit".
2. Drag the card by its company name onto the "Closed" column.
3. "Kestrel Energy Services" is still in "Investment committee" with its edit
   fields open.

#### The "Stage" picker still moves cards

1. On the "Meridian Foods" card, choose "Screening" in the "Stage" picker.
2. "Meridian Foods" is now in "Screening".

#### Moves made by dragging survive a reload

1. Reload the page.
2. "Northwind Analytics" is in "Due diligence", "Harbour Dental Group" is in
   "Passed", "Meridian Foods" is in "Screening", and the summary reads "4
   active deals · £305m in pipeline".

## Test strategy

- **`PipelineBoard` (component)**, using `fireEvent` drag events with a stub
  `dataTransfer`:
  - every card not being edited has `draggable="true"`, and a card with its
    edit form open has `draggable="false"`;
  - dragstart on a card, then dragover and drop on another column, calls
    `onMove` once with that deal's id and the column's stage;
  - dropping on the card's own column doesn't call `onMove`;
  - a drop with no dragstart from this board (an outside drag) doesn't call
    `onMove`, and its dragover doesn't `preventDefault` (check
    `fireEvent.dragOver` returns `true`);
  - dropping on an empty column (the "No deals" placeholder) calls `onMove`;
  - during a drag the column under the pointer has `column--drop-target` and
    the dragged card has `deal--dragging`; after a drop or a `dragend`, neither
    class is present anywhere;
  - `dragleave` into a child of the same column keeps the highlight, and
    `dragleave` to outside the column removes it;
  - after a drop, focus doesn't move to the moved card's picker (picker moves
    still refocus it, and the existing test covers that).
- **`App` (integration):** a drag-and-drop of a seed deal onto another column
  moves it there, the live region reads "Moved <company> to <stage>", the
  summary updates when the target is "Passed", and the move survives an
  unmount and re-render (storage).
- **End-to-end walkthrough (`app/e2e/pipeline.spec.ts`, Chromium):** the
  acceptance steps above in order, one `uatStep` per step. This is the only
  test of real browser drag-and-drop, so every step that drags does it with the
  real mouse, not by sending synthetic events.
- **Unchanged and still passing:** the existing `PipelineBoard`, `useDeals`,
  `EditDealForm`, `AddDealForm` and `App` tests. They guard the picker and
  editing.
