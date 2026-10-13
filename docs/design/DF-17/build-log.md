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
