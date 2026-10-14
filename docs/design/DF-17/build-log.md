# DF-17 build log

## Turn 1

**Changed**

No application code. The count beside each column name already did what the
card asks, as the design found. This turn adds only tests.

- `app/src/App.test.tsx`: new `column counts` block, plus a `counts()` helper
  that reads each column's level-2 heading in `STAGES` order. It is scoped to
  the six regions because the add form has a level-2 heading too. Five cases:
  first visit (all 1), add (Sourcing 2, the rest unchanged), move by picker
  (Screening 0 with "No deals", Due diligence 2), pass on (Investment
  committee 0, Passed 2), drag and drop (Screening 0 with "No deals", Passed
  2). Each asserts all six counts, not just the two that move.
- `app/src/components/PipelineBoard.test.tsx`: "recounts when the deals
  change". It rerenders with both Sourcing deals moved to Screening and
  expects Sourcing0 and Screening2. It moves both rather than one, as the
  design suggested, because moving one gives counts of 1 and 1, which a
  frozen count of 1 would also pass.
- `app/e2e/pipeline.spec.ts`: replaced DF-14's walkthrough with DF-17's,
  steps 1–14 in one test. Every step has a `uatStep`. The drag uses
  Playwright's `dragTo`, which drives the real HTML5 drag in Chromium.

No new dependencies.

**Ran**

- Red check: I temporarily replaced the count with a constant `1` in
  `PipelineBoard.tsx`. Six count tests failed: five new ones plus the
  existing board test. "First visit" stays green under a frozen 1, which is
  expected. Then I restored the line. `PipelineBoard.tsx` has no net change.
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm test`: 9 files, 79 tests passed.
- `npm run e2e`: 1 passed.
- `npm run build`: built.

**Outstanding**

Nothing. Ready for review.

## Turn 2

**Asked**

The reviewer asked for each count to be a small grey pill badge next to the
column name, rather than plain text. The count was already a pill, but a very
faint one (#e4e4e0 on the #f7f7f5 page, no edge) pushed to the far right end
of the header by `justify-content: space-between`, so it read as loose text
away from the name.

**Changed**

- `app/src/index.css`: `.column__title` is no longer a flex row; it flows as
  inline text so the count follows the name. Flex with a gap was tried first,
  but "Investment committee" wraps in a 220px column, and a wrapped flex text
  item keeps its full width, which left that pill ~93px from the end of the
  word. `.column__count` is now `inline-block` with an 8px left margin,
  centred vertically, with a 1px `--pill-edge` (#cacac4) border on a `--pill`
  (#e4e4e0) fill so it reads as a badge on the off-white page. Text stays
  `--muted` (#5c5c57), above 5:1 on the fill. Two new custom properties.
- `app/src/index.css.test.ts`: guards that the title is not flex or
  space-between and that the count is an inline-block pill with fill, edge
  and 999px radius. Seen red against the turn-1 CSS first.
- `app/e2e/pipeline.spec.ts`: steps 3 and 14 also check each pill's fill,
  edge and radius, and that its left edge is within 12px of the end of the
  name's last line. Step numbers unchanged (1–14).

No new dependencies. No component change.

**Ran**

- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm test`: 9 files, 80 tests passed (plus the factory workspace, 427).
- `npm run e2e`: 1 passed. It failed first on the flex layout, as above.
- `npm run build`: built.

**Outstanding**

Nothing. Ready for review.

## Turn 2 (after merging main, PR #48)

**Asked**

Merging main (PR #48, the golden path's gates) conflicted in
`app/e2e/pipeline.spec.ts` and `app/src/App.test.tsx`. The branch already held
the merge commit with the conflicts resolved, with no markers left, but main's new
`max-lines-per-function` (60) rule failed on this card's two long tests.

**Changed**

- `app/e2e/pipeline.spec.ts`: the single walkthrough test now calls one helper
  per criterion (`firstVisitCounts`, `addingCounts`, `pickerCounts`,
  `draggingCounts`, `passingCounts`, `emptyColumnCount`). Steps and their
  numbers (1–14) and assertions are unchanged.
- `app/src/App.test.tsx`: `counts()` became `expectCounts(...numbers)`, which
  builds the six expected headings from `STAGES`, so each count test states
  its numbers on one line. The drag stub and events, which were copied word for word in
  the drag test and the drag count test, are now one `dragHarbourDentalToPassed`
  helper used by both.
- Stray file: I accidentally created an untracked `app/e2e/pipeline.spec.ts.tail`
  (contents `x`) and my tools would not let me delete it. Playwright only
  picks up `*.spec.ts`, so it does not run, but it should be removed.

**Ran**

- `npm run lint`: clean (it failed before with the two over-length functions).
- `npm run typecheck`: clean.
- `npm test`: app 11 files, 83 passed; factory 713 passed, 5 skipped.
- `npm run test:coverage`: all files 97.7% statements, 89.6% branches.
- `npm run e2e`: 1 passed.
- `npm run build`: built.

**Outstanding**

Remove the stray `app/e2e/pipeline.spec.ts.tail`. Otherwise ready for review.
