# DF-11 build log

## Turn 1

**Changed**

- `app/src/components/PipelineBoard.tsx`: built as designed, using the browser's own drag and drop. Cards are `draggable` unless their edit form is open. `dragstart` writes `text/plain` data and sets `effectAllowed = 'move'`. The board keeps the dragged `{ id, stage }` in a ref and the highlighted column in state. Columns accept `dragover` only when a card drag is in progress and the column is not the card's own. `dragleave` clears the highlight only when `relatedTarget` is outside the column. `drop` calls `onMove` directly, so focus does not move. `dragend` clears everything.
- `app/src/index.css`: added `.column--drop-target` (2px dashed accent outline, 5% accent tint) and `cursor: grab` on draggable cards.
- `app/src/components/PipelineBoard.test.tsx`: 12 drag-and-drop cases, following the design's test strategy. jsdom has no `DragEvent`, so `fireEvent.dragLeave` loses `relatedTarget`. The two leave tests dispatch a `MouseEvent('dragleave')` instead.
- `app/src/App.test.tsx`: one integration case. It drops Harbour on Passed, then checks the summary, the announcement and that the move survives a reload.
- `app/e2e/pipeline.spec.ts`: replaced DF-9's walkthrough with DF-11's.

**Deviation from the design's steps.** One step was added, so there are 23 steps instead of 22. At the 1280px walkthrough width the six columns overflow and the board scrolls sideways, which leaves only a sliver of "Passed" on screen. The new step 12 scrolls the board until "Passed" is in view, and every step after it moves down by one. Drops aim just below a column's last item rather than at its centre, because the stretched columns run below the fold.

**Ran:** `npm run lint` passed. `npm run typecheck` passed. `npm test` passed (app: 72, factory: 313 with 5 skipped). `npm run e2e` passed (1 test, 23 steps). `npm run build` succeeded. The new positive unit tests failed before the implementation. The "nothing happens" cases passed before it too, as expected.

**Outstanding:** nothing for this card.
