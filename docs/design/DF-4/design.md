# DF-4 — Greet the visitor according to the time of day

Jira: **DF-4** — Greet the visitor according to the time of day

## Context

The page says `Hello, world` and has said so since the repository was created. It
says the same thing to everyone, at every hour, which makes the deployed app
indistinguishable from a screenshot of itself. The card asks for a greeting that
changes with the time of day where the visitor is — morning, afternoon or
evening — so that the page visibly reflects something about the moment it was
opened.

There is a second reason this card exists in this shape. It is the first card to
exercise the Azure preview environment, which has never raised a preview. A
change that is only provable in unit tests would not tell us whether the preview
works, so the behaviour has to land in the rendered text of the page: opening
the preview URL either shows a time-appropriate greeting or it does not, and
either way we learn something about the environment.

## Current state

Read in full: `app/src/App.tsx`, `app/src/components/Hello.tsx`,
`app/src/hooks/useGreeting.ts`, `app/src/App.test.tsx`,
`app/src/components/Hello.test.tsx`, `app/src/main.tsx`, `app/index.html`,
`app/vite.config.ts`, `app/src/setupTests.ts`, `app/package.json`.

The greeting is three files deep and very small:

- `app/src/App.tsx` renders `<main>` with an `<h1>Dark Factory Playground</h1>`
  and `<Hello name="world" />`. The name is a hard-coded literal; there is no
  input field anywhere in the app.
- `app/src/components/Hello.tsx` takes a `name` prop, calls `useGreeting(name)`
  and renders the result inside a bare `<p>`.
- `app/src/hooks/useGreeting.ts` is not actually a React hook despite the name —
  it is a pure function. It trims the name, substitutes the constant `'world'`
  when the trimmed name is empty, and returns the template string
  `` `Hello, ${...}` ``.

Two details that matter for this card:

- **There is no CSS and no server rendering.** `main.tsx` mounts `<App />` into
  `#root` with `createRoot`, wrapped in `<StrictMode>`. It is a plain Vite SPA,
  so everything renders in the visitor's browser and there is no hydration
  mismatch to worry about when we read the local clock. StrictMode does mean the
  component renders twice in development, which is worth knowing but is harmless
  here.
- **Two existing tests assert the literal string `Hello, world`** —
  `App.test.tsx` ("renders the default greeting") and the blank-name case in
  `Hello.test.tsx`. Both fail the moment the greeting changes, and both have to
  be updated as part of this card rather than left for a follow-up.

Test setup is Vitest with jsdom and `@testing-library/react`, `globals: true`,
and `@testing-library/jest-dom/vitest` loaded from `src/setupTests.ts`. Vitest's
fake timers are available and no new dependency is needed to control the clock
in tests.

## Proposed approach

Keep the shape of the code exactly as it is — `App` renders `Hello`, `Hello`
calls `useGreeting`, `useGreeting` returns a string — and change only what
`useGreeting` returns.

Replace the fixed `Hello, ` prefix with one of three prefixes chosen from the
current local hour:

| Local hour | Greeting |
| --- | --- |
| 05:00 – 11:59 | `Good morning, world` |
| 12:00 – 17:59 | `Good afternoon, world` |
| 18:00 – 04:59 | `Good evening, world` |

**Why these words.** "Good morning / afternoon / evening" is the conventional
English triple, it maps one-to-one onto the three periods the card names, and it
keeps the existing `«prefix», «name»` sentence shape — so the blank-name
fallback to `world` keeps working unchanged rather than needing to be
rethought.

**Why these boundaries.** Noon and 18:00 are the ordinary English splits and
need no defending. The interesting choice is the bottom of the morning: 05:00
rather than midnight. Rolling straight from evening into morning at 00:00 would
greet someone browsing at 2am with "Good morning", which reads as a bug. Ending
the evening at 05:00 keeps the small hours in the period a person would
recognise. The card names three periods, so there is deliberately no fourth
"Good night" band — the evening simply runs long.

**How the hour is obtained.** `new Date().getHours()`, which is the browser's
local hour in the visitor's own time zone. That satisfies the card's "visitor's
own clock rather than the server's" constraint directly, with no time-zone
library and no configuration.

**Structure inside the file.** Split the choice out as a small exported pure
function alongside the existing one:

```ts
export function greetingPrefix(hour: number): string
```

It returns `'Good morning'`, `'Good afternoon'` or `'Good evening'` for an hour
in 0–23. `useGreeting` then reads the clock once and composes:

```ts
export function useGreeting(name: string): string {
  const trimmed = name.trim()
  const who = trimmed === '' ? FALLBACK_NAME : trimmed
  return `${greetingPrefix(new Date().getHours())}, ${who}`
}
```

The split exists for one reason: `greetingPrefix` can be tested at every
boundary hour as a plain function call, with no fake timers and no rendering, so
the boundary behaviour is pinned down cheaply and the component tests only have
to prove that the wiring works. `getHours()` is specified to return an integer
0–23, so `greetingPrefix` needs no defensive handling of out-of-range input —
an `if`/`else if`/`else` chain covers the domain.

