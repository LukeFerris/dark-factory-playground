# DF-5 — Centre the page's content instead of leaving it in the corner

## Context

Jira card **DF-5**. The app ships no stylesheet, so the browser's default
margins are the whole of its layout: the heading and the greeting sit
hard against the top-left corner of the window. On a wide screen that reads as a
page nobody has finished rather than a page that was meant to look that way.

The card asks for the content to hold the middle of the viewport — both axes, at
any window size, phone included — without changing what the heading and greeting
say or how they are put together. It is also the first card to run through the
new preview launcher, so the result has to be visible on the rendered page: the
check is someone opening the preview link and seeing centred content, not a unit
test passing.

Because there is no CSS in the repository at all, this card also settles *how*
styling arrives here, which the next card will inherit. That decision is
recorded separately in
[ADR 0002](../../adr/0002-styling-with-a-single-global-stylesheet.md); this
document covers the layout change itself.

## Current state

Read from the working tree at `5d76671`:

- `app/index.html` — a bare document: `<div id="root"></div>`, a module script
  pointing at `/src/main.tsx`, and a correct
  `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`.
  No `<link rel="stylesheet">` and no `<style>` block.
- `app/src/main.tsx` — looks up `#root`, throws if it is missing, and renders
  `<App />` inside `<StrictMode>`. It imports nothing but React and `App`.
- `app/src/App.tsx` — renders `<main>` containing `<h1>Dark Factory
  Playground</h1>` and `<Hello name="world" />`. No `className`, no `style`.
- `app/src/components/Hello.tsx` — renders `<p>{greeting}</p>`.
- `app/src/hooks/useGreeting.ts` — builds `Hello, <name>`, falling back to
  `world` for a blank name.

So the whole rendered page is `body > #root > main > (h1, p)`, styled entirely
by the user-agent stylesheet: `body` keeps its 8px default margin, `h1` and `p`
keep their default block margins, and nothing establishes a height, so `body` is
only as tall as its content.

Two details from the tooling that constrain the change:

- `app/tsconfig.json` sets `"types": ["vitest/globals",
  "@testing-library/jest-dom"]` and there is no `src/vite-env.d.ts`. Vite's
  ambient declarations are therefore not in the program, and a bare
  `import './index.css'` from a `.ts`/`.tsx` file would fail `tsc --noEmit` with
  "Cannot find module".
- `app/vite.config.ts` sets `test.css: false`, so Vitest stubs CSS imports and
  jsdom never applies them. No unit test can assert a computed layout value.
  This shapes the test strategy below.

The production path (`app/Dockerfile` → `vite build` → nginx serving
`app/dist`, with `location /assets/` set to `immutable`) already handles hashed
CSS assets the same way it handles hashed JS, so a stylesheet emitted by Vite
needs no infrastructure change.

## Proposed approach

Add one global stylesheet, `app/src/index.css`, and import it once from
`app/src/main.tsx`. Centre by making `body` a grid container whose single child
is placed in the middle.

The substance of the stylesheet:

```css
body {
  margin: 0;
  min-height: 100vh;  /* fallback for browsers without dvh */
  min-height: 100dvh;
  display: grid;
  place-items: center;
}

main {
  padding: 1rem;
  text-align: center;
}
```

Why each part:

- **`min-height`, not `height`.** If the content is ever taller than the viewport
  — a short window, or someone at 200% browser zoom — `height` would clip it.
  `min-height` lets the page grow and scroll instead, and centring still holds
  whenever there is room to spare.
- **`100dvh` after `100vh`.** On mobile Safari and Chrome, `100vh` is the
  viewport *with* the address bar counted out, so content sits slightly below
  centre while the bar is showing. `dvh` tracks the bar. The duplicated
  declaration is the plain-CSS fallback: browsers that do not understand `dvh`
  discard the second line and keep the first.
- **`place-items: center`** on the grid container centres `#root` on both axes in
  one declaration. A grid item that is centred rather than stretched is sized
  `fit-content`, which is clamped to the grid area, so a long line wraps inside
  the window rather than overflowing it. No width is declared anywhere, which is
  what keeps the promise about not pinning to a fixed pixel width.
- **`padding` on `main`, not on `body`.** Padding on `body` would add to its
  `min-height` under the default `content-box` sizing and produce a scrollbar on
  a page that fits. Putting it on the centred item keeps the viewport maths
  untouched and gives the text breathing room on a narrow screen without
  introducing a `box-sizing` reset.
- **`text-align: center`** so the heading and the greeting are centred against
  each other, not just as a block. Two short lines is exactly the case where
  centred text is fine; the note under Accessibility says when it would stop
  being.

