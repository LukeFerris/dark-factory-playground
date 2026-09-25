# DF-5 — build log

## Turn 1

Built the design as written, with no deviations.

**Changed**

- `app/src/index.css` — **new.** The whole change: `body` becomes a grid
  container with `margin: 0`, `min-height: 100vh` then `min-height: 100dvh`, and
  `place-items: center`; `main` gets `padding: 1rem` and `text-align: center`.
  No colours, no fonts, no reset, no width.
- `app/src/main.tsx` — one line added, `import './index.css'` above the React
  imports. Nothing else in the file changed.
- `app/src/vite-env.d.ts` — **new.** `/// <reference types="vite/client" />`,
  so `tsc --noEmit` resolves the CSS import despite the restrictive `types`
  array in `app/tsconfig.json`. `app/tsconfig.json` was left alone.
- `app/src/App.test.tsx` — one new case, "keeps the heading and the greeting
  inside a single main landmark". The stylesheet selects `main` by element name,
  so this is what fails if a later card renames or unwraps that element. The two
  existing assertions are untouched.

`App.tsx`, `components/Hello.tsx` and `hooks/useGreeting.ts` are unchanged, as
the card asked. `app/index.html` is unchanged — Vite injects the stylesheet link
itself.

**Test written red first.** Before adding `index.css`, the new landmark case was
run against an `App.tsx` temporarily rewritten to use `<div>` instead of
`<main>`: it failed with "Unable to find an accessible element with the role
main". `App.tsx` was then reverted to its committed form and the case passes.

**What was run**

| Command | Result |
| --- | --- |
| `npm run lint` | passed, both workspaces, no warnings |
| `npm run typecheck` | passed, both workspaces — `vite-env.d.ts` did its job |
| `npm test` | passed — app 4 tests in 2 files, factory 171 tests in 9 files |
| `npm run build` | passed — emitted `dist/assets/index-DAqJ84Ra.css`, 0.12 kB |
| `npm run preview` + `curl` | served the page and the stylesheet, both 200 |

The design's two extra pre-flight checks were both done:

- `app/dist/index.html` contains
  `<link rel="stylesheet" crossorigin href="/assets/index-DAqJ84Ra.css">`.
- The served stylesheet is
  `body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center}main{padding:1rem;text-align:center}`
  — confirming esbuild's CSS minifier keeps *both* `min-height` declarations
  rather than collapsing the duplicate property, so the `100vh` fallback
  survives into production. That was the one risk in the design worth checking
  against the real build output.

**Outstanding**

- The six acceptance criteria are all browser observations, and this turn had no
  browser available: `meta.json` has `preview_url: null` (turn 1, before the PR
  exists) and the environment offers no headless browser. What was verified is
  the chain up to the pixels — the correct rules ship in the bundle and are
  served over HTTP with `Content-Type: text/css`. The centring itself is for the
  reviewer to confirm on the preview link, by the steps on the card.
- Nothing else is deferred. No dependency was added, no `.preview/env.yaml` is
  needed (the change has no configuration), and `package-lock.json` is unchanged.
