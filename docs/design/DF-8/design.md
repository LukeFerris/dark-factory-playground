# DF-8 — Replace hello world with a simple CRM for a PE fund

## Context

[DF-8](https://jira.local/browse/DF-8) asks for the placeholder "Hello, world"
page to go, and for the app to become "a simple but beautiful CRM system for a
PE fund". The card has no description and no acceptance criteria, so everything
below the title is interpretation.

The most common day-to-day CRM job in a private equity fund is tracking deal
flow: which companies are in the pipeline, what stage each one is at, how big
the cheque is, and who on the team owns it. This design treats that as the
card's intent: one screen where a deal team can see its pipeline at a glance,
add a new opportunity, and move a deal forward or mark it passed. "Simple"
limits scope to that screen; "beautiful" means a deliberate, calm visual design
instead of browser defaults and a flat blue page.

Scope questions were asked on the card; the reply was that this is a proof of
concept, not a production application, and the architect should pick whatever
keeps it simplest. The decisions taken on that basis: deal pipeline only (no
contacts or LP records); data saved in the browser, seeded with sample deals;
users can add deals and move them between stages, but not edit or delete them;
DF-7's blue page is replaced by a neutral palette and the app is called "Deal
Pipeline"; deal sizes are in pounds, in millions.

## Current state

Read in full: `app/index.html`, `app/src/main.tsx`, `app/src/App.tsx`,
`app/src/App.test.tsx`, `app/src/components/Hello.tsx`,
`app/src/components/Hello.test.tsx`, `app/src/hooks/useGreeting.ts`,
`app/src/index.css`, `app/src/index.css.test.ts`, `app/package.json`, and the
hosting sections of `docs/adr/0001-factory-architecture.md`.

- `app/src/App.tsx` renders `<main>` with an `<h1>` "Dark Factory Playground"
  and `<Hello name="world" />`. `Hello` renders a `<p>` with the string from
  `useGreeting`, which returns "Hello, <name>" and falls back to "world" when
  the name is blank. That is the whole application.
- `app/src/index.css` (from DF-7) sets `body` to background `#93c5fd` with
  black text. `app/src/index.css.test.ts` reads that file as text and asserts
  both declarations by regex, and also asserts that `main.tsx` imports it.
  **Changing the page colours will fail that test, so it has to change in the
  same diff.**
- `app/index.html` sets `<title>Dark Factory Playground</title>`.
- Dependencies are React 19 and react-dom only. Tests use Vitest, Testing
  Library (`react`, `user-event`, `jest-dom`) and jsdom. There is no router, no
  state library and no component library.
- **There is no backend.** The app is built into a container that serves static
  files through nginx (ADR 0001). Anything the CRM stores has to live in the
  browser unless a server is added, which this design does not do.

## Proposed approach

Delete the hello-world pieces and replace them with one screen: a **deal
pipeline**.

**The data.** A deal has:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Generated with `crypto.randomUUID()` |
| `company` | string | yes | Trimmed; blank is rejected |
| `sector` | string | no | Free text, e.g. "Healthcare" |
| `stage` | one of the stages below | yes | New deals start at "Sourcing" |
| `size` | number, in £m | no | Shown as "£45m" (decimals allowed, shown without trailing zeros, e.g. "£12.5m"); must be a positive number if given; a card with no size shows no size |
| `owner` | string | no | Free text name of the partner or associate |

Stages, in order: **Sourcing**, **Screening**, **Due diligence**,
**Investment committee**, **Closed**, **Passed**. "Passed" is a terminal stage
alongside "Closed", not a delete, so the record is kept.

**The screen**, top to bottom:

1. A header with the product name "Deal Pipeline" as the `<h1>` and a one-line
   summary: "<n> active deals · £<total>m in pipeline", where active means not
   Closed and not Passed, and the total sums `size` over active deals.
2. An "Add deal" form: fields "Company", "Sector", "Deal size (£m)", "Owner", and
   an "Add deal" button. On submit with a blank company it shows "Enter a
   company name" beneath that field and adds nothing. If "Deal size (£m)" is
   filled in but is not a number above 0, it shows "Enter a size above 0"
   beneath that field and adds nothing. On a successful add the
   form clears and focus returns to "Company".
3. The pipeline board: one column per stage, each headed by the stage name and
   a count. Each deal is a card showing company, sector, size and owner, plus a
   "Stage" select listing all six stages. Changing the select moves the card to
   that column. An empty column shows "No deals".

**Persistence.** Deals are kept in `localStorage` under the key
`df-crm.deals.v1`. On first load (key absent) the board is seeded with six
fictional sample deals, one in each stage, each with a sector, size and owner,
so it does not open empty. If the stored value cannot be
parsed, the app falls back to the seed data rather than crashing.

**Look.** Replace the DF-7 blue with a neutral light palette: off-white page
(`#f7f7f5`), white cards with a 1px `#e4e4e0` border and a small radius,
near-black text (`#1c1c1a`), and one accent (deep navy `#1e3a5f`) for the
button and focus rings. System font stack. The board scrolls horizontally on
narrow screens instead of squashing columns. All of it lives in `index.css`
with plain class names; no CSS framework.

**Why this shape.** A single board with a select per card is the smallest thing
that behaves like a pipeline CRM. Drag-and-drop was rejected (see Risks). No
router, because there is one screen. No new dependencies.

## Components affected

| File | Change |
| --- | --- |
| `app/src/components/Hello.tsx` | Deleted |
| `app/src/components/Hello.test.tsx` | Deleted |
| `app/src/hooks/useGreeting.ts` | Deleted (the `hooks/` directory is left empty and goes with it) |
| `app/src/crm/types.ts` | New. `Deal` type, `STAGES` constant, `Stage` type |
| `app/src/crm/seed.ts` | New. The six sample deals |
| `app/src/crm/useDeals.ts` | New. Hook owning the deals array: load from storage (seed on absent or corrupt), `addDeal`, `moveDeal`, save on change |
| `app/src/crm/useDeals.test.ts` | New |
| `app/src/components/PipelineSummary.tsx` | New. Header summary line, derived from deals |
| `app/src/components/AddDealForm.tsx` | New. The form and its validation |
| `app/src/components/AddDealForm.test.tsx` | New |
| `app/src/components/PipelineBoard.tsx` | New. Columns and deal cards with the stage select |
| `app/src/components/PipelineBoard.test.tsx` | New |
| `app/src/App.tsx` | Rewritten: header, form, board; calls `useDeals` |
| `app/src/App.test.tsx` | Rewritten for the new screen |
| `app/src/index.css` | Rewritten with the palette and layout above |
| `app/src/index.css.test.ts` | Updated: drop the blue assertions, assert the new body background and text colour; keep the import check |
| `app/index.html` | `<title>` becomes "Deal Pipeline" |

## State and data flow

- `useDeals` (called once, in `App`) owns the only state: `Deal[]`. It reads
  `localStorage` once in its initial-state function and writes the whole array
  back in an effect whenever it changes.
- `App` passes `deals` to `PipelineSummary` and `PipelineBoard`, `addDeal` to
  `AddDealForm`, and `moveDeal(id, stage)` to `PipelineBoard`.
- Derived, never stored: per-stage columns and counts, active-deal count,
  pipeline total.
- `AddDealForm` holds its own field values and error message as local state
  until submit; nothing crosses to `App` until a valid deal is submitted.

## Accessibility and UX notes

- Every form field has a visible `<label>`. Each field error (company and size) is linked with
  `aria-describedby` and the field gets `aria-invalid="true"`; the message sits
  in an element with `role="alert"` so it is announced.
- After a successful add, focus returns to "Company" and a polite live region
  announces "Added <company> to Sourcing".
- Each column is a `<section>` with an `<h2>` of the stage name and count, so
  screen-reader users can jump between stages by heading. Deal cards are
  `<article>`s headed by the company name (`<h3>`).
- Each card's stage select is labelled "Stage for <company>". Moving a deal
  announces "Moved <company> to <stage>" in the same live region. The moved card
  keeps focus on its select.
- Tab order: form fields, "Add deal", then each column's cards left to right,
  top to bottom.
- Contrast: body text `#1c1c1a` on `#f7f7f5` and white is above 15:1; white on
  the navy button is above 10:1. Focus rings are a 2px navy outline, never
  removed.
- There is no loading state: storage reads are synchronous.

## Risks and alternatives

- **Browser-only storage.** Data is per browser and per device, and is lost if
  site data is cleared. Acceptable for a playground; a shared, multi-user CRM
  needs a backend, which is a much larger card.
- **Drag-and-drop between columns** was rejected: it needs a library or a lot
  of hand-written keyboard support to be accessible, and a select does the same
  job for every user.
- **Contacts, companies and LP records** were left out to keep the card
  "simple"; they are natural follow-up cards.
- **Currency** is fixed to £m. A multi-currency field was rejected as scope.
- **Deleting DF-7's blue** reverses a merged card's decision; the CSS test that
  pins it has to change in the same diff or the build fails.

## Acceptance criteria

#### The hello-world greeting is gone

1. Look at the page.
2. The text "Hello, world" does not appear anywhere, and the main heading reads
   "Deal Pipeline".

#### A first visit shows a pipeline with sample deals

1. Open the app in a browser that has not visited it before (or a private
   window).
2. Six columns are shown, headed "Sourcing", "Screening", "Due diligence",
   "Investment committee", "Closed" and "Passed", and sample deals appear across
   them.

#### The summary counts active deals and totals their size

1. Read the line beneath "Deal Pipeline".
2. Count the deals outside the "Closed" and "Passed" columns and add up their
   sizes.
3. The line reads "<that count> active deals · £<that total>m in pipeline".

#### A new deal can be added and lands in Sourcing

1. Type "Acme Logistics" into "Company".
2. Type "Industrials" into "Sector", "45" into "Deal size (£m)" and "Sam Patel"
   into "Owner".
3. Press "Add deal".
4. A card for "Acme Logistics" showing "Industrials", "£45m" and "Sam Patel"
   appears in the "Sourcing" column, the form is empty again, and the summary's
   deal count has gone up by one and its total by 45.

#### A deal cannot be added without a company name

1. Leave "Company" empty and type "30" into "Deal size (£m)".
2. Press "Add deal".
3. The message "Enter a company name" appears beneath "Company" and no new card
   appears.

#### A deal cannot be added with a size of zero or less

1. Type "Zero Co" into "Company" and "0" into "Deal size (£m)".
2. Press "Add deal".
3. The message "Enter a size above 0" appears beneath "Deal size (£m)" and no
   card for "Zero Co" appears.

#### A deal can be moved to another stage

1. On the "Acme Logistics" card, change "Stage" to "Due diligence".
2. The card now appears in the "Due diligence" column and no longer in
   "Sourcing", and both column counts have changed by one.

#### Passing on a deal removes it from the active total

1. On the "Acme Logistics" card, change "Stage" to "Passed".
2. The card appears in the "Passed" column and the summary's deal count and
   total have both dropped accordingly.

#### Deals survive a reload

1. Add a deal named "Reload Test Ltd".
2. Reload the page.
3. "Reload Test Ltd" is still in the "Sourcing" column.

#### An empty stage says so

1. Move every deal out of the "Screening" column.
2. The "Screening" column shows "No deals" and a count of 0.

## Test strategy

- **`useDeals` (unit, hook):** seeds when storage is empty; loads stored deals
  when present; falls back to seed on unparseable storage; `addDeal` trims the
  company, sets stage "Sourcing" and a fresh id; `moveDeal` changes only the
  target deal's stage; every change is written back to storage.
- **`AddDealForm` (component):** blank and whitespace-only company shows "Enter a
  company name", marks the field invalid and does not call `addDeal`; a
  non-positive or non-numeric size shows "Enter a size above 0" and does not
  call `addDeal`; a blank size is allowed; a valid submit calls `addDeal`
  with the parsed values, clears the fields and returns focus to "Company".
- **`PipelineBoard` (component):** renders six stage headings in order with
  counts; places each deal under its stage; an empty stage shows "No deals";
  changing a card's "Stage for <company>" select calls `moveDeal` with that id
  and stage.
- **`App` (integration):** heading "Deal Pipeline" and no "Hello, world"; add a
  deal and see it under "Sourcing" with the summary updated; move it to
  "Passed" and see the active count and total drop; the live region announces
  the add and the move.
- **`index.css.test.ts` (source):** asserts the new body background and text
  colour declarations and that `main.tsx` still imports the stylesheet.
