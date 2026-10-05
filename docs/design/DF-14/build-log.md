# DF-14 build log

## Turn 1

**Changed**

- `app/src/App.tsx`: h1 now reads "Deal CRM", has `className="app__title"`, and
  holds the inline briefcase SVG (`aria-hidden`, `focusable="false"`,
  `currentColor`) before the text, as in the design.
- `app/index.html`: `<title>` is "Deal CRM".
- `app/src/index.css`: `.app__header h1` is a flex row (centred, 10px gap);
  new `.app__icon` is 1em square and doesn't shrink.
- `app/src/App.test.tsx`: the first case asserts the heading's accessible name
  is exactly "Deal CRM", its first child is the `aria-hidden` SVG, and "Deal
  Pipeline" is gone.
- `app/src/index.html.test.ts` (new): reads `index.html` as text and pins the
  title. Unlike `index.css.test.ts`, it builds the path with `node:path`.
  `new URL('../index.html', import.meta.url)` is rewritten by Vite into a
  non-file URL, and `readFileSync` throws on that.
- `app/e2e/pipeline.spec.ts`: replaced DF-11's walkthrough with DF-14's, steps
  1–10. Steps 5 (look at the tab) and 7 (open the find bar) have no
  `uatStep`. Step 6 asserts the title and step 8 asserts there's no
  "Deal Pipeline" text.

No new dependencies.

**Ran**

- Both new unit tests failed first, for the expected reasons (old heading, old
  title).
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm test`: 9 files, 73 tests passed.
- `npm run e2e`: 1 passed.
- `npm run build`: built.

**Outstanding**

Nothing. Ready for review.

## Turn 2

The reviewer asked for the name to be "Deal CRM!", with the exclamation mark.
The previous attempt at this turn asked which reading was meant, and the reply
confirmed the "!" should be included. The reply didn't say whether the tab
title should follow, so it does, as the question said it would by default.

**Changed**

- `app/src/App.tsx`: heading text is "Deal CRM!".
- `app/index.html`: `<title>` is "Deal CRM!".
- `app/src/App.test.tsx`, `app/src/index.html.test.ts`: expect "Deal CRM!".
- `app/e2e/pipeline.spec.ts`: steps 1, 2, 6 and 10 expect "Deal CRM!". The
  header comment notes why. Numbering is unchanged (1–10, no 5 or 7).

No new dependencies.

**Ran**

- Both unit tests failed first against the old name.
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm test`: 9 files, 73 tests passed.
- `npm run e2e`: 1 passed.
- `npm run build`: built.

**Outstanding**

Nothing. Ready for review.
