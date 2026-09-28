# DF-9 — Edit existing deal cards

## Context

[DF-9](https://jira.local/browse/DF-9) says "the user should be able to edit
existing cards". There is no description and there are no acceptance criteria.

The cards are the deal cards on the Deal Pipeline board that DF-8 built. DF-8
chose to let people add deals and move them between stages, but not edit or
delete them. So a typo in a company name, a deal size that has changed, or a
new owner can't be fixed today. The only workaround is to add a second deal and
move the wrong one to "Passed". This card closes that gap. Someone can open a
deal, correct its details and save, or change their mind and cancel.

DF-8's scope questions got the answer "this is a proof of concept; pick
whatever keeps it simplest". This design follows the same rule.

## Current state

Read in full: `app/src/App.tsx`, `app/src/App.test.tsx`,
`app/src/components/PipelineBoard.tsx`, `app/src/components/PipelineBoard.test.tsx`,
`app/src/components/AddDealForm.tsx`, `app/src/components/AddDealForm.test.tsx`,
`app/src/crm/useDeals.ts`, `app/src/crm/types.ts`, `app/src/crm/seed.ts`,
`app/src/index.css`, and `docs/design/DF-8/design.md`.

- `useDeals` (`app/src/crm/useDeals.ts`) owns the only state, a `Deal[]`. It
  loads from `localStorage` key `df-crm.deals.v1` and writes the whole array
  back on every change. It exposes `addDeal` and `moveDeal`. Nothing updates a
  deal's other fields.
- `Deal` (`app/src/crm/types.ts`) is `{ id, company, sector, stage, size?, owner }`.
  `NewDeal` is `Omit<Deal, 'id' | 'stage'>`, which is exactly the set of fields
  a person would edit.
- `App` calls `useDeals`, passes `onAdd` to `AddDealForm` and `onMove` to
  `PipelineBoard`, and announces "Added …" and "Moved …" through one polite
  live region (`role="status"`).
- `PipelineBoard` renders a `DealCard` for each deal inside its stage column,
  keyed by `id`. `DealCard` is a private function in the same file. It is an
  `<article>` labelled by its `<h3>` company name. It shows size, sector and
  owner, then a "Stage" select whose accessible name is "Stage for <company>".
  The board refocuses a moved card's select after it re-mounts in its new
  column.
- `AddDealForm` holds its field values as strings in local state. The
  validation rules live inside the component: company must be non-blank, and
  size may be blank or else must be a number above 0 (`parseSize`, a private
  function). Errors are "Enter a company name" and "Enter a size above 0". Each
  error sits under its field with `role="alert"`, is linked by
  `aria-describedby`, and sets `aria-invalid`. After a failed submit, focus
  moves to the first invalid field. The field ids are fixed (`deal-company`
  and so on), so a second copy of this form on the page would clash.
- `index.css` has `.field`, `.field__error` and `.button` styles for the add
  form. `.button` carries `margin-top: 23px` so it lines up with the labelled
  inputs in a row. That margin is wrong for buttons inside a narrow card.

## Proposed approach

Edit happens **inside the card**. Each deal card gets an "Edit" button.
Pressing it swaps the card's details and stage select for a small form.
The company heading stays at the top of the card while the form is open. The
form has:

- the fields "Company", "Sector", "Deal size (£m)" and "Owner", filled in with
  the deal's current values (size shown as a plain number such as "12.5", or
  empty if the deal has no size);
- a "Save" button and a "Cancel" button.

Behaviour:

- **Save** checks the fields with exactly the same rules and messages as "Add
  deal". If a field is invalid, the error shows under that field, nothing is
  saved, the form stays open and focus moves to the first invalid field. If the
  fields are valid, the deal is updated in place and stays in its stage column.
  Company, sector and owner are trimmed. A blank size removes the size. The card
  goes back to its normal view with the new values, and the summary line
  updates. The change is saved to the browser like every other change, so it
  survives a reload.
- **Cancel**, or pressing Escape while focus is inside the form, closes the form
  and discards the edits. The card shows its old values.
- Stage is **not** in the edit form. The card's existing "Stage" select already
  changes it, and one control per job is simpler.
- Each card has its own open/closed state, so opening one card's form does not
  affect any other card.

**Sharing the validation.** Move `parseSize` and the two validation rules out
of `AddDealForm` into a new module, `app/src/crm/validateDeal.ts`, which exports:

- `parseSize(value: string): number | undefined | null` (unchanged behaviour);
- `validateDeal(fields: { company: string; sector: string; size: string; owner: string })`, which returns
  either `{ deal: NewDeal }` with trimmed values and the parsed size, or
  `{ errors: { company?: string; size?: string } }` with the same messages as
  today.

`AddDealForm` switches to `validateDeal` without any visible change. The new
form uses the same function, so the two forms can't drift apart.

**Why this shape.** Editing in the card keeps the person looking at the deal
they're changing, and needs no dialog, no router and no new dependency. The
alternatives are listed under Risks.

## Components affected

