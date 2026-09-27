# DF-7 — build log

## Turn 1

**What changed**

- `app/src/index.css` — **new.** One `body` rule: `background-color: #93c5fd`
  and `color: #000000`, with a comment recording why the selector is `body`
  (background propagation paints the whole canvas, so no white gutter) and why
  the two declarations travel together (one contrast decision, ~11.6:1).
- `app/src/main.tsx` — one line added, `import './index.css'` above the existing
  imports. Nothing else in the file moved.
- `app/src/index.css.test.ts` — **new.** Two tests, written before the code and
  seen failing first: one reads `index.css` from disk and asserts the `body`
  rule declares both colours, the other reads `main.tsx` and asserts the
  stylesheet is imported. They read source as text via `node:fs` because
  `test.css: false` and jsdom's lack of external-stylesheet cascade mean the
  rendered colour is not assertable here — as the design says.

No deviations from the design, and no new dependency. `@types/node` is already
hoisted to the repo root by the workspace, so `node:fs` typechecks from `app/`
untouched.

**What I ran**

- `npm run lint` — clean, both workspaces.
- `npm run typecheck` — clean, both workspaces.
- `npm test` — 211 passed across 14 files; the app workspace is 5 passed across
  3 files, including the two new ones. The existing `App` and `Hello` tests were
  not touched and still pass.
- `npm run build` — succeeds, and emits `dist/assets/index-<hash>.css`
  containing `body{background-color:#93c5fd;color:#000}`.
- `npm run preview` + `curl` — the served `index.html` carries
  `<link rel="stylesheet" ... href="/assets/index-<hash>.css">` in its head, and
  that URL returns the body rule. The stylesheet is wired through the build, not
  just present on disk.

**Outstanding**

- Nothing in the code. The visible outcome — blue to every edge, text still
  legible — has no automated cover in this project and no browser was available
  to this turn, so it needs the acceptance steps run against the preview by a
  human. `meta.json` had `preview_url: null` on this turn, so the curl above was
  against a locally served build of the same commit.
