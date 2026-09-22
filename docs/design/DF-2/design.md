# DF-2 — Greet the user with "Hi there" instead of "Hello"

Jira: **DF-2** — *Greet the user with "Hi there" instead of "Hello"*

## Context

Someone opening the playground app is greeted with "Hello, world". The card asks
for a warmer, more conversational opening word: the greeting should read "Hi
there" rather than "Hello".

The card gives no acceptance criteria, so the criteria below are derived from
the one sentence of description plus what the app actually does today. The point
of them is to pin down two things the sentence leaves open: that only the
salutation changes (the name part is untouched), and that the change applies to
every greeting the app can produce, not just the default one.

## Current state

Read in full; the greeting is three small files.

- `app/src/hooks/useGreeting.ts` owns the greeting text. It holds
  `const FALLBACK_NAME = 'world'`, trims the name it is given, and returns the
  single template string `` `Hello, ${trimmed === '' ? FALLBACK_NAME : trimmed}` ``.
  This is the only place the word "Hello" is produced as user-visible text.
- `app/src/components/Hello.tsx` calls `useGreeting(name)` and renders the result
  in a plain `<p>`. Its `HelloProps.name` doc comment says *Blank falls back to
  "world"*.
- `app/src/App.tsx` renders `<h1>Dark Factory Playground</h1>` and then
  `<Hello name="world" />`.

Two things about the current state are worth stating plainly, because they shape
what can and cannot be checked:

1. **There is no input field.** `App.tsx` hardcodes `name="world"`. The only
   greeting a person can see in a browser today is "Hello, world". The blank-name
   fallback in `useGreeting` is real code, but nothing in the UI can reach it — it
   is exercised only by `app/src/components/Hello.test.tsx`. DF-2 does not add an
   input, so this stays true.
2. **The component is named `Hello`.** The name is the component's, not the
   user's — it is an identifier, not on-screen text. The card is about what the
   page says.

Existing tests that assert the current wording, and so must be updated:
`app/src/components/Hello.test.tsx` (two cases: `'Hello, Ada'`, `'Hello, world'`)
and `app/src/App.test.tsx` (one case: `'Hello, world'`).

`PLAN.md` at the repository root also describes the app as rendering
"Hello, world". It is outside both the design and build stages' allowed paths, so
it will drift. Flagged here rather than fixed; a human can pick it up separately.

## Proposed approach

Change the salutation token in the one template string that produces it, in
`app/src/hooks/useGreeting.ts`:

```
`Hello, ${…}`   →   `Hi there, ${…}`
```

Everything after the comma is untouched: the trim, the `FALLBACK_NAME` of
`'world'`, the blank-name behaviour, the function signature, the component, the
markup. The app then renders "Hi there, world" by default, and would render
"Hi there, Ada" for `name="Ada"`.

This shape — editing the hook rather than the component or `App.tsx` — is chosen
because the hook is already the single owner of greeting text. Changing it there
means the wording is correct for every caller, present and future, and the diff
stays one line plus tests. Putting the new wording in `Hello.tsx` or `App.tsx`
would split greeting text across two files for no gain.

Filenames, the component name `Hello`, and the exported `HelloProps` interface
stay as they are. Renaming them would be a large diff over identifiers no user
sees, and would not make any acceptance criterion pass.

Two comments mention the old wording and should be kept accurate as part of the
same change:

- `useGreeting.ts`'s doc comment — the sentence about blank names falling back to
  "world" is still true and needs no edit, but check it reads correctly alongside
  the new string.
- `HelloProps.name`'s doc comment — likewise still accurate ("Blank falls back to
  \"world\""), so leave it.

No ADR. A change of salutation wording does not outlive this card and sets no
rule other cards follow.

## Components affected

| File | What happens to it |
| --- | --- |
| `app/src/hooks/useGreeting.ts` | The returned template string's prefix changes from `Hello, ` to `Hi there, `. Nothing else changes — same signature, same trim, same `FALLBACK_NAME`. |
| `app/src/components/Hello.test.tsx` | Both expectations updated: `'Hello, Ada'` → `'Hi there, Ada'`, `'Hello, world'` → `'Hi there, world'`. |
| `app/src/App.test.tsx` | The greeting expectation updated: `'Hello, world'` → `'Hi there, world'`. The heading assertion is unchanged. |
| `app/src/components/Hello.tsx` | Unchanged. Listed so the reviewer knows it was considered and deliberately left alone. |
| `app/src/App.tsx` | Unchanged. `name="world"` stays; DF-2 does not add an input. |

No new files.

## State and data flow

No state is added, removed, or moved. `useGreeting` is a pure function of its
`name` argument — it holds no `useState`, no effect, and no context, despite the
`use` prefix. The greeting is derived from the `name` prop on every render, and
`App.tsx` supplies that prop as a literal. The only thing crossing a boundary is
the `name` string from `App` to `Hello` to `useGreeting`, and that is unchanged.