| File | Change |
| --- | --- |
| `app/src/crm/validateDeal.ts` | New. `parseSize` (moved from `AddDealForm`) and `validateDeal` returning a trimmed `NewDeal` or field errors |
| `app/src/crm/validateDeal.test.ts` | New. Unit tests for both functions |
| `app/src/components/AddDealForm.tsx` | Uses `validateDeal` instead of its private rules. No change in behaviour, markup or ids |
| `app/src/components/EditDealForm.tsx` | New. The in-card form: props `deal: Deal`, `onSave(changes: NewDeal)`, `onCancel()`. Holds field strings and errors locally. Field ids are namespaced by deal id (e.g. `edit-<id>-company`) so they never clash with the add form or another card |
| `app/src/components/EditDealForm.test.tsx` | New |
| `app/src/components/PipelineBoard.tsx` | New prop `onUpdate(id: string, changes: NewDeal)`. `DealCard` gains local `editing` state, an "Edit" button, and renders `EditDealForm` in place of details and stage select while editing. Manages focus on open and close |
| `app/src/components/PipelineBoard.test.tsx` | Extended: existing renders pass `onUpdate={vi.fn()}`; new cases below |
| `app/src/crm/useDeals.ts` | New `updateDeal(id, changes: NewDeal)`: replaces company (trimmed), sector, size and owner on the matching deal and keeps `id` and `stage` |
| `app/src/crm/useDeals.test.ts` | Extended with `updateDeal` cases |
| `app/src/App.tsx` | Wires `updateDeal` to the board through `handleUpdate`, which announces "Saved changes to <new company>" |
| `app/src/App.test.tsx` | New integration case for edit, save, cancel and reload |
| `app/src/index.css` | Styles for the "Edit" button, the in-card form (fields stacked vertically), and a secondary button style for "Cancel". `.button` inside the card drops the `23px` top margin |

No new dependencies. No change to the stored data's shape or storage key.

## State and data flow

- **Deal data** is still owned only by `useDeals`. `updateDeal` is a pure
  `map` over the array, like `moveDeal`. The existing effect saves the result to
  `localStorage`.
- **Whether a card is being edited** is local `useState<boolean>` in each
  `DealCard`. It is never lifted up and never saved, so a reload closes any open
  form. Cards are keyed by `id` and an edit never changes a deal's stage, so
  the card never re-mounts while it is being edited or saved.
- **Draft field values and errors** are local state in `EditDealForm`, filled
  from the `deal` prop when the form mounts. Nothing crosses to `App` until
  Save passes validation. Then `EditDealForm` calls `onSave(deal)` →
  `DealCard` calls `onUpdate(id, deal)` and closes the form → `App.handleUpdate`
  calls `updateDeal` and sets the announcement.
- **Derived, not stored:** the summary line and column counts recompute from
  `deals` as they do today, so a changed size updates the total without extra
  code.

## Accessibility and UX notes

- **Edit button.** It shows the word "Edit". Its accessible name is "Edit
  <company>", which is "Edit" plus a visually hidden company name, using the
  same pattern as the stage label. It sits after the stage select, so the tab
  order within a card is stage select, then Edit. It is a real `<button
  type="button">`.
- **Opening.** Focus moves to the "Company" field in that card's form. The
  form is a `<form>` with `aria-label="Edit <company>"` (the saved name), so a
  screen reader announces which deal is being edited. The card's `<h3>` stays,
  so the article keeps its name.
- **Labels.** Every field has a visible `<label>` with the same text as the add
  form: "Company", "Sector", "Deal size (£m)", "Owner". Ids are unique per card.
- **Errors.** Same treatment as the add form: message under the field in a
  `role="alert"` element, linked by `aria-describedby`, `aria-invalid="true"` on
  the field, and focus on the first invalid field.
- **Saving.** The form closes, focus returns to that card's "Edit" button (whose
  name now uses the new company name), and the live region announces "Saved
  changes to <company>".
- **Cancelling.** "Cancel" or Escape closes the form, focus returns to that
  card's "Edit" button, and nothing is announced.
- **Tab order while open:** Company, Sector, Deal size (£m), Owner, Save,
  Cancel. Enter in any field submits (Save), as in any HTML form.
- **Look.** The Edit button is a small, quiet text-style button in the accent
  colour with a visible focus ring. Cancel is a secondary button: white
  background, accent text, border in `--border`. Save uses the existing
  `.button`. All colours are existing tokens, so contrast is unchanged: accent
  on white is above 10:1.
- **No loading state.** Updates are synchronous.

## Risks and alternatives

- **Two "Company" fields on the page while a card is open.** The add form's
  fields and the edit form's fields share label text. Tests that use
  `getByLabelText('Company')` across the whole page would find two matches when
  a card is open. Existing tests never open a card. New tests must query inside
  the edit form (`within(getByRole('form', { name: 'Edit …' }))`). Minor.
- **A person opens several cards at once.** This is allowed, and each card is
  independent. Restricting it to one open card would mean lifting state to the
  board for no clear gain. Minor.
- **Refactoring `AddDealForm`'s validation** could change its behaviour. Its
  existing tests are the guard and must pass unchanged.
