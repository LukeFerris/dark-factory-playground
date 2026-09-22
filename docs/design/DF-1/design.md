# DF-1 — Smoke test: greet the user by name

Jira: **DF-1** — "Smoke test: greet the user by name"

## Context

The example app greets a hard-coded name. Someone opening it cannot tell it
apart from a static page: nothing they do changes what it says. The card asks
for one input and one greeting, so that typing a name is visibly reflected back.

This is the factory's first end-to-end card, so its real purpose is to prove the
design → build → review loop on a change small enough that a reviewer can hold
all of it in their head. The value of the card is the round trip, not the
feature; the design should therefore be boring and the diff should be short.

## Current state

Read in full: `app/src/App.tsx`, `app/src/components/Hello.tsx`,
`app/src/hooks/useGreeting.ts`, `app/src/App.test.tsx`,
`app/src/components/Hello.test.tsx`, `app/src/main.tsx`, `app/index.html`,
`app/package.json`, `app/src/setupTests.ts`.

- `app/src/App.tsx` renders `<main>` with an `<h1>Dark Factory Playground</h1>`
  and `<Hello name="world" />`. It holds no state and takes no props.
- `app/src/components/Hello.tsx` is presentational: it takes a `name: string`
  prop, calls `useGreeting(name)`, and renders the result in a `<p>`.
- `app/src/hooks/useGreeting.ts` is a pure function despite the `use` prefix —
  it calls no React hooks. It trims the name and substitutes the constant
  `world` when the trimmed value is empty, returning `` `Hello, ${name}` ``.
  The blank-name fallback the card will need therefore already exists and is
  already documented in the file.
- There is no CSS anywhere in `app/` — no stylesheet is imported by
  `main.tsx` or `index.html`, so the app renders with browser defaults. Nothing
  in this card changes that.
- Tests run under Vitest + jsdom with `@testing-library/react`, and
  `@testing-library/jest-dom` matchers are registered globally in
  `app/src/setupTests.ts`. `@testing-library/user-event` is already a
  devDependency but is not yet used anywhere.
- `app/src/App.test.tsx` asserts the heading renders and that the page shows
  `Hello, world`.

The surprising part, worth stating plainly: the only thing standing between the
app today and the card's behaviour is that `App` passes a literal instead of a
state value. `Hello` and `useGreeting` need no change at all.

## Proposed approach

Make `App` the owner of the typed name, and feed it to the existing `Hello`.

1. `App` gains `const [name, setName] = useState('')`.
2. `App` renders a labelled text input above the greeting, whose `value` is
   `name` and whose `onChange` sets `name` to the raw input value.
3. `App` renders `<Hello name={name} />` instead of `<Hello name="world" />`.

The greeting updates on every keystroke. There is no submit button, no form, and
no debounce: the input is the only control on the page and the greeting is its
only effect, so an extra confirmation step would be ceremony around a single
field.

The initial state is the empty string rather than `'world'`. The user should see
an empty box, not a box they have to clear first, and `useGreeting`'s existing
fallback means the page still reads `Hello, world` before anything is typed.
That also keeps the current `App.test.tsx` assertion true, which is a useful
signal that the change is additive.

The name is stored untrimmed and trimmed only at the point of display, inside
`useGreeting`. This lets someone type `Ada Lovelace` — a mid-string space must
survive — while a half-deleted field still reads `Hello, world` rather than
`Hello,`.

The input lives directly in `App.tsx`. A `NameField` component is not warranted
for one label and one input with no logic of its own; see *Risks and
alternatives*.

No new dependency, no new build config, no ADR: this decision does not outlive
the card.

## Components affected

| File | What happens |
| --- | --- |
| `app/src/App.tsx` | Modified. Adds `useState` for the name, a labelled `<input>`, and passes the state to `Hello`. The only production file that changes. |
| `app/src/App.test.tsx` | Modified. Keeps the existing initial-render assertion; adds the typing behaviours listed under *Test strategy*. |
| `app/src/hooks/useGreeting.test.ts` | New. Unit tests for the trim/fallback rule the design now leans on, which is currently only covered indirectly through `Hello`. |
| `app/src/components/Hello.tsx` | Unchanged. Already takes the name as a prop. |
| `app/src/hooks/useGreeting.ts` | Unchanged. The fallback and trimming are already what the card needs. |
| `app/src/components/Hello.test.tsx` | Unchanged. |
| `docs/design/DF-1/design.md` | This document. |

Nothing under `app/` other than the three files above should appear in the
build diff. No changes to `package.json`, `vite.config.ts`, `tsconfig.json`,
`eslint.config.js`, `index.html`, or the Docker/nginx files.

## State and data flow

One piece of state: the raw string the user has typed, held by `App` in
`useState`, initialised to `''`.

- `App` owns it because it is the nearest common ancestor of the input and the
  greeting, and it is already the app's only container component.
- The input is controlled: its `value` comes from state, and every keystroke
  goes through `onChange` → `setName` → re-render. There is no second copy of
  the name in the DOM to drift out of sync.
- The greeting is **derived, not stored**. `App` passes `name` down; `Hello`
  calls `useGreeting(name)` on each render. Nothing memoises it and nothing
  should — it is a trim and a template literal.