The greeting is computed during render, from the clock, at the moment the page
loads. There is no timer and no re-computation: a page left open across 18:00
keeps showing "Good afternoon" until it is reloaded. This is the smallest change
that satisfies the card, and nothing in the card asks for a page to update while
it sits idle.

`App.tsx` and `Hello.tsx` are not touched at all.

## Components affected

| File | What happens to it |
| --- | --- |
| `app/src/hooks/useGreeting.ts` | Adds the exported pure `greetingPrefix(hour)` function and the three prefix constants; `useGreeting` composes its result from `greetingPrefix(new Date().getHours())` instead of the literal `Hello, `. The trim-and-fall-back-to-`world` logic is unchanged. The doc comment is updated to describe the time-of-day behaviour and to name the boundary hours. |
| `app/src/hooks/useGreeting.test.ts` | **New.** Unit tests for `greetingPrefix` at every boundary hour. |
| `app/src/components/Hello.test.tsx` | Updated. The two existing assertions on `Hello, Ada` and `Hello, world` are rewritten against a fixed clock; a case per period is added. |
| `app/src/App.test.tsx` | Updated. The `Hello, world` assertion becomes an assertion on the time-appropriate greeting under a fixed clock. |
| `app/src/App.tsx` | Unchanged. Still renders `<Hello name="world" />`. |
| `app/src/components/Hello.tsx` | Unchanged. Still renders `<p>{greeting}</p>`. |

No new dependency, no config change, no new component.

## State and data flow

The change adds no state. `useGreeting` reads the clock during render and
returns a string; the value flows `useGreeting` → `Hello` → the `<p>` text node,
which is the path it already takes. Nothing is stored, nothing is memoised,
nothing crosses a component boundary that did not already.

The one thing worth naming: the current hour is an *input read during render*
rather than derived from props, which makes `useGreeting` impure in the strict
React sense. That is acceptable here because the value is read once per page
load and never used to drive an update — under StrictMode's double render both
passes produce the same string except in the vanishingly unlikely case of a
render that straddles a boundary hour, where the second pass wins and the page
is correct anyway. Adding `useState` or `useMemo` to snapshot the time would
buy nothing this page can observe, so it is left out.

## Accessibility and UX notes

The rendered markup is unchanged: one `<p>` inside `<main>`, beneath the `<h1>`.
Only its text content differs, so there is nothing new to reach by keyboard,
nothing new to focus, and no change to focus order. There are no styles in the
app at all, so colour contrast is the browser default and is untouched.

A screen reader announces the paragraph as it does today — "Good morning,
world" in place of "Hello, world" — on page load, in document order after the
heading.

Two deliberate non-decisions:

- **No live region.** The greeting is computed once at load and never changes
  while the page is open, so `aria-live` would announce nothing and would be
  misleading markup.
- **No `<time>` element and no visible clock.** The card asks for a greeting,
  not for the time to be displayed. The greeting text is the whole of the
  visible change.

There is no loading state and no error state to design for: reading
`new Date().getHours()` is synchronous and cannot fail, and there is no network
call, so the greeting is correct in the first paint.

## Risks and alternatives

**A reviewer sees a different greeting than the author.** This is the intended
behaviour, but it will surprise someone. Two people opening the same preview URL
from different time zones legitimately see different text, and the same URL
opened in the morning and the evening shows different text to the same person.
Anyone reviewing the preview has to check the greeting against *their own*
clock, not against a fixed expected string. The acceptance criteria below are
written as ranges for this reason.

**The existing tests fail if they are not updated.** `App.test.tsx` and
`Hello.test.tsx` both assert `Hello, world` today. If the build agent changes
only the hook, CI goes red. They are listed explicitly under Components
affected so this cannot be missed.

**A test that reads the real clock is flaky.** A component test that renders and
asserts "Good morning" passes in the morning and fails after noon. Every test
that asserts a full greeting string must fix the clock with fake timers first —
called out again under Test strategy.

Alternatives considered and rejected:

- **Compute the greeting on the server or at build time.** Rejected outright:
  the card requires the visitor's clock, and a statically built SPA served from
  nginx has no request-time server to ask anyway.
- **A four-period split adding "Good night" below 05:00.** Rejected because the
  card names exactly three periods, and a fourth band is a wording decision a
  human should make on a later card rather than one the design smuggles in.
- **Re-computing on a timer so a page left open crosses the boundary.** Rejected
  as scope creep. It means an interval, a cleanup, real state, and a decision
  about tick frequency, for a behaviour nobody asked for and no reviewer will
  sit in front of a page long enough to see.
- **Using `Intl.DateTimeFormat` or a date library to resolve the period.**
  Rejected: `getHours()` already returns the local hour, so a library would add
  a dependency and a bundle cost to replace one method call.