- **Rejected: reuse the top "New opportunity" form as an edit form.** Focus and
  attention would jump away from the card, and the form would need an
  add-versus-edit mode. That's more state and a worse flow.
- **Rejected: a modal dialog.** Accessible modals need focus trapping and
  return. `<dialog>` has uneven support in jsdom for tests. More work than
  an inline form for the same result.
- **Rejected: click-to-edit on each piece of text.** It is hard to make
  discoverable and keyboard-accessible, and it needs a save rule per field.
- **Rejected: stage in the edit form.** It would duplicate the stage select and
  raise the question of which one wins.

## Acceptance criteria

#### Every deal card has an Edit button

1. Look at any deal card on the board, for example "Northwind Analytics" in
   "Sourcing".
2. The card has a button reading "Edit" beneath its "Stage" picker.

#### Pressing Edit shows the deal's current details ready to change

1. On the "Northwind Analytics" card, press "Edit".
2. The card shows fields "Company", "Sector", "Deal size (£m)" and "Owner"
   containing "Northwind Analytics", "Software", "40" and "Priya Shah", plus
   "Save" and "Cancel" buttons, and the cursor is in "Company".

#### Saved changes appear on the card and in the summary

1. Note the summary line beneath "Deal Pipeline".
2. On the "Northwind Analytics" card, press "Edit".
3. Change "Company" to "Northwind Data", "Deal size (£m)" to "55" and "Owner"
   to "Sam Patel".
4. Press "Save".
5. The card, still in "Sourcing", reads "Northwind Data", "£55m", "Software"
   and "Sam Patel". The fields are gone and the summary's total has gone up
   by 15.

#### Cancel throws away the changes

1. On the "Harbour Dental Group" card, press "Edit".
2. Change "Company" to "Something Else".
3. Press "Cancel".
4. The card still reads "Harbour Dental Group" with its original details, and
   the fields are gone.

#### Escape also cancels

1. On the "Harbour Dental Group" card, press "Edit".
2. Change "Owner" to "Nobody".
3. Press Escape.
4. The card still shows "Tom Okafor" as the owner, and the fields are gone.

#### A deal cannot be saved without a company name

1. On the "Brightline Packaging" card, press "Edit".
2. Clear "Company".
3. Press "Save".
4. "Enter a company name" appears beneath "Company", the fields stay open,
   and the cursor is in "Company".

#### A deal cannot be saved with a size of zero or less

1. On the "Brightline Packaging" card, press "Edit".
2. Change "Deal size (£m)" to "0".
3. Press "Save".
4. "Enter a size above 0" appears beneath "Deal size (£m)" and the fields stay
   open.

#### Clearing the size removes it from the card

1. On the "Kestrel Energy Services" card, press "Edit".
2. Clear "Deal size (£m)".
3. Press "Save".
4. The card no longer shows a size, and the summary's total has dropped by 85.

#### Edits survive a reload

1. On the "Meridian Foods" card, press "Edit", change "Sector" to "Food &
   Drink" and press "Save".
2. Reload the page.
3. The "Meridian Foods" card in "Closed" reads "Food & Drink".

#### Editing works from the keyboard alone

1. Press Tab until the "Edit" button on the "Atlas Freight Tech" card is
   focused, then press Enter.
2. Type " Ltd" at the end of "Company", then press Enter.
3. The card reads "Atlas Freight Tech Ltd" and focus is on that card's "Edit"
   button.

## Test strategy

- **`validateDeal` (unit):** blank and whitespace-only company returns the
  company error; sizes "0", "-5" and "abc" return the size error; both errors
  can come back together; a blank size gives `size: undefined`; valid input
  returns trimmed company, sector and owner and a numeric size. `parseSize`
  keeps its current results for "", " 12.5 ", "0" and "abc".
- **`AddDealForm` (component):** the existing tests pass unchanged. They are
  the regression guard for the refactor.
- **`useDeals` (unit, hook):** `updateDeal` changes company (trimmed), sector,
  size and owner on only the target deal; it keeps that deal's `id` and
  `stage`; a `size` of `undefined` removes the size; the change is written to
  storage; an unknown id leaves the list unchanged.
- **`EditDealForm` (component):** fields are filled from the deal (a size of
  12.5 shows as "12.5"; no size shows empty); "Company" has focus on mount;
  blank company and invalid size show the right messages with `aria-invalid`
  and an accessible description, do not call `onSave`, and focus the first
  invalid field; a valid save calls `onSave` with the trimmed `NewDeal`;
  "Cancel" and Escape each call `onCancel` and not `onSave`; the form's
  accessible name is "Edit <company>".
- **`PipelineBoard` (component):** each card has a button named "Edit
  <company>"; pressing it shows that card's form and no other; saving calls
  `onUpdate` with the deal id and the changes and closes the form; cancelling
  closes the form without calling `onUpdate`; after save or cancel, focus is
  on that card's Edit button.
- **`App` (integration):** edit a seed deal's company and size, save, and see
  the new values in the same column, the summary total updated, and the live
  region reading "Saved changes to <new company>"; cancel an edit and see the
  old values; save an edit, unmount and re-render, and see the edit kept.