- Nothing crosses a network, storage, or URL boundary. The name is not
  persisted, not put in `localStorage`, and not in the query string; reloading
  the page empties the field. That is intended for a smoke test.

## Accessibility and UX notes

- The input has a visible `<label>` associated by `htmlFor`/`id` (for example
  `id="name"`), with the text **Your name**. A `placeholder` is not a label and
  must not be used as one; the build may omit the placeholder entirely.
- Type is `text`. Not `search`, and no `required` attribute — an empty field is
  a valid state that the `world` fallback exists to serve, so it must not be
  flagged as an error.
- Keyboard reachability and focus order fall out of the DOM order: heading,
  then label + input, then greeting. The input is the only focusable element on
  the page and must be reachable with a single Tab from document start. Nothing
  sets `tabIndex` and nothing steals focus on mount.
- There is no error state and no loading state. The greeting is computed
  synchronously in render, so there is no moment where the page shows a spinner
  or a stale value, and no input is rejected.
- Screen reader behaviour: the label is announced on focus as "Your name, edit
  text"; typed characters are echoed by the screen reader itself. The greeting
  is **not** wrapped in an `aria-live` region — see *Risks and alternatives* for
  why, and note that this is a decision the reviewer may want to reopen.
- Contrast is untouched: the app ships no CSS, so colours remain the user
  agent's defaults, which meet contrast requirements by construction.

## Risks and alternatives

- **Announcing the greeting via `aria-live="polite"`.** Rejected. The greeting
  changes on every keystroke, and a polite live region would queue an
  announcement of the full sentence per character on top of the screen reader's
  own character echo — the noisier outcome for the users it is meant to help.
  The greeting is adjacent to the input and reachable by normal reading, and
  nothing about it is time-sensitive. If a reviewer wants it announced, the
  proportionate version is a live region that updates on blur or after a pause,
  which is more machinery than this card justifies.
- **Extracting a `NameField` component.** Rejected as scope creep. It would be
  a label, an input, and two props forwarded verbatim, in an app whose entire
  UI is a heading, a field, and a paragraph. If a second field ever appears,
  extracting then costs the same as extracting now.
- **Debouncing the greeting update.** Rejected. There is no expensive work
  behind the keystroke — a `trim()` and a string interpolation — so a debounce
  would add lag and a timer to test around for nothing.
- **A submit button or `<form>`.** Rejected. The card says one input and one
  greeting; a submit step adds a second control and a second state (typed but
  not applied) with nothing to spend it on.
- **Risk: the `world` fallback reads as a bug.** Someone clearing the field sees
  `Hello, world` rather than an empty line, which could be mistaken for the
  input having failed. Accepted: the behaviour predates this card, is
  deliberately documented in `useGreeting.ts`, and the alternative — a greeting
  that flickers to `Hello,` mid-edit — is worse. The test strategy pins it so
  the choice is visible in review.
- **Risk: whitespace handling regresses.** If the build trims on input instead
  of on display, typing a space between first and last name becomes impossible.
  The `Ada Lovelace` test below exists to catch exactly that.
- **Risk: the input is left uncontrolled** (`defaultValue`, or state updated
  from a ref). The greeting would then not track the field. The typing tests
  catch it.

## Test strategy

Component level, in `app/src/App.test.tsx`, rendering `<App />` and driving the
input with `@testing-library/user-event` (already available; prefer it over
`fireEvent` so the interaction is a real sequence of key events):

1. **Initial render shows the fallback greeting.** The existing assertion,
   kept: heading is present and the page reads `Hello, world`.
2. **The field is present and labelled.** `getByLabelText('Your name')` returns
   a textbox, and it is initially empty. This asserts the label/control
   association, not just the presence of some text.
3. **Typing a name updates the greeting.** Type `Ada`; the page reads
   `Hello, Ada` and no longer reads `Hello, world`.
4. **A name with an internal space survives.** Type `Ada Lovelace`; the page
   reads `Hello, Ada Lovelace`. Guards against trimming the stored value.
5. **Clearing the field returns to the fallback.** Type `Ada`, then clear the
   input; the page reads `Hello, world` again.
6. **Whitespace-only input is treated as empty.** Type three spaces; the page
   reads `Hello, world`, and the input's own value is still the three spaces
   (the user's keystrokes are not eaten).

Unit level, in a new `app/src/hooks/useGreeting.test.ts`, calling the function
directly:

7. `useGreeting('Ada')` → `'Hello, Ada'`.
8. `useGreeting('')` and `useGreeting('   ')` → `'Hello, world'`.
9. `useGreeting('  Ada Lovelace  ')` → `'Hello, Ada Lovelace'` — outer
   whitespace trimmed, inner whitespace preserved.

`app/src/components/Hello.test.tsx` needs no change and should not be touched.

Before reporting the turn, the build stage runs `npm run lint`,
`npm run typecheck`, `npm run test`, and `npm run build` from `app/`, and
records the outcomes in `docs/design/DF-1/build-log.md`.

## Open questions

None that block implementation. The judgement calls this design made without
asking — the label wording, updating live rather than on submit, not persisting
the name, and leaving the greeting out of a live region — are recorded as
assumptions on the card so a reviewer can overturn any of them here rather than
after the code exists.
