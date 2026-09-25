# DF-4 — build log

## Turn 1

**Changed**

- `app/src/hooks/useGreeting.ts` — added the exported pure `greetingPrefix(hour)`,
  an `if`/`if`/`else` chain returning `Good morning` for 05:00–11:59,
  `Good afternoon` for 12:00–17:59 and `Good evening` for everything else, so the
  evening band wraps through midnight to 04:59. `useGreeting` now composes
  `` `${greetingPrefix(new Date().getHours())}, ${who}` ``; the trim-and-fall-back-to-
  `world` logic is untouched. Doc comments updated to name the boundary hours and
  to record that the clock is read once per render, with no timer.
- `app/src/hooks/useGreeting.test.ts` — **new.** Nine tests: `greetingPrefix` at
  every boundary hour (5, 11, 12, 17, 18, 23, 0, 4), a sweep asserting every hour
  0–23 returns one of the three prefixes so no hour falls through the chain, and
  `useGreeting` under a fixed clock for `'Ada'` at 09:00 and 20:00 plus the
  whitespace-only and empty-name fallbacks.
- `app/src/components/Hello.test.tsx` — rewritten against a fixed clock. The two
  old assertions on `Hello, Ada` / `Hello, world` are replaced by one case per
  period (09:00, 14:00, 20:00) and the blank-name fallback at 09:00.
- `app/src/App.test.tsx` — rewritten against a fixed clock: the morning greeting
  alongside the heading, the evening greeting, and a regression guard asserting
  the rendered text contains no `Hello`.

`App.tsx` and `Hello.tsx` were not touched, as the design specified. No new
dependency, no config change.

Every test that asserts a full greeting string fixes the clock with
`vi.useFakeTimers()` + `vi.setSystemTime()` in `beforeEach`, restored in
`afterEach`. The fixed dates are built with the local-time `Date` constructor
(`new Date(2026, 0, 15, hour, 30, 0)`) rather than an ISO string, so the tests
hold whatever time zone CI runs in.

**Ran**

- `npm test` *before* implementing — 16 tests red: `greetingPrefix is not a
  function`, and `expected 'Hello, Ada' to be 'Good morning, Ada'`.
- `npm run lint` — clean, both workspaces. Notably `react-hooks/rules-of-hooks`
  does not object to calling `useGreeting` directly from the test file.
- `npm run typecheck` — clean, both workspaces.
- `npm test` — 16 app tests pass (3 files), 139 factory tests still pass.
- `npm run build` — `vite build` succeeded, 30 modules, `dist/index.html` +
  a 224.37 kB bundle.
- `npm run preview` + `curl http://localhost:4173/` — HTTP 200 serving the SPA
  shell. Grepping the built bundle finds `Good morning`, `Good afternoon` and
  `Good evening`, and no `Hello, ` anywhere, so the behaviour is in the shipped
  artifact and not only in the test environment.

**Outstanding**

- `meta.json` had `preview_url: null` and `pr: null` on this turn, so there was
  no deployed preview to open in a browser. The rendered behaviour was verified
  through jsdom rendering tests, the production build, and the locally served
  bundle. The Azure preview — the second reason this card exists — is still
  unexercised and is the thing for a reviewer to check first.
- By design, the greeting does not update while a page sits open across a
  boundary hour. Unchanged from the design; not a defect.
