# DF-15 build log

## Turn 1

**Changed**

- `Deal` gained an optional `employees`, with `formatEmployees` ("1 employee",
  "1,300 employees") beside `formatSize`.
- `validateDeal` gained `parseEmployees` (blank → not known; commas stripped;
  digits only, at least 1) and the error "Enter a whole number above 0".
- Both forms have an "Employees" field between Sector and Deal size (£m), with
  the same error markup as size. On error, focus goes to the first wrong field
  on screen: Company, then Employees, then Deal size.
- Cards show the headcount line after the sector line, in the sector/owner
  style, hidden while editing.
- Seed deals carry the headcounts listed in the design.
- `e2e/pipeline.spec.ts` replaced with DF-15's 29-step walkthrough.
- Tests: new `types.test.ts`; new and updated cases in `validateDeal.test.ts`,
  `AddDealForm.test.tsx`, `EditDealForm.test.tsx`, `PipelineBoard.test.tsx`.
  The new cases were run red (36 failing) before the implementation.

**Ran**

- `npm run lint` — clean.
- `npm run typecheck` — clean.
- `npm test` — 10 files, 103 tests passed.
- `npm run e2e` — 1 passed (the walkthrough, steps 1–29).
- `npm run build` — built.

**Deviation from the design**

- None in behaviour. In the walkthrough, the "1 employee, not 1 employees"
  check asserts that the card's only employee line reads exactly "1 employee".
  Playwright's loose text match on "1 employees" matched the "1 employee" line.

**Outstanding**

- Nothing. Ready for review.
