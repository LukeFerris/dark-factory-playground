# DF-6 — Turn the background pink

## Context

Jira card DF-6 asks for the page background to be pink.

The app is currently unstyled — it renders on the browser's default white with
the browser's default black text. Someone looking at a preview deployment
cannot tell at a glance whether they are looking at this app, a blank page, or
a failed build. A distinctive background is the cheapest way to make "the app
is up and this is it" obvious on sight.

The card carries no acceptance criteria and does not name a shade, so the
criteria below are written from the plain reading of the summary: the page
background, the whole of it, pink.

## Current state

Read in full: `app/index.html`, `app/src/main.tsx`, `app/src/App.tsx`,
`app/src/components/Hello.tsx`, `app/src/hooks/useGreeting.ts`,
`app/vite.config.ts`, `app/tsconfig.json`, `app/eslint.config.js`,
`app/package.json`, `app/Dockerfile`, `app/nginx.conf`.

There is **no CSS anywhere in the repository**. No `.css` file exists, no
`<style>` block appears in `app/index.html`, no component carries a `style`
prop or a `className`. Every colour on the page today comes from the browser's
user-agent stylesheet.

The render tree is three elements deep and entirely static:

- `app/src/main.tsx` mounts `<App />` into `#root` inside `<StrictMode>`.
- `app/src/App.tsx` renders `<main>` containing an `<h1>` reading
  "Dark Factory Playground" and `<Hello name="world" />`.
- `app/src/components/Hello.tsx` renders a `<p>` holding the string from
  `useGreeting`, which is `"Hello, world"`.

There are no interactive elements on the page at all — no links, no buttons, no
inputs — so there is no focus order and no focus indicator to preserve.

Two things in the test setup matter for this card and are easy to miss:

- `app/vite.config.ts:12` sets `test.css: false`. Vitest therefore **stubs CSS
  imports and never applies stylesheet rules to the jsdom document**. A test
  cannot assert `getComputedStyle(document.body).backgroundColor` and get
  anything meaningful back.
- `app/tsconfig.json:6` pins `"types": ["vitest/globals",
  "@testing-library/jest-dom"]`. An explicit `types` array suppresses automatic
  inclusion of every other ambient type package, and the standard Vite scaffold
  file `src/vite-env.d.ts` is absent from this app. So Vite's client module
  declarations — including the one for `?raw` imports — are not in scope today.

`app/Dockerfile` builds with `vite build` and serves `app/dist` from nginx;
`app/nginx.conf` serves hashed files under `/assets/` with a long cache and
`index.html` with `no-cache`. A stylesheet imported from a module is emitted by
Vite into `/assets/` with a content hash, so both the container build and the
cache policy already handle it with no change.

## Proposed approach

Add one global stylesheet and import it from the entry module.

Create `app/src/index.css`:

```css
:root {
  color-scheme: light;
}

body {
  background-color: pink;
  color: #1a1a1a;
}
```

and add `import './index.css'` as the first import in `app/src/main.tsx`.

Three points about that stylesheet, since each is a decision rather than
boilerplate:

**`background-color` on `body`, not on `<main>`.** When `html` has no
background of its own, the `body` background propagates to the canvas, so the
whole viewport is pink regardless of how short the content is. Styling `<main>`
instead would leave a white band below the two lines of text, which is not what
"turn the background pink" means.

**`color` is set alongside it.** Setting a background without setting a
foreground leaves the text colour to the user agent, and a user agent that
decides to serve dark-mode defaults would put near-white text on pink. Pinning
`#1a1a1a` keeps the pairing under our control; it measures about 11:1 against
`pink`, which clears WCAG AAA.

**`color-scheme: light`.** The page is now explicitly a light-scheme page.
Declaring that stops browser auto-dark-mode heuristics from inverting the pink,
and keeps scrollbars and any future form controls on the light UA palette so
they do not clash.

"Pink" is taken as the CSS named colour `pink` (`#FFC0CB`) — the literal
reading of the card, and a one-declaration change if a reviewer wants a
different shade.

Because vitest stubs CSS imports, the guard test reads the stylesheet as text
rather than as applied style. That needs Vite's `?raw` module declaration, so
this card also adds the missing `app/src/vite-env.d.ts` — the file Vite's own
React template ships and this app happens not to have.

No ADR is raised. `src/index.css` imported from the entry module is the Vite
default convention rather than a choice, and nothing here changes a library, a
data-flow shape, or a rule another card has to follow.

## Components affected

| File | What happens to it |
| --- | --- |
| `app/src/index.css` | **New.** The three declarations above, and nothing else. |
| `app/src/main.tsx` | One line added: `import './index.css'`, placed first, above the React imports, so the stylesheet is in the graph before anything renders. Nothing else in the file changes. |
| `app/src/vite-env.d.ts` | **New.** A single line, `/// <reference types="vite/client" />`. Brings Vite's ambient module declarations — notably `*?raw` — into scope despite the explicit `types` array in `tsconfig.json`. Covered by `"include": ["src"]` already. |
| `app/src/styles.test.ts` | **New.** The stylesheet guard tests described under Test strategy. |
| `app/src/App.test.tsx` | Unchanged. It must keep passing as-is; that is its job here. |
| `app/index.html` | Unchanged. The stylesheet arrives through the module graph, so there is no `<link>` to add. |
| `app/vite.config.ts`, `app/tsconfig.json`, `app/package.json` | Unchanged. No new dependency, no config edit — `vite-env.d.ts` exists precisely so none is needed. |

## State and data flow

No state is added, moved, or derived. The change is a static stylesheet applied
to `body` by the browser's cascade; no React component reads it, writes it, or
re-renders because of it, and nothing crosses a component boundary. `App` and
`Hello` keep their current signatures, and `useGreeting` is untouched.

