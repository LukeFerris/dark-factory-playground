# DF-17: Show how many deals are in each pipeline column

## Context

DF-17 asks for each pipeline column to show how many deals it holds,
so someone scanning the board can see where deals are piling up without
counting cards. The card is also a test card for the new job graph (ADR 0008),
so a small, well-pinned change is the right size.

The behaviour the card describes is already in the app: it shipped with the
original board (DF-8, whose design lists "per-stage columns and counts" as
derived state). What is missing is a test that proves the count keeps up when
deals are added, moved or passed on. This design therefore changes no
behaviour and adds only the tests that pin the card's criteria.

## Current state

Read from the code at `1ec9f4d`:

- `app/src/components/PipelineBoard.tsx` renders one `<section>` per entry in
  `STAGES` (`app/src/crm/types.ts`), labelled with the stage name. Each has an
  `<h2 className="column__title">` holding the stage name and
  `<span className="column__count">{stageDeals.length}</span>`, where
  `stageDeals` is `deals.filter((deal) => deal.stage === stage)`, computed on
  every render. An empty column renders the count `0` and the text "No deals".
- `app/src/index.css` styles `.column__title` as a flex row with the name left
  and the count right, and `.column__count` as a muted pill.
- `app/src/crm/useDeals.ts` owns the deal list in React state;
  `addDeal`, `moveDeal` and `updateDeal` all replace it with `setDeals`, so the
  board — and therefore every count — re-renders on each change. Drag and drop
  and the "Stage" picker both go through the same `onMove`.
- Tests: `app/src/components/PipelineBoard.test.tsx` ("renders the six stages
  in order with their counts") asserts each heading's text, e.g.
  `'Sourcing2'`, `'Screening0'`, for a static deal list. `app/src/App.test.tsx`
  exercises add, move, pass and drag end to end but asserts only where cards
  land and the summary line — never a column count. So criterion 2 ("updates
  straight away") holds today but nothing would catch it regressing.

Nothing surprising, except that the card's feature predates the card.

## Proposed approach

No change to application code, markup or styling. The build stage adds
App-level tests that read the column counts before and after each kind of
change, using the seeded board (one deal in each of the six columns on a first
visit).

To read a count without depending on the heading's concatenated text, the
tests find the column by its region name and read the heading inside it, e.g.
`within(screen.getByRole('region', { name: 'Sourcing' })).getByRole('heading',
{ level: 2 })` and assert `toHaveTextContent('Sourcing1')` — matching the
idiom the existing board test already uses. A small `count(stage)` helper in
`App.test.tsx` beside the existing `column(stage)` helper is fine; no shared
test utility is needed.

## Components affected

- `app/src/App.test.tsx` — new tests asserting column counts after add, move
  via the "Stage" picker, pass, and drag and drop (see Test strategy).
- `app/src/components/PipelineBoard.test.tsx` — one new test that a rerender
  with a changed deal list changes the counts (component-level guard).
- No other file changes. `PipelineBoard.tsx`, `index.css` and `useDeals.ts`
  are untouched.

## State and data flow

The change adds no state. The count is derived on every render from the
`deals` array that `useDeals` owns and `App` passes to `PipelineBoard`; it is
never stored, so it cannot drift from the cards shown.

## Accessibility and UX notes

Unchanged from today. The count sits inside each column's level-2 heading, so a
screen reader reaching the heading hears the stage name followed by the
number (e.g. "Sourcing 2"). The live region in `App` already announces each
add, move and save; the count is not announced separately, which is
deliberate — the announcement already says which column the deal went to. The
count pill uses the existing muted colour on the border colour, as it has
since DF-8; this card does not revisit its contrast.

## Risks and alternatives

- **Risk: the reviewer expected a visible change.** The board will look
  identical before and after this card. That is correct — the feature exists —
  but it is called out in the card comment so nobody hunts for a difference.
- **Rejected: adding visually hidden "deals" text after the number** so a
  screen reader says "Sourcing, 2 deals". A reasonable improvement, but not
  asked for; it would change every heading's accessible name and the existing
  board test. Better as its own card if wanted.
- **Rejected: rebuilding the count as its own component.** Nothing to gain for
  one `span`; it would be churn with no behaviour change.
- **Rejected: closing the card with no diff at all.** Criterion 2 is currently
  untested, so a regression could remove the live update unnoticed; the tests
  are the smallest change that makes the criteria stick.

## Acceptance criteria

#### Every pipeline column header shows the number of deals in that column

1. Open the app on a first visit (or after clearing the site's saved data).
2. Look at the header of each of the six columns: "Sourcing", "Screening",
   "Due diligence", "Investment committee", "Closed", "Passed".
3. Each header shows the number 1 at its right-hand end, matching the one card
   in each column.

#### The count updates straight away when a deal is added

1. Note the number in the "Sourcing" header.
2. Type "Acme Logistics" into the field labelled "Company".
3. Press "Add deal".
4. Without reloading, the "Sourcing" header's number has gone up by one.

#### The count updates straight away when a deal is moved

1. On the "Harbour Dental Group" card in "Screening", change "Stage" to "Due
   diligence".
2. Without reloading, the "Screening" header's number has gone down by one and
   the "Due diligence" header's number has gone up by one.

#### The count updates straight away when a deal is dragged to another column

1. Drag the "Brightline Packaging" card from "Due diligence" and drop it on the
   "Investment committee" column.
2. The "Due diligence" header's number has gone down by one and the
   "Investment committee" header's number has gone up by one.

#### The count updates straight away when a deal is passed on

1. On the "Kestrel Energy Services" card, change "Stage" to "Passed".
2. The "Investment committee" header's number has gone down by one and the
   "Passed" header's number has gone up by one.

#### An empty column shows 0

1. Move every card out of "Screening" (for example, change "Harbour Dental
   Group"'s "Stage" to "Passed").
2. The "Screening" column reads "No deals" and its header shows 0.

## Test strategy

All tests start from the seeded board (`localStorage` cleared, as the existing
`App.test.tsx` `beforeEach` already does), where every column holds one deal.

App level (`app/src/App.test.tsx`), integration through `useDeals`:

- **Counts on first render:** every one of the six column headings shows 1.
- **Add:** after adding "Acme Logistics" through the form, the "Sourcing"
  heading shows 2 and no other count changed.
- **Move via the picker:** after changing "Harbour Dental Group" to "Due
  diligence", "Screening" shows 0 and "Due diligence" shows 2.
- **Pass on:** after changing "Kestrel Energy Services" to "Passed",
  "Investment committee" shows 0 and "Passed" shows 2.
- **Drag and drop:** after dragging "Harbour Dental Group" onto "Passed"
  (same `fireEvent` pattern and `dataTransfer` stub as the existing drag test),
  "Screening" shows 0 and "Passed" shows 2.
- **Empty column:** in the move or drag test, the emptied "Screening" column
  shows both "No deals" and a count of 0.

Component level (`app/src/components/PipelineBoard.test.tsx`):

- **Counts follow the props:** render with the existing three-deal fixture,
  then `rerender` with "Beta Health" moved to "Screening"; the "Sourcing"
  heading now reads `Sourcing1` and "Screening" reads `Screening1`.

The existing "renders the six stages in order with their counts" test stays as
it is.
