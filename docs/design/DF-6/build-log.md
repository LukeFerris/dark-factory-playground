# DF-6 — build log

## Turn 1

### What changed

Built the design as written, with one deviation in the test (below).

| File | Change |
| --- | --- |
| `app/src/index.css` | **New.** `color-scheme: light` on `:root`; `background-color: pink` and `color: #1a1a1a` on `body`. Exactly the three declarations from the design. |
| `app/src/main.tsx` | One line added: `import './index.css'` as the first import, above the React imports. |
| `app/src/vite-env.d.ts` | **New.** `/// <reference types="vite/client" />`, for the `?raw` module declaration. |
| `app/src/styles.test.ts` | **New.** The two guard tests from the design's test strategy. |
| `app/package.json` | `@types/node` added to `devDependencies` (see below). |

`app/index.html`, `app/vite.config.ts`, `app/tsconfig.json` and `app/src/App.test.tsx`
are untouched, as the design intended.

### Deviation: the stylesheet guard reads from disk, not via `?raw`

The design flagged this as a risk and it landed: under `test.css: false`,
Vitest stubs `./index.css?raw` to an **empty string**, so the first guard test
failed with `expected '' to match /background-color: pink/`. The stub applies
to the CSS pipeline only — `./main.tsx?raw` returns real source, so the second
guard test was unaffected and passed.

The design's contingency was to drop `styles.test.ts` entirely and let the
browser criteria carry the coverage. I kept the test instead, reading
`index.css` with `readFileSync` from the Vitest root. It meets the same stated
goal — read the source as text — costs no config change, and keeps the guard on
the one rule this card exists to add. `test.css: true` was **not** touched, as
the design directed.

That import of `node:fs` and `node:process` is why `@types/node` is now declared
in `app/package.json`. It was already resolving from the hoisted root as a
transitive dependency, so this only makes an existing dependency honest; it is
types-only, with no runtime weight. **The pipeline needs to regenerate
`package-lock.json`** — `npm install` is not available to the build agent.

A reviewer who would rather not have a filesystem read in a unit test can delete
`styles.test.ts`; nothing else depends on it.

### Tests

Written before the implementation and seen red first: the initial run failed on
the missing `index.css`. After implementing, both guards were re-checked by
mutation — `background-color: pink` changed to `white` and the
`import './index.css'` line removed — and both went red for the right reasons
before being reverted.

### What was run

| Command | Result |
| --- | --- |
| `npm run lint` | Pass, both workspaces, no warnings. The triple-slash reference in `vite-env.d.ts` does not trip `@typescript-eslint/triple-slash-reference`. |
| `npm run typecheck` | Pass, both workspaces. |
| `npm test` | Pass. App: 3 files, 5 tests. Factory: 9 files, 171 tests. |
| `npm run build` | Pass. Emits `dist/assets/index-CTenadtx.css` (0.07 kB) alongside the JS. |
| `npm run preview` + `curl` | `GET /` returns `index.html` with `<link rel="stylesheet" href="/assets/index-CTenadtx.css">` in `<head>`. `GET` that asset returns `:root{color-scheme:light}body{background-color:pink;color:#1a1a1a}`. |

`meta.json` has `preview_url: null` and `pr: null` on this turn, so the curl
checks went against the local `vite preview` server rather than a deployed
preview.

### Outstanding

Nothing in the card. One thing a reviewer should know: no browser was available
to this turn, so the served CSS was verified by `curl` rather than by looking at
a rendered page. The colour on screen is the reviewer's check.

The shade is the CSS named colour `pink` (`#FFC0CB`), the design's literal
reading of a card that names none. Changing it is one declaration in
`app/src/index.css` plus the matching string in `app/src/styles.test.ts`.