The only new edge in the module graph is `main.tsx → index.css`, which Vite
resolves at build time into a hashed file under `/assets/` linked from the
emitted `index.html`.

## Accessibility and UX notes

**Contrast.** `#1a1a1a` on `pink` (`#FFC0CB`) is a contrast ratio of roughly
11:1. That clears WCAG 2.1 AA (4.5:1) and AAA (7:1) for body text, with margin
to spare if the shade is later adjusted. Both the `<h1>` and the `<p>` inherit
this pairing from `body`, so there is no element left on a default colour.

**Keyboard and focus.** Unchanged, and there is nothing to change: the page
contains no focusable elements, so there is no focus order and no focus ring
whose visibility against pink could be in question. The first card to add a
control will need to check its focus indicator against this background.

**Screen readers.** Nothing is announced differently. No text, no roles, no
ARIA attributes and no DOM structure change — colour is presentational and
carries no information here, so nothing is conveyed by colour alone.

**Forced colours.** In Windows High Contrast / `forced-colors: active`, the
user agent overrides both `background-color` and `color`. That is the correct
outcome and is deliberately not fought with `forced-color-adjust`: a user who
has asked for their own palette gets it, and the page stays legible.

**Dark mode.** `color-scheme: light` makes the page's intent explicit, so the
background stays pink and the text stays dark when the operating system is set
to dark appearance.

**Loading and error states.** Not applicable — the stylesheet is a static asset
in the same bundle as the app, with no fetch of its own that could fail or be
pending. If it fails to load, the page falls back to the current unstyled
white, which is the state before this card.

## Risks and alternatives

**Risk: `?raw` may come back empty under `css: false`.** The guard tests rest
on Vite's raw-asset handling being independent of its CSS pipeline. If
`import css from './index.css?raw'` yields an empty string when the suite runs,
the build agent should drop `styles.test.ts` entirely, note it in the build
log, and let the acceptance criteria above carry the coverage. Do not reach for
`test.css: true` to rescue it — see below.

**Risk: the shade may not be the pink someone pictured.** `pink` is the pale
`#FFC0CB`, not a saturated hot pink. This is the literal reading of a card that
names no shade, and revising it is a one-declaration change with no structural
consequence.

**Rejected: an inline `<style>` block in `app/index.html`.** Fewer files, but
it keeps the CSS outside the Vite pipeline, so it is neither hashed nor
cache-controlled with the rest of `/assets/`, and there is no module a test can
import.

**Rejected: setting `document.body.style.backgroundColor` from a React
effect.** This is the one option that *is* directly assertable in jsdom with no
config work, which is precisely its trap. It puts page chrome into component
lifecycle, and the page flashes white until React mounts.

**Rejected: turning on `test.css: true` in `app/vite.config.ts` and asserting
the computed style.** It changes test configuration for the whole suite to
serve one card, adds CSS processing to every test run, and jsdom's handling of
the cascade between UA and author styles on `body` is not dependable enough to
hang a test on.

**Rejected: a design-token layer (`--color-background` and friends).** There is
one consumer and one colour. A token indirection here is structure with no
second caller to justify it; the card that adds a second surface is the one
that should introduce it.

## Acceptance criteria

#### The page background is pink when the app loads

1. Open the app.
2. Look at the area surrounding the heading "Dark Factory Playground".
3. It is pink.

#### The pink fills the whole window, not just the strip behind the text

1. Open the app.
2. Look at the bottom of the window, well below the line reading "Hello, world".
3. Drag the bottom edge of the browser window down to make the window taller.
4. The area below the text is pink all the way to the bottom edge, with no white band.

#### The heading and greeting still read as before, in dark text on the pink

1. Open the app.
2. Read the heading. It reads "Dark Factory Playground".
3. Read the line beneath it. It reads "Hello, world".
4. Both lines are in dark, near-black text and are comfortably legible against the pink.

#### The background stays pink on reload and in dark mode

1. Reload the page. The background is still pink.
2. Switch your system appearance to dark.
3. Reload the page again.
4. The background is still pink and the text is still dark.

## Test strategy

The background colour itself cannot be asserted in the existing suite:
`app/vite.config.ts:12` sets `test.css: false`, so stylesheet rules are never
applied to the jsdom document and `getComputedStyle` reports the UA default
whatever `index.css` says. The visual result is therefore covered by the
acceptance criteria above, and the automated tests guard the two ways it can
silently regress — the rule being edited away, and the stylesheet being
orphaned.

**`app/src/styles.test.ts` — unit, two cases.** Both read the source as text
via `import css from './index.css?raw'` and `import entry from './main.tsx?raw'`,
which go through Vite's raw-asset handling rather than its CSS pipeline and so
are unaffected by `css: false`.

1. *The stylesheet paints the page pink.* Asserts `index.css` declares
   `background-color: pink` and an explicit `color` on `body`, and
   `color-scheme: light` on `:root`. This is the rule a future refactor is most
   likely to drop; asserting the foreground alongside the background is what
   stops the contrast pairing being half-removed.
2. *The entry module loads the stylesheet.* Asserts `main.tsx` imports
   `./index.css`. Deliberately a source-text assertion: it is the only thing
   that catches a stylesheet that still exists and still says `pink` but is no
   longer in the module graph, which is a regression the first test cannot see.

**`app/src/App.test.tsx` — component, unchanged.** No new assertions. It stays
as the regression guard that introducing global styles did not disturb the
rendered output: the heading and `"Hello, world"` must still be found.

**No new test for `Hello` or `useGreeting`.** Neither is touched by this card,
and `app/src/components/Hello.test.tsx` already covers them.
