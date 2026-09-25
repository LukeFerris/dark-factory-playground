# 2. Styling with a single global stylesheet

- **Status:** Accepted
- **Date:** 2026-09-25
- **Context:** DF-5, the first card that needs the app to look like anything

## Context

The app has carried no CSS since it was created: `app/index.html` has no
`<link rel="stylesheet">`, no component sets a `className` or a `style`, and the
rendered page is the user-agent stylesheet and nothing else. DF-5 — centre the
heading and greeting in the viewport — is the first card that cannot be done
without breaking that.

So the card carries a decision larger than itself. Whatever it introduces is the
convention the next card copies, and reversing it later means touching every
component written in between.

## Decisions

### Plain CSS, no framework and no CSS-in-JS

One `app/src/index.css`, imported once from `app/src/main.tsx`, using ordinary
element and class selectors.

Tailwind, styled-components, Emotion and the rest each cost a runtime or build
dependency, a configuration file, and an editing convention that has to be
learned before anyone can change a margin. A playground app with two components
does not earn that. Plain CSS is understood by everyone, has no version to keep
current, and Vite already handles it — the import is hashed, emitted to
`app/dist/assets/`, and linked from the built HTML with no configuration at all.
The existing `app/nginx.conf` serves that path as immutable already.

This is a decision to revisit when it starts to hurt, and the sign of that is
specific: selector collisions between components, or a stylesheet nobody dares
delete a rule from. Until then, adding a build step to avoid a problem we do not
have is the more expensive mistake.

### Global element selectors for page-level layout; component styles get a class

Rules that concern the page as a whole — the body's box, the centred column, a
future reset — are written against the element. Anything that belongs to one
component gets a class named for that component.

The distinction exists because global element rules are the only way to style
the page without editing component markup, and page-level layout is precisely
where that is worth having: DF-5 changes where the content sits without touching
`App.tsx`, `Hello.tsx` or `useGreeting.ts` at all. That property does not extend
to component styling, where an element selector would reach every other
component's markup too.

### The stylesheet is imported from `main.tsx`, not linked from `index.html`

Both work. The import keeps the stylesheet inside the module graph where the
rest of the app's dependencies live, which is what a reader of a Vite app
expects, and it means `index.html` stays a document rather than becoming a
second place where the build is configured.

The cost is a typecheck one. `app/tsconfig.json` narrows `types` to
`["vitest/globals", "@testing-library/jest-dom"]`, which leaves Vite's ambient
declarations out of the program and makes a bare CSS import fail `tsc --noEmit`.
The fix is `app/src/vite-env.d.ts` holding
`/// <reference types="vite/client" />` — the file Vite's own scaffold ships, and
a triple-slash reference resolves whatever the `types` array says.

## Consequences

**Good.** No new dependency, no new configuration, nothing to keep up to date.
Page-level styling can change without editing any component. The production path
needs no change: Vite emits the CSS, the Dockerfile copies `dist` wholesale, and
nginx already caches hashed assets correctly.

**Bad.** Global selectors have no isolation. A rule written against `main` or
`p` reaches every component that renders one, and nothing in the toolchain will
warn about it. Ordering in one file becomes load-bearing as it grows.

**Unverified by tests.** `app/vite.config.ts` sets `test.css: false`, so Vitest
stubs CSS imports and jsdom never applies them. No unit or component test can
assert a computed style, and a stylesheet can be broken without failing the
suite. Styling is therefore checked by eye on the PR preview, which is why DF-5
was scheduled as the first card through the preview launcher. If styling grows
enough to need automated checks, that means a browser-level test runner, and
that is a decision for its own ADR.