- **Passing the hour in as a prop from `App` for testability.** Rejected: it
  moves clock-reading up into the component tree for the benefit of tests only,
  and the exported `greetingPrefix` gives the same testability without changing
  any component's signature.

No ADR is raised for this card. The wording and the boundary hours are local to
one greeting string and do not set a rule other cards have to follow.

## Acceptance criteria

#### The page greets by time of day instead of saying "Hello"

1. Open the app.
2. Look at the line beneath the "Dark Factory Playground" heading.
3. It reads "Good morning, world", "Good afternoon, world" or "Good evening,
   world", and it matches the current time on your own clock.

#### Between 05:00 and 11:59 the greeting reads "Good morning, world"

1. Set your computer's clock to 09:00.
2. Reload the page.
3. The line beneath the heading reads "Good morning, world".
4. Set your computer's clock to 05:00 and reload the page.
5. The line still reads "Good morning, world".

#### Between 12:00 and 17:59 the greeting reads "Good afternoon, world"

1. Set your computer's clock to 14:00.
2. Reload the page.
3. The line beneath the heading reads "Good afternoon, world".
4. Set your computer's clock to 12:00 and reload the page.
5. The line still reads "Good afternoon, world".

#### Between 18:00 and 04:59 the greeting reads "Good evening, world"

1. Set your computer's clock to 20:00.
2. Reload the page.
3. The line beneath the heading reads "Good evening, world".
4. Set your computer's clock to 02:00 and reload the page.
5. The line still reads "Good evening, world".

#### The greeting follows the visitor's own clock, not the server's

1. Set your computer's time zone to one where the local time is in the morning.
2. Reload the page.
3. The line beneath the heading reads "Good morning, world".
4. Set your computer's time zone to one where the local time is in the evening.
5. Reload the page.
6. The line now reads "Good evening, world".

#### The word "Hello" appears nowhere on the page

1. Open the app.
2. Press Cmd-F, or Ctrl-F, and search the page for "Hello".
3. No match is found.

#### The greeting is on the page in the first paint, with no flicker

1. Open the app.
2. Watch the line beneath the heading as the page loads.
3. It shows its final greeting immediately, without first showing "Hello,
   world" or an empty line.

## Test strategy

Every test that asserts a full greeting string must fix the clock first with
Vitest's fake timers — `vi.useFakeTimers()` and `vi.setSystemTime(...)` in a
`beforeEach`, restored with `vi.useRealTimers()` in an `afterEach`. A test that
reads the real clock passes in the morning and fails in the afternoon, which is
the specific failure this card can most easily introduce.

**Unit — `app/src/hooks/useGreeting.test.ts` (new), on `greetingPrefix(hour)`.**
No rendering and no timers needed; these are plain function calls, so test the
boundaries exhaustively:

- Returns "Good morning" for hour 5 and for hour 11.
- Returns "Good afternoon" for hour 12 and for hour 17.
- Returns "Good evening" for hour 18, for hour 23, for hour 0 and for hour 4 —
  the last two proving the evening band wraps through midnight.
- Returns one of the three strings for every hour from 0 to 23, so no hour falls
  through the chain unhandled.

**Unit — `app/src/hooks/useGreeting.test.ts`, on `useGreeting(name)` under a
fixed clock.** The name handling must be proved to survive the change, and this
is the only level at which the blank-name case can be reached at all, because
`App` hard-codes `name="world"` and the app has no input field:

- With the clock at 09:00, `useGreeting('Ada')` returns "Good morning, Ada".
- With the clock at 09:00, `useGreeting('   ')` returns "Good morning, world" —
  the whitespace-only fallback still applies.
- With the clock at 09:00, `useGreeting('')` returns "Good morning, world".
- With the clock at 20:00, `useGreeting('Ada')` returns "Good evening, Ada" —
  the name and the period are chosen independently of each other.

**Component — `app/src/components/Hello.test.tsx` (update).** Replace the two
existing assertions and cover the wiring from the hook to the rendered text:

- With the clock at 09:00, `<Hello name="Ada" />` renders the text "Good
  morning, Ada".
- With the clock at 14:00, `<Hello name="Ada" />` renders "Good afternoon, Ada".
- With the clock at 20:00, `<Hello name="Ada" />` renders "Good evening, Ada".
- With the clock at 09:00, `<Hello name="   " />` renders "Good morning, world".

**Integration — `app/src/App.test.tsx` (update).** The one test that proves what
a visitor actually sees:

- With the clock at 09:00, rendering `<App />` shows the heading "Dark Factory
  Playground" and the text "Good morning, world".
- With the clock at 20:00, rendering `<App />` shows "Good evening, world".
- Rendering `<App />` shows no text containing "Hello" — a regression guard on
  the criterion above, since that is the string the card is removing.

No end-to-end or browser-driver test is added. The app has no test runner beyond
Vitest and jsdom, and adding one is out of scope for a card that changes one
string; the preview URL is what proves the rendered behaviour for this card.
