# DF-14 — Name the app "Deal CRM" and show it in the header with an icon

## Context

[DF-14](https://jira.local/browse/DF-14) asks for the app to be called "Deal
CRM", with that name in the header next to an icon. It has no description and no
acceptance criteria.

Today the app calls itself "Deal Pipeline", which is the name of the board
rather than the product. This card renames it everywhere a person sees the name,
which is the page heading and the browser tab, and adds a small icon so the
header reads as a product mark rather than a plain heading.

Earlier cards on this app were told "this is a proof of concept; pick whatever
keeps it simplest" (DF-8, followed by DF-9 and DF-11). This design does the same.
The card doesn't say which icon to use, so this design picks one (a briefcase,
see below).

## Current state

Read in full: `app/src/App.tsx`, `app/src/App.test.tsx`, `app/index.html`,
`app/src/index.css`, `app/src/index.css.test.ts`,
`app/src/components/PipelineSummary.tsx`, `app/package.json`,
`app/e2e/pipeline.spec.ts`, `app/e2e/uat.ts`, and `docs/design/DF-11/design.md`.

- `App` (`app/src/App.tsx`) renders `<header className="app__header">` holding
  `<h1>Deal Pipeline</h1>` and, beneath it, `PipelineSummary` ("4 active deals ·
  £210m in pipeline" on the seeded board).
- `app/index.html` sets `<title>Deal Pipeline</title>`. There is no favicon and
  no `public/` directory.
- `app/src/index.css` styles `.app__header h1`: 2rem, weight 650, accent colour
  `--accent` (#1e3a5f). The h1 is a plain block. Nothing in the header is laid
  out side by side.
- There are no icons anywhere in the app and no icon dependency. The only
  runtime dependencies are `react` and `react-dom`.
- "Deal Pipeline" appears in code in four places: the h1, the `<title>`, the
  first `App.test.tsx` case (`getByRole('heading', { level: 1, name: 'Deal
Pipeline' })`), and twice in `app/e2e/pipeline.spec.ts` (DF-11 walkthrough
  steps 3 and 20).
- `index.css.test.ts` reads source files as text with `readFileSync`, because
  jsdom does not load `index.html` or apply the stylesheet. That is the
  existing pattern for asserting something a component test can't see.
- `app/e2e/pipeline.spec.ts` is the reviewer walkthrough. Its header says each
  card replaces the previous card's walkthrough, numbered to match the
  flattened acceptance-criteria steps.

## Proposed approach

1. **Rename.** The h1 text becomes "Deal CRM" and the `<title>` in
   `app/index.html` becomes "Deal CRM". Nothing else is renamed: the board's
   column names, the summary line, the storage key (`df-crm.deals.v1`) and the
   package name stay as they are.

2. **Icon.** An inline SVG briefcase, written directly in `App.tsx` inside the
   h1, before the text:

   ```tsx
   <h1 className="app__title">
     <svg
       className="app__icon"
       viewBox="0 0 24 24"
       aria-hidden="true"
       focusable="false"
       fill="none"
       stroke="currentColor"
       strokeWidth="2"
       strokeLinecap="round"
       strokeLinejoin="round"
     >
       <rect x="3" y="7" width="18" height="13" rx="2" />
       <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
       <path d="M3 13h18" />
     </svg>
     Deal CRM
   </h1>
   ```

   The SVG uses `currentColor`, so it takes the heading's accent colour and
   needs no colour of its own. It is decorative: `aria-hidden="true"` keeps it
   out of the heading's accessible name, which stays exactly "Deal CRM".
   `focusable="false"` keeps old Edge/IE from putting it in the tab order. It
   is harmless elsewhere.

   Why a briefcase: it reads as "deals and business" at a glance and draws
   cleanly in three strokes. Why inline rather than a component file or an
   icon library: the app needs one icon, used once. A library adds a
   dependency for one glyph. A separate component file is structure nothing
   else uses yet. If a second icon arrives, that is the point to extract one.

3. **Layout.** `.app__header h1` becomes `display: flex; align-items: center;
gap: 10px;` and `.app__icon` is `width: 1em; height: 1em; flex: none;`. The
   icon then sizes with the heading's 2rem font (32px) and sits on the same
   line, to the left of the name. The existing h1 rules (size, weight, colour,
   margin) are unchanged. The `app__title` class is only a hook for the test
   and future styling. The CSS keeps using the existing `.app__header h1`
   selector.

4. **Walkthrough.** `app/e2e/pipeline.spec.ts` is replaced with DF-14's
   walkthrough, following the file's existing pattern. The old walkthrough
   checked for "Deal Pipeline" and would fail after the rename anyway.
   Dragging stays covered by the unit tests. The file keeps its name.

## Components affected

| File                               | Change                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/src/App.tsx`                  | h1 text becomes "Deal CRM", gains `className="app__title"`, and holds the inline briefcase SVG (decorative, `aria-hidden`) before the text |
| `app/index.html`                   | `<title>` becomes "Deal CRM"                                                                                                               |
| `app/src/index.css`                | `.app__header h1` gains `display: flex; align-items: center; gap: 10px`; new `.app__icon { width: 1em; height: 1em; flex: none; }`         |
| `app/src/App.test.tsx`             | First case asserts the heading "Deal CRM", the decorative icon, and the absence of "Deal Pipeline" (below)                                 |
| `app/src/index.html.test.ts` (new) | Reads `app/index.html` as text and asserts the title is "Deal CRM", the same way `index.css.test.ts` reads the stylesheet                  |
| `app/e2e/pipeline.spec.ts`         | Replaced with DF-14's walkthrough, one `uatStep` per flattened step below                                                                  |

Unchanged: every component under `app/src/components/`, everything under
`app/src/crm/`, `package.json` (no new dependency), the stored data and its
key.

## State and data flow

No state is added. The name and the icon are static markup. Nothing is stored,
derived or passed between components.

## Accessibility and UX notes

- **Screen readers** announce the heading as "Deal CRM, heading level 1". The
  icon is `aria-hidden`, so it isn't read out and adds nothing to the name.
- **Keyboard.** Nothing new is focusable. Tab order is unchanged.
- **Contrast.** The icon is drawn in the heading's accent (#1e3a5f) on the page
  background (#f7f7f5), above 10:1. That clears the 3:1 non-text rule, though
  it's decorative and doesn't have to.
- **Not colour-dependent.** The icon carries no meaning, so nothing is lost if
  it isn't seen.
- **Zoom and narrow windows.** The icon is sized in `em`, so it scales with the
  heading under browser zoom. At a 375px-wide window the name and icon fit on
  one line with room to spare (about 180px of 327px available).
- **No loading or error state.** The markup is static.

## Risks and alternatives

- **Old name lingering.** Missing one of the four "Deal Pipeline" occurrences
  would leave the old name showing or a test failing. The component test asserts
  "Deal Pipeline" isn't on the page, the `index.html` test pins the title, and
  the walkthrough is replaced as a whole.
- **Icon becoming part of the heading's name.** If the SVG lost `aria-hidden`,
  some screen readers would read an unlabelled graphic. Tests assert the
  attribute and the exact accessible name.
- **Rejected: an icon library** (e.g. a React icon package). It adds a
  dependency for a single glyph.
- **Rejected: an emoji (💼) as the icon.** It renders differently on every
  platform, can't take the accent colour, and screen readers read it out
  ("briefcase") unless it's wrapped, which is no simpler than an SVG.
- **Rejected: an image file in `public/`.** It needs a new directory and an
  extra request, and it can't inherit the heading colour.
- **Rejected: also adding a favicon.** The card asks for the icon in the
  header. A tab icon is a separate ask, and it's left out to keep this card
  small.
- **Rejected: renaming internals** (package name, storage key `df-crm.deals.v1`).
  Nobody sees these. Changing the storage key would also throw away everyone's
  saved deals.

## Acceptance criteria

The steps follow on from each other on the seeded board, starting from a first
visit.

#### The header shows the name "Deal CRM" with a briefcase icon beside it

1. Look at the heading at the top of the page.
2. It reads "Deal CRM", with a small briefcase icon immediately to its left on
   the same line, in the same dark navy as the text.

#### The summary line still sits beneath the name

1. Look at the line directly beneath "Deal CRM".
2. It reads "4 active deals · £210m in pipeline".

#### The browser tab is titled "Deal CRM"

1. Look at the title of the browser tab showing the app.
2. It reads "Deal CRM".

#### The old name "Deal Pipeline" appears nowhere on the page

1. Press Cmd-F (Ctrl-F on Windows) and search the page for "Deal Pipeline".
2. No match is found.

#### The name and icon stay together on one line in a narrow window

1. Narrow the browser window to about the width of a phone (around 375 pixels).
2. "Deal CRM" and the briefcase icon are still side by side on one line, and the
   icon is still to the left of the name.

## Test strategy

- **`App` (component/integration), replacing the first case in
  `App.test.tsx`:**
  - `getByRole('heading', { level: 1, name: 'Deal CRM' })` is present. This pins
    the exact accessible name, so it would fail if the icon leaked into it.
  - That heading contains an `svg` with `aria-hidden="true"` that comes before
    the text "Deal CRM".
  - `queryByText(/Deal Pipeline/)` is null, and the existing "Hello, world" and
    summary-line assertions stay.
- **`index.html` (unit, new `app/src/index.html.test.ts`):** reads
  `../index.html` as text and asserts it contains `<title>Deal CRM</title>` and
  not "Deal Pipeline". This follows the `readFileSync` pattern in
  `index.css.test.ts`, because jsdom never loads `index.html`.
- **Existing tests:** all other `App`, `PipelineBoard`, `AddDealForm`,
  `EditDealForm`, `useDeals` and `validateDeal` cases pass unchanged.
- **Walkthrough (`app/e2e/pipeline.spec.ts`, end to end):** replaced by DF-14's
  walkthrough. It has one `uatStep` per flattened acceptance-criteria step above
  (ten in total, in order, on one page):
  - steps 1–2: the level-1 heading has text "Deal CRM" and contains a visible
    `svg` whose bounding box is to the left of the text and vertically
    overlapping it;
  - steps 3–4: the summary text is "4 active deals · £210m in pipeline";
  - steps 5–6: `expect(page).toHaveTitle('Deal CRM')`;
  - steps 7–8: `page.getByText('Deal Pipeline')` has count 0;
  - steps 9–10: `page.setViewportSize({ width: 375, height: 800 })`, then the
    icon's box and the heading text's box are on the same line (their vertical
    ranges overlap), with the icon to the left.

  The header comment is updated to say it is DF-14's walkthrough and that it
  replaced DF-11's drag-and-drop walkthrough, which is still covered by the
  unit tests.
