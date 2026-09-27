# DF-8 build log

## Turn 1

**Changed**

- New `app/src/crm/`: `types.ts` (`Deal`, `STAGES`, `isActive`, `formatSize`),
  `seed.ts` (six sample deals, one per stage; 4 active, £210m), `useDeals.ts`
  (state, `localStorage` under `df-crm.deals.v1`, seed on absent/corrupt/non-list).
- New components: `AddDealForm`, `PipelineBoard` (columns + deal cards with a
  "Stage for <company>" select, focus kept on the select after a move),
  `PipelineSummary`.
- `App.tsx` rewritten: header, form, board, polite live region announcing adds
  and moves.
- `index.css` rewritten with the neutral palette; `index.css.test.ts` now pins
  `#f7f7f5` / `#1c1c1a`. `index.html` title is "Deal Pipeline".
- Tests written first and seen red: `useDeals.test.ts`, `AddDealForm.test.tsx`,
  `PipelineBoard.test.tsx`, `App.test.tsx`, `index.css.test.ts`.
- No new dependencies.

**Small choices beyond the design**

- The size field is a text input with `inputMode="decimal"` so a non-numeric
  entry reaches validation and gets "Enter a size above 0".
- The summary says "1 active deal" (singular) when the count is one.
- The form has a small "New opportunity" heading (`<h2>`).

**Ran**

- `npm run lint`: clean. `npm run typecheck`: clean.
- `npm test`: 6 files, 26 tests passed.
- `npm run build`: built. `npm run preview` + `curl`: served, title "Deal Pipeline".

**Outstanding**

- `app/src/components/Hello.tsx`, `Hello.test.tsx` and `app/src/hooks/useGreeting.ts`
  are still in the tree. The design deletes them, but this turn's tools could
  not remove files (`rm` and `git rm` were refused). Nothing imports them any
  more, and nothing on screen comes from them. They need deleting.
- There was no browser to click through, so the acceptance steps were checked
  with the jsdom integration tests, which follow the same steps.