## Accessibility and UX notes

The change is a text substitution inside an existing `<p>`; it adds no control,
no state, and no interaction, so most of this section is about what must *stay*
true rather than what becomes true.

- **Document structure is unchanged.** `<h1>Dark Factory Playground</h1>` remains
  the page's only heading and remains first in the reading order. The greeting
  stays a `<p>` in `<main>` — it must not be promoted to a heading, which would
  put a second, competing `h1`/`h2` in the outline.
- **Screen reader announcement.** A reader moving through `<main>` announces the
  heading, then the paragraph as "Hi there, world". There is no live region and
  none is needed: the text is static after load, so there is nothing to announce
  on change.
- **Keyboard and focus.** The page has no focusable controls before or after this
  change, so there is no focus order to preserve and nothing new to reach by Tab.
- **Colour contrast.** No colour, weight, or size changes; the greeting inherits
  the same styles it has today.
- **Error and loading states.** None apply. The greeting is computed
  synchronously from a prop with no fetch, no async boundary, and no failure mode.
  The nearest thing to an edge case is a blank name, which `useGreeting` already
  handles by substituting "world" — that behaviour is preserved exactly, so the
  greeting is never left as a dangling "Hi there, ".
- **Language.** `index.html` declares `lang="en"`; "Hi there" is English and needs
  no change there.

## Risks and alternatives

**Risks**

- *The word "Hello" survives somewhere on the page.* Low, since the hook is the
  only producer of that text, but it is the specific thing the card asks for — so
  a test asserting the new string, not merely asserting some greeting, is
  required.
- *Stale test expectations fail the build.* Three assertions across two files
  encode the old wording. They are listed above; missing one turns a one-line
  change into a red build.
- *Documentation drift.* `PLAN.md` will still say "Hello, world" and neither stage
  may edit it. Cosmetic and out of scope; called out so the reviewer is not
  surprised.

**Alternatives considered and rejected**

- *Make the whole greeting read "Hi there" with no name* (dropping the `, world`).
  Rejected: the card asks for "Hi there" **instead of "Hello"**, which identifies
  the salutation word being swapped, not the removal of the person being greeted.
  Dropping the name would also make `useGreeting`'s `name` argument and the
  blank-name fallback dead code — a much larger change than the card describes.
  This is the main thing a reviewer might want to reopen; see *Open questions*.
- *Change the fallback from "world" to "there", giving "Hi there, there"* or
  *"Hi, there"*. Rejected: the card says nothing about the fallback name, and the
  result reads worse than what is there now.
- *Rename `Hello.tsx` / the `Hello` component to match the new wording.* Rejected
  as scope creep: a rename across a component, its test, its interface and its
  importer, over identifiers no user sees, for no acceptance criterion.
- *Move the greeting text into a constants or i18n module.* Rejected: the app has
  one greeting and no localisation; introducing that structure for a one-word
  change is the kind of over-engineering this repository is meant to avoid.

## Test strategy

All three are component-level tests with React Testing Library, in the files that
already exist. No new test file.

1. **Greets the name it is given** (`app/src/components/Hello.test.tsx`, existing
   test, updated). Render `<Hello name="Ada" />`; assert the text
   "Hi there, Ada" is in the document. This is the assertion that proves the
   salutation changed while the name part did not.
2. **Falls back to "world" when the name is blank**
   (`app/src/components/Hello.test.tsx`, existing test, updated). Render
   `<Hello name="   " />`; assert "Hi there, world" is in the document. This
   covers the whitespace-only case and proves the trim and fallback survived the
   edit — the case no browser step can reach, since the app has no input.
3. **Renders the default greeting** (`app/src/App.test.tsx`, existing test,
   updated). Render `<App />`; assert the heading "Dark Factory Playground" is
   present and that "Hi there, world" is in the document. This is the
   integration-level check that what the page actually shows on load has changed.

Additionally, in test 3, assert that no element with the text "Hello, world"
remains — a cheap guard against the old string being left behind by a partial
edit. Do not add a broad "the word Hello appears nowhere" assertion: the
component is still named `Hello` and such a test would be brittle for no benefit.

## Open questions

None blocking; the design proceeds on the reading below, which is recorded as an
assumption on the card so a reviewer can overturn it in one comment.

- Should the greeting read **"Hi there, world"** (swap the salutation, keep the
  name) or simply **"Hi there"** (drop the name entirely)? This design takes the
  first, because "instead of \"Hello\"" names the word being replaced and the
  second would orphan the existing `name` prop and its blank-name fallback. If the
  reviewer wants the second, the change is still small but `useGreeting`,
  `HelloProps` and the blank-name test all become questionable, and the card
  should say so before the build stage starts.