Element selectors (`body`, `main`), not classes, and the import goes in
`main.tsx` rather than `App.tsx`. That is deliberate: it means `App.tsx`,
`Hello.tsx` and `useGreeting.ts` are not touched at all, which is what the card
asks for when it says the components stay as they are. The only change to
existing code is one import line.

One supporting file is needed to make that import typecheck: a new
`app/src/vite-env.d.ts` containing `/// <reference types="vite/client" />`.
That is the file Vite's own scaffold ships, and the triple-slash reference pulls
in the `declare module '*.css'` ambient declarations regardless of the
restrictive `types` array in `app/tsconfig.json`. It also costs nothing else —
no dependency, no config edit.

## Components affected

| File | What happens to it |
| --- | --- |
| `app/src/index.css` | **New.** The whole change: the `body` and `main` rules above, and nothing more. No colours, no fonts, no reset. |
| `app/src/main.tsx` | One line added: `import './index.css'` above the existing imports. Nothing else changes. |
| `app/src/vite-env.d.ts` | **New.** One line: `/// <reference types="vite/client" />`, so `tsc --noEmit` resolves the CSS import. |
| `app/src/App.tsx` | Unchanged. |
| `app/src/components/Hello.tsx` | Unchanged. |
| `app/src/hooks/useGreeting.ts` | Unchanged. |
| `app/index.html` | Unchanged. Vite injects the built stylesheet link itself. |
| `app/vite.config.ts`, `app/tsconfig.json`, `app/package.json` | Unchanged. No new dependency, no new config. |
| `docs/adr/0002-styling-with-a-single-global-stylesheet.md` | **New.** Records the styling convention this card sets for later cards. |

## State and data flow

The change adds no state. Nothing is stored, derived, or passed across a
component boundary; the greeting still comes from `useGreeting` exactly as it
does today, and the layout is static CSS with no JavaScript behind it. The one
new edge in the module graph is `main.tsx → index.css`, which Vite resolves at
build time into a hashed stylesheet linked from the emitted `index.html`.

## Accessibility and UX notes

- **Reading and focus order are untouched.** Grid centring moves no element in
  the DOM and reorders nothing, so a screen reader still announces the `main`
  landmark, then the level-1 heading "Dark Factory Playground", then "Hello,
  world". There are no interactive elements on the page, so there is no focus
  order to disturb and no focus ring to restyle.
- **Nothing is clipped when space runs out.** This is the reason for `min-height`
  rather than `height`. At 200% zoom, or in a short window, the content grows
  past the viewport and the page scrolls normally; every word stays reachable.
  This is WCAG 1.4.10 Reflow, and it is the failure mode of most
  centre-the-page recipes.
- **No horizontal scrolling on a narrow screen.** The centred grid item is
  sized to the space available, so the heading wraps at 320px wide instead of
  pushing the page sideways.
- **Contrast is left alone on purpose.** The stylesheet sets no `color` and no
  `background-color`, so the page keeps the user agent's default black-on-white
  and the contrast ratio it already passes with. Introducing a palette would be
  a separate decision on a separate card.
- **Centred text is a judgement call that holds only while the text is short.**
  Ragged left edges slow reading once a paragraph runs to several lines. With a
  heading and a one-line greeting it reads as deliberate; a card that adds body
  copy should revisit `text-align` at that point rather than inherit it.
- **The default font size is untouched**, so the page respects whatever base
  size the reader has set in their browser.

## Risks and alternatives

**Risks**

- *The CSS import does not typecheck.* Covered by `vite-env.d.ts`. If for any
  reason that does not satisfy `tsc --noEmit`, the equivalent fix is adding
  `"vite/client"` to the `types` array in `app/tsconfig.json` — same effect, one
  fewer file. The build agent should not reach for `// @ts-expect-error` or
  `any`; the eslint config bans the latter outright.
- *The stylesheet does not reach the preview.* The centring is invisible if Vite
  emits the CSS but nginx never serves it. The build stage should confirm
  `npm run build` produces a file under `app/dist/assets/` ending in `.css` and
  that `app/dist/index.html` links it, because the Docker image copies `dist`
  wholesale and the preview shows whatever is in there.
- *Vitest and the stylesheet disagree.* `test.css: false` means the import is
  stubbed in tests, so a broken stylesheet cannot fail the suite. That is a
  known gap, not a thing to fix here; the browser checks under Acceptance
  criteria are what covers it.
- *`dvh` support.* The `100vh` line preceding it means older browsers get
  centring that is a few dozen pixels off on mobile rather than no centring.

**Alternatives considered and rejected**

