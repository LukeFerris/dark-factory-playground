# DF-7 — Make the background blue

## Context

[DF-7](https://jira.local/browse/DF-7) asks for the app's page background to be
blue instead of "whatever it is now", with a shade chosen so the text already on
the page stays readable.

Today the app has no styling at all, so what someone sees is whatever their
browser's default stylesheet gives them. The card is asking for the page to look
deliberate rather than unstyled, and the readability clause is there so the fix
does not trade one problem for a worse one. The point of the criteria below is to
pin down two things: that the blue covers the whole window rather than a box in
the middle of it, and that the existing heading and greeting are still
comfortably legible on top of it.

## Current state

Read in full: `app/index.html`, `app/src/main.tsx`, `app/src/App.tsx`,
`app/src/components/Hello.tsx`, `app/src/hooks/useGreeting.ts`,
`app/vite.config.ts`, `app/tsconfig.json`, `app/package.json`,
`app/eslint.config.js`, `app/Dockerfile`, `app/nginx.conf`, and both existing
test files.

- **There is no CSS in the repository.** No `.css` file exists anywhere under
  `app/`, `app/index.html` carries no `<style>` block and no stylesheet link, and
  no component sets a `style` prop or a `className`. Every colour, font and
  margin currently on screen comes from the browser's default stylesheet — a
  white canvas with black text, and the usual 8px body margin.
- `app/index.html` renders a single `<div id="root">` and loads
  `/src/main.tsx`.
- `app/src/main.tsx` mounts `<App />` into that div inside `<StrictMode>`, and
  throws if `#root` is missing. It imports nothing else.
- `app/src/App.tsx` renders `<main>` containing an `<h1>` and `<Hello
name="world" />`; `Hello` renders a `<p>` with the string from `useGreeting`.
  So the only visible text is "Dark Factory Playground" and "Hello, world".
- No dark-mode handling exists: there is no `color-scheme` declaration and no
  `prefers-color-scheme` media query, so in a browser set to dark mode the page
  keeps its light default unless the user has forced dark rendering on.

Two details of the test setup matter to this card, because they decide what can
and cannot be asserted:

- `app/vite.config.ts` sets `test.css: false`. Vitest therefore stubs CSS
  imports out rather than processing them, so a stylesheet's declarations never
  reach jsdom.
- jsdom does not do layout or cascade resolution for external stylesheets
  anyway, so `getComputedStyle` in a component test cannot see a rule that lives
  in a `.css` file.

The consequence is that **the visual effect of this card is not assertable from
a component test in this project**, and the test strategy below is written
around that fact rather than pretending otherwise.

Build and serve are unaffected: `app/Dockerfile` runs `vite build` and copies
`dist/` into nginx, and `app/nginx.conf` already serves everything under
`/assets/` with a long cache. A stylesheet emitted by Vite lands in `/assets/`
with a content hash like every other bundled asset, so neither file needs
touching.

## Proposed approach

Add one global stylesheet and import it from the app entry point.

1. New file `app/src/index.css` containing a single `body` rule that sets both
   `background-color` and `color`.
2. `app/src/main.tsx` gains `import './index.css'` as its first import.

The colours are **`background-color: #93c5fd`** on **`color: #000000`**.

`#93c5fd` is an unambiguously blue mid-light shade. Against pure black text it
gives a contrast ratio of roughly **11.6:1**, well past the WCAG AA threshold of
4.5:1 for body text and past the AAA threshold of 7:1 as well. Choosing a light
blue is what lets the card's readability clause be satisfied without changing
how the text looks: the text is black on screen today, and it stays black on
screen afterwards.

The `color` declaration is not a change of appearance — it pins to black what the
browser was already rendering as black. It is in the stylesheet because the
background and the foreground on top of it are a single contrast decision. Set
only the background and the ratio becomes a property of the visitor's browser
defaults rather than of our stylesheet, and nothing in the repo records what the
blue was chosen to sit behind.

The rule goes on `body`, not on `#root` or on `<main>`, and this is the part
most likely to be got wrong. A background on `body` propagates to the canvas
under CSS's background-propagation rule, which paints the entire viewport blue —
including the region covered by the default 8px body margin, and including the
area below the content on a short page. A background on `#root` or `<main>`
instead paints only that element's box, leaving a white frame around the edges
and white space beneath the text. No `height: 100%`, `min-height: 100vh` or
margin reset is needed or wanted; the propagation rule already covers it, and
adding those introduces layout rules the card did not ask for.

A plain stylesheet imported from the entry point is the Vite idiom and needs no
new dependency: Vite already processes `.css` imports, extracts them to a hashed
file at build time, and injects them during `vite dev`.

## Components affected

| File                                                                              | What happens to it                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src/index.css`                                                               | **New.** One `body` rule setting `background-color: #93c5fd` and `color: #000000`, with a short comment saying the two are pinned together as one contrast decision. Nothing else — no reset, no font rules, no selectors for `#root`, `main`, `h1` or `p`. |
| `app/src/main.tsx`                                                                | One line added: `import './index.css'` above the existing imports. No other change; the `#root` guard and the `createRoot` call stay exactly as they are.                                                                                                   |
| `app/src/index.css.test.ts`                                                       | **New.** Guards that the stylesheet still pins both colours. See "Test strategy".                                                                                                                                                                           |
| `app/index.html`                                                                  | Unchanged. The stylesheet is imported through the module graph, not linked from the HTML.                                                                                                                                                                   |
| `app/src/App.tsx`, `app/src/components/Hello.tsx`, `app/src/hooks/useGreeting.ts` | Unchanged. No component gains a `className` or a `style` prop.                                                                                                                                                                                              |
| `app/vite.config.ts`, `app/tsconfig.json`, `app/package.json`                     | Unchanged. No new dependency, and `test.css: false` stays as it is — see the risk note below.                                                                                                                                                               |
| `app/Dockerfile`, `app/nginx.conf`                                                | Unchanged. The emitted stylesheet is a hashed asset under `/assets/`, already covered.                                                                                                                                                                      |

## State and data flow

This change adds no state. The colours are static declarations in a stylesheet;
nothing reads them at runtime, no component re-renders because of them, and no
value crosses a component boundary. The existing greeting state — which is
derived, not stored: `useGreeting` computes a string from its `name` argument on
every render — is untouched.

## Accessibility and UX notes

- **Contrast.** Black `#000000` on blue `#93c5fd` is approximately 11.6:1. That
  clears WCAG 2.1 AA (4.5:1) and AAA (7:1) for body text, and applies to both the
  `<h1>` and the `<p>`, since both inherit `color` from `body`.
- **Colour alone carries no meaning.** The background is decoration. No
  information, state or affordance is conveyed by it, so nobody who cannot
  distinguish the blue loses anything.
- **Screen readers.** Nothing changes. The accessibility tree is untouched: same
  `main` landmark, same level-1 heading "Dark Factory Playground", same
  paragraph "Hello, world". A screen reader announces exactly what it announces
  today.
- **Keyboard and focus.** The page contains no interactive elements — no links,
  buttons or inputs — so there is no focus order to preserve and no focus
  indicator whose contrast could be harmed. This stays true only because the
  change adds no interactive elements of its own.
- **Forced colours.** In Windows High Contrast / forced-colours mode the browser
  overrides both declarations with the user's chosen pair, so the page remains
  readable. That is the correct outcome and the design does nothing to prevent
  it.
- **Text selection and zoom.** Unchanged; no `user-select`, font-size or
  line-height rules are introduced.
- **Loading and error states.** The app has neither. There is no asynchronous
  work, no fetch, and no error boundary, so there is no in-between state for the
  background to be wrong during. The one visible failure path in the code is
  `main.tsx` throwing when `#root` is absent, which is a developer error that
  renders a blank page; it is out of scope here and unaffected.

## Risks and alternatives

**Risk: the background is applied to the wrong element and leaves white edges.**
This is the likely way to get the card wrong — styling `#root` or `main` looks
right in a screenshot of the text but leaves a white frame and white space below
the content. Mitigated by stating the `body` selector explicitly above, and by
the "narrow the window" acceptance criterion, which is what exposes it.

**Risk: the visual change has no automated test behind it.** Real, and
unavoidable in this setup — see "Current state". The stylesheet-content test
described below reduces it to "the declarations are still there", not "the page
looks right". Flagged rather than hidden.

**Alternative: turn on `test.css` in `app/vite.config.ts` so jsdom sees the
rule.** Rejected. It would still not work — jsdom resolves inline `style`
attributes but does not apply a stylesheet's cascade to `getComputedStyle` for
these selectors — so it would mean editing a deliberate config setting for a test
that would not pass anyway.

**Alternative: an inline `style` on a wrapper `<div>` in `App.tsx`, so a
component test can assert it with `toHaveStyle`.** Rejected. It makes the test
easy and the feature wrong: an inline style on a wrapper cannot paint the canvas,
so the white gutter returns. Testability is not worth failing the card's actual
requirement.

**Alternative: a `<style>` block in `app/index.html`.** Rejected. It bypasses
Vite's asset pipeline, is invisible to the module graph, and is untestable by any
route — a stylesheet file is no harder and is the framework's idiom.

**Alternative: a dark navy background with white text.** Rejected. It is a
bigger change than the card asks for: it would mean actually changing how the
existing text renders, whereas a light blue satisfies "keeps the existing text
readable" by leaving the text alone.

**Alternative: add `color-scheme: light` on `html`, or a
`prefers-color-scheme: dark` variant with a darker blue.** Rejected as scope.
The app has no dark theme today and no form controls whose default rendering
would clash; pinning `color` on `body` is enough to keep the text/background
pair intact. A dark variant is a separate card, and would need a second colour
decision nobody has made.

**Alternative: introduce CSS custom properties or a theme token file for the
blue.** Rejected. One rule with two declarations has nothing to share with, and
a token layer for a single colour is structure invented ahead of a need.

## Acceptance criteria

#### The page background is blue

1. Open the app.
2. Look at the area behind and around the text.
3. It is a light blue, not white.

#### The blue covers the whole window, with no white edge or white area below the text

1. Open the app.
2. Look at all four edges of the page area, including the strip above the
   heading and along the left side.
3. Every edge is blue right up to the boundary of the page area, with no white
   border or gutter.
4. Look at the area below the line reading "Hello, world", down to the bottom of
   the window.
5. That area is blue too, not white.

#### The blue still covers the window when it is resized

1. Drag the browser window narrower, to roughly a third of the screen width.
2. The background is still blue right to every edge, with no white showing.
3. Drag the window back to full width.
4. The background is still blue right to every edge.

#### The heading and the greeting are comfortably readable on the blue

1. Open the app.
2. Read the heading "Dark Factory Playground".
3. It is dark text on blue and is easy to read.
4. Read the line beneath it, "Hello, world".
5. It is dark text on blue and is easy to read.

#### The text on the page is unchanged

1. Open the app.
2. The heading reads "Dark Factory Playground".
3. The line beneath it reads "Hello, world".

## Test strategy

The visible outcome of this card cannot be asserted in this project's test setup:
`app/vite.config.ts` sets `test.css: false`, and jsdom does not apply an external
stylesheet's cascade to `getComputedStyle`. Every test below therefore guards
against a _code_ regression, and the acceptance criteria above are what confirm
the page actually looks right. No test here should claim to check the rendered
colour.

**1. The stylesheet still pins both colours (unit, new —
`app/src/index.css.test.ts`).**

Read `app/src/index.css` from disk as text and assert that it contains a `body`
rule declaring `background-color: #93c5fd` and `color: #000000`. Read it with
`readFileSync` from `node:fs`, resolving the path from `import.meta.url` — the
`factory/` workspace already tests files this way, and `@types/node` is hoisted
to the repository root by the npm workspace, so the `node:fs` import typechecks
from `app/` without adding a dependency. Do not add one; if the import fails to
typecheck, say so on the card rather than editing `app/package.json` or
`app/tsconfig.json`.

What it is for: without it, the stylesheet could be emptied or the colours
changed to a failing pair and the suite would stay green. It asserts the two
declarations exist as a pair, which is the thing the contrast claim in this
design rests on. It deliberately does not assert anything about how the page
renders.

**2. The app entry loads the stylesheet (unit, new — same file or alongside it).**

Read `app/src/main.tsx` as text and assert it imports `./index.css`. A stylesheet
nothing imports is dead, and that is otherwise a silent failure: the tests pass,
the build succeeds, and the page is white.

**3. The page still renders its content (component, existing — no new tests).**

`app/src/App.test.tsx` and `app/src/components/Hello.test.tsx` already assert the
heading, the default greeting and the blank-name fallback. They must keep passing
unchanged, which is what confirms the new import in `main.tsx` has not broken
rendering. Do not modify them, and do not add colour assertions to them — a
`toHaveStyle` assertion for a stylesheet rule would either fail or, worse, pass
vacuously.

No integration or end-to-end tests. The project has no browser-driving harness,
and adding one for a single background colour is far more machinery than this
card justifies.
