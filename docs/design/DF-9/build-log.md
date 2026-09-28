# DF-9 build log

## Turn 1 — 2026-09-28

**Changed**

- `app/src/crm/validateDeal.ts` (new): `parseSize` moved out of `AddDealForm`,
  plus `validateDeal`, which returns a trimmed `NewDeal` or field errors.
  `AddDealForm` now uses it; its existing tests pass unchanged.
- `app/src/components/EditDealForm.tsx` (new): the in-card form. Fields are
  pre-filled, ids are namespaced `edit-<id>-<field>`, Company is focused on
  open, errors match the add form, Escape cancels.
- `app/src/components/PipelineBoard.tsx`: new `onUpdate` prop. `DealCard` has
  local `editing` state, a quiet "Edit" button (accessible name
  "Edit <company>") after the stage select, and swaps details, size and the
  stage select for the form while editing. Focus returns to Edit after save or
  cancel.
- `app/src/crm/useDeals.ts`: `updateDeal(id, changes)` keeps `id` and `stage`.
- `app/src/App.tsx`: `handleUpdate` announces "Saved changes to <company>".
- `app/src/index.css`: `.deal__edit`, `.edit-deal`, `.button--secondary`;
  `.button` in the card has no top margin.
- Tests: new `validateDeal.test.ts` and `EditDealForm.test.tsx`; board, hook
  and app tests extended. All new tests were seen failing before the code went in.
- `app/e2e/pipeline.spec.ts`: rewritten as the DF-9 walkthrough, steps 1–36,
  as a single test in the order the reviewer follows. It replaces DF-8's
  add-a-deal walkthrough; adding a deal is still covered by unit tests.

**Deviations from the design's steps**

- The steps now run as one continuous session. Criterion 3 continues from the
  form criterion 2 opened rather than pressing "Edit" again, and the
  size-zero check uses "Harbour Dental Group" instead of "Brightline
  Packaging", which is still open with its company error from the step before.
- Summary checks give the exact totals the reviewer will see (£210m → £225m →
  £140m) instead of "up by 15" / "dropped by 85".
- The keyboard step says "Press End" before typing " Ltd", because where the
  cursor lands on focus depends on the browser.

**Ran**: lint ✓, typecheck ✓, test ✓ (59 passed), e2e ✓ (1 passed), build ✓.

**Not done**: I didn't look at the form in a real browser. Capturing
screenshots locally is outside the allowed commands, so the styling has only
been read, not seen. The preview run's screenshots will be the first look at it.

**Outstanding**: nothing known.