- *A CSS framework (Tailwind, or similar).* A dependency, a build plugin, and a
  config file, to express two rules. The card explicitly asks for the least
  machinery that does the job.
- *CSS Modules or a CSS-in-JS library.* Both require a `className` on `<main>`,
  which means editing `App.tsx` — the one thing the card asks to leave alone.
  Global element selectors keep the component files untouched.
- *Inline `style` props on `App.tsx`.* Same objection, plus inline styles cannot
  express the `100vh`/`100dvh` fallback pair at all, since an object can hold
  only one value per property.
- *Flexbox (`display: flex; align-items: center; justify-content: center`)
  instead of grid.* Equivalent result. `place-items: center` is one declaration
  instead of three, and the grid item's `fit-content` sizing gives the
  no-overflow behaviour without a `max-width`.
- *Absolute positioning with `top: 50%; transform: translateY(-50%)`.* Centres
  fine until the content is taller than the viewport, at which point the top of
  it goes off-screen and cannot be scrolled to. Rejected for the reflow reason
  above.
- *A `<link>` in `index.html` instead of an import from `main.tsx`.* Works, and
  sidesteps the typecheck question, but it puts the stylesheet outside the
  module graph where the rest of the app's dependencies live, and it is not the
  shape a Vite app is normally read as having.

## Acceptance criteria

#### The heading and the greeting sit in the middle of the window when the page loads

1. Open the preview link in a desktop-sized browser window.
2. Look at where the text sits.
3. The heading "Dark Factory Playground" and the line "Hello, world" sit
   together in the middle of the window, with roughly the same amount of empty
   space above them as below, and to the left as to the right.

#### The heading and the greeting still read exactly as they did

1. Look at the top line of the centred text. It reads "Dark Factory
   Playground".
2. Look at the line beneath it. It reads "Hello, world".

#### The content stays in the middle as the window is resized

1. Drag the corner of the browser window to make it about half as wide.
2. The text is still in the middle of the window.
3. Drag the window shorter, to about half its original height.
4. The text is still in the middle of the window.

#### The page looks deliberate at phone width, with no sideways scrolling

1. Narrow the browser window to about 375 pixels wide.
2. The text is still centred, wrapping onto more lines if it needs to.
3. Try to scroll the page sideways.
4. Nothing moves — there is no horizontal scrollbar and no content hidden off
   to the right.

#### Content taller than the window stays readable instead of being cut off

1. Drag the browser window down to roughly 200 pixels tall.
2. Scroll to the top of the page.
3. The whole heading is visible, with nothing cut off above it, and scrolling
   down reaches the whole of "Hello, world".

#### The centred content is still fully readable at 200% browser zoom

1. Press Ctrl and + (Cmd and + on a Mac) until the browser's zoom indicator
   reads 200%.
2. The heading and the greeting are still centred, wrapping onto more lines if
   they need to.
3. Scroll up as far as the page goes.
4. The whole of "Dark Factory Playground" and the whole of "Hello, world" can
   be reached by scrolling, with no text cut off above the top of the page.

## Test strategy

Vitest runs in jsdom with `test.css: false`, so stylesheets are stubbed and
`getComputedStyle` reports nothing useful. **No test should assert a centred
position, a pixel value, or the contents of `index.css`** — the first two cannot
work, and the third tests the diff rather than the behaviour. Centring is proved
in the browser, by the criteria above, on the preview link.

What the suite should hold instead:

- **`app/src/App.test.tsx` (component, exists already).** Leave the two existing
  assertions in place unchanged. They are the regression guard that matters
  here: if the build stage ends up editing markup to achieve the layout, the
  heading and greeting assertions catch it.
- **`app/src/App.test.tsx` (component, new case).** Assert that the page's
  content sits inside a single `main` landmark, and that the heading and the
  greeting are both within it — `getByRole('main')` containing
  `getByRole('heading', { name: 'Dark Factory Playground' })` and the text
  "Hello, world". The stylesheet targets the `main` element by name, so this
  test is what fails if a later card renames or unwraps that element and
  silently breaks the layout.
- **`app/src/components/Hello.test.tsx` (component, exists already).** Untouched.
  Nothing in this card goes near the greeting logic.

Two checks that are not automated tests but should be done before the turn is
reported as finished:

- `npm run build --workspace @factory/app` emits a `.css` file under
  `app/dist/assets/` and `app/dist/index.html` contains a `<link>` to it. A
  stylesheet that does not ship is the one way this card can pass its tests and
  still fail on the preview.
- `npm run lint` and `npm run typecheck` both pass, the latter being the real
  check on whether `vite-env.d.ts` did its job.
