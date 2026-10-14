# DF-15 — Add the target company's number of employees to an opportunity

## Context

[DF-15](https://jira.local/browse/DF-15) asks for "number of employees of the
target company" to be added to the fields on an opportunity. It has no
description and no acceptance criteria.

An opportunity is a deal on the board. Each deal records the target company's
name, sector, deal size and owner. The headcount is a basic way to tell how big
a target is, and today there is nowhere to put it. This card adds it in the
places the other details already live: the "New opportunity" form, the edit
form on each card, and the card itself.

Earlier cards on this app were told "this is a proof of concept; pick whatever
keeps it simplest" (DF-8, followed by DF-9, DF-11 and DF-14). This design does
the same. It treats the new field the way the existing optional number, deal
size, is treated.

## Current state

Read in full: `app/src/App.tsx`, `app/src/crm/types.ts`,
`app/src/crm/validateDeal.ts`, `app/src/crm/validateDeal.test.ts`,
`app/src/crm/useDeals.ts`, `app/src/crm/seed.ts`,
`app/src/components/AddDealForm.tsx`, `app/src/components/AddDealForm.test.tsx`,
`app/src/components/EditDealForm.tsx`, `app/src/components/PipelineBoard.tsx`,
`app/e2e/pipeline.spec.ts`, and the deal-card rules in `app/src/index.css`.
Searched, not read in full: `useDeals.test.ts`, `PipelineBoard.test.tsx`,
`EditDealForm.test.tsx` (for exact-object assertions).

- `Deal` (`app/src/crm/types.ts`) is `{ id, company, sector, stage, size?, owner }`.
  `size` is optional and in £m. `NewDeal` is `Deal` minus `id` and `stage`. It
  is what both forms hand over.
- `validateDeal` (`app/src/crm/validateDeal.ts`) is the one set of rules shared by
  both forms. It takes the raw strings (`DealFields`) and returns either a
  trimmed `NewDeal` or `DealErrors` (`company?`, `size?`). `parseSize` returns
  `undefined` for blank, `null` for invalid, or the number. Size errors read
  "Enter a size above 0".
- `AddDealForm` and `EditDealForm` each hold one `useState` string per field
  and call `validateDeal` on submit. On error they focus the company field if it
  is wrong, otherwise the size field. They do this with an `if/else`, which
  assumes size is the only other field that can be wrong. The add form's fields
  are Company, Sector, Deal size (£m) and Owner, in that order. The size field
  uses `className="field field--narrow"` and `inputMode="decimal"`. Each error
  is a `<p role="alert">` linked by `aria-describedby`, with `aria-invalid` on
  the input. The edit form namespaces its ids by deal (`edit-<id>-<field>`).
- `useDeals` stores the deal list in `localStorage` under `df-crm.deals.v1`.
  `addDeal` spreads the `NewDeal`. `updateDeal` builds
  `{ id, stage, ...changes }`, so every field the form hands over replaces the
  stored one. Saved data is not checked field by field when it is loaded.
- `DealCard` (private, in `app/src/components/PipelineBoard.tsx`) shows the
  company heading with the size beside it, then a sector line
  (`deal__sector`) and an owner line (`deal__owner`), each only if it is not
  empty. Both lines share muted 0.85rem styling in `index.css`.
- `SEED_DEALS` (`app/src/crm/seed.ts`) are six fictional deals shown on a first
  visit. `useDeals.test.ts` compares against `SEED_DEALS` by reference to the
  constant, so changing its values doesn't break those tests.
- `app/e2e/pipeline.spec.ts` is the reviewer walkthrough. Its header says each
  card replaces the previous card's walkthrough. It is currently DF-14's.

## Proposed approach

Add one optional field, `employees`, that goes through exactly the same path as
`size`.

1. **Data.** `Deal` gains `employees?: number` with the doc comment "Number of
   employees at the target company. Absent when not known." `NewDeal` picks it
   up automatically. Deals saved before this card don't have the field. That
   reads as "not known", so the storage key and loading stay unchanged.

2. **Rules (`validateDeal.ts`).**
   - `DealFields` gains `employees: string`. `DealErrors` gains `employees?: string`.
   - A new exported `parseEmployees(value): number | undefined | null`, alongside
     `parseSize`. It trims the value, then removes commas so "1,200" is
     accepted. Blank gives `undefined`. Otherwise the value must be a whole
     number of at least 1 (`Number.isInteger(n) && n >= 1`), or the result is
     `null`. So "0", "-3", "12.5", "abc" and "1e3" are rejected. "1e3" is an
     integer to `Number`, but people don't type headcounts that way, so it is
     rejected by first checking the value matches `/^\d+$/` after the commas
     are removed.
   - `validateDeal` sets `errors.employees = 'Enter a whole number above 0'`
     when `parseEmployees` returns `null`. It returns errors if any field has
     one, and otherwise includes `employees` in the returned deal.

3. **Forms.** Both forms get an "Employees" field between "Sector" and "Deal
   size (£m)", so the details about the company sit together and the details
   about the deal follow them. It is an input with `inputMode="numeric"`, in a
   `field field--narrow` wrapper in the add form, and with the same
   error markup as size (`role="alert"` paragraph, `aria-invalid`,
   `aria-describedby`). Its id is `deal-employees` in the add form and
   `edit-<id>-employees` in the edit form. The edit form pre-fills it with
   `String(deal.employees)`, or `''` if there is none. The add form clears it
   after a successful add, like the others.

   **Focus on error** follows the order of the fields on screen. The first of
   company, employees and size that has an error gets focus. That replaces the
   `if/else` in both forms with three refs checked in order.

4. **Card.** `DealCard` shows a line after the sector line when `employees` is
   set. It reads "1,200 employees", or "1 employee" for exactly one, with
   the number formatted by `toLocaleString('en-GB')`. A small
   `formatEmployees(n)` helper in `types.ts`, next to `formatSize`, produces
   that text. The line uses class `deal__employees` and shares the muted
   `deal__sector`/`deal__owner` style (add it to that selector list in
   `index.css`). Like the other detail lines, it is hidden while the edit form
   is open. No line is shown when the number isn't known.

5. **Seed.** Each seed deal gets a fictional headcount, so a first-time visitor
   sees the field: Northwind Analytics 180, Harbour Dental Group 420,
   Brightline Packaging 950, Kestrel Energy Services 1300, Meridian Foods 2600,
   Atlas Freight Tech 75.

6. **Walkthrough.** `app/e2e/pipeline.spec.ts` is replaced with DF-15's
   walkthrough, following the file's existing pattern (one `uatStep` per
   flattened acceptance-criteria step, one test, one page). The header notes it
   replaced DF-14's walkthrough, whose checks remain covered by
   `App.test.tsx` and `index.html.test.ts`.

The pipeline summary ("N active deals · £Xm in pipeline") is unchanged.
Headcount is not totalled anywhere.

## Components affected

| File | Change |
| --- | --- |
| `app/src/crm/types.ts` | `Deal.employees?: number`; new `formatEmployees(n)` ("1 employee", "1,200 employees") |
| `app/src/crm/validateDeal.ts` | `DealFields.employees`, `DealErrors.employees`, new `parseEmployees`, `validateDeal` checks and returns it |
| `app/src/crm/validateDeal.test.ts` | Cases for `parseEmployees` and the new `validateDeal` behaviour (below); `valid` fixture gains `employees` |
| `app/src/crm/seed.ts` | Each seed deal gains the headcount listed above |
| `app/src/components/AddDealForm.tsx` | "Employees" field between Sector and Deal size, its state, ref, error markup, clearing; focus-first-error in field order |
| `app/src/components/AddDealForm.test.tsx` | New cases (below); existing exact-object assertions gain `employees` |
| `app/src/components/EditDealForm.tsx` | Same field, pre-filled from the deal; same focus-first-error change |
| `app/src/components/EditDealForm.test.tsx` | New cases (below); existing exact-object assertions gain `employees` |
| `app/src/components/PipelineBoard.tsx` | `DealCard` shows the employees line after the sector line when known |
| `app/src/components/PipelineBoard.test.tsx` | New card-display cases (below) |
| `app/src/index.css` | `.deal__employees` joins the `.deal__sector, .deal__owner` rule |
| `app/e2e/pipeline.spec.ts` | Replaced with DF-15's walkthrough |

Unchanged: `App.tsx`, `useDeals.ts`, `PipelineSummary.tsx`, the storage key, and
`package.json` (no new dependency).

## State and data flow

- **Stored value.** `employees` is a number on each `Deal` in `useDeals`'s
  list, saved to `localStorage` with the rest. Absent means not known.
- **Typed value.** Each form holds what is typed as a string in its own
  `useState`, as it does for size. `validateDeal` turns it into a number or an
  error on submit. Nothing is checked as you type.
- **Path.** Add: `AddDealForm` → `onAdd(NewDeal)` → `App.handleAdd` →
  `addDeal`. Edit: `EditDealForm` → `onSave(NewDeal)` → `DealCard` →
  `onUpdate` → `App.handleUpdate` → `updateDeal`. Neither `App` nor `useDeals`
  needs a change, because they pass `NewDeal` through whole.
- **Clearing on edit.** Blanking the field in the edit form and saving removes
  the headcount. `validateDeal` returns `employees: undefined`, and
  `updateDeal` spreads that over the stored deal.
- **Display text** ("1,200 employees") is derived on render, never stored.

## Accessibility and UX notes

- **Label.** The input has a visible `<label>` "Employees" linked by
  `htmlFor`, so a screen reader announces "Employees, edit text".
- **Keyboard and focus order.** Tab order follows the screen: Company, Sector,
  Employees, Deal size (£m), Owner, then the button. Nothing else is newly
  focusable.
- **Errors.** An invalid value shows "Enter a whole number above 0" beneath
  the field as a `role="alert"` paragraph, so it is announced. The input gets
  `aria-invalid="true"` and is described by the message. On submit, focus moves
  to the first field on screen with an error. Other fields keep what was typed.
- **Mobile.** `inputMode="numeric"` brings up a number pad. A plain text
  input is used rather than `type="number"`, so commas are allowed and there
  are no spinner arrows or scroll-wheel changes. This matches the size field.
- **Card.** The headcount line is plain text in the same muted style as sector
  and owner, which already passes contrast in this app. The word "employees"
  is on screen, so the number is never ambiguous to sighted or screen-reader
  users.
- **No loading state.** Everything is local and synchronous.

## Risks and alternatives

- **Exact-object test assertions.** Several existing tests assert the exact
  object a form hands over. `toHaveBeenCalledWith`/`toEqual` ignore
  `undefined` properties, so most keep passing. The build stage should still
  add `employees` to them so they describe the new shape.
- **Focus-on-error logic.** The current `if/else` would send focus to the size
  field when only employees is wrong. The ordered check fixes that, and tests
  cover each field being the first error.
- **Old saved data.** Deals saved before this card have no `employees`. They
  show no line and an empty field when edited. Nothing breaks, and no
  migration is needed.
- **Rejected: a required field.** Earlier deals and quick adds often won't know
  the headcount, and making it required would make every saved deal invalid to
  edit until it is filled in.
- **Rejected: size bands ("1–10", "11–50", …) in a dropdown.** That is a
  common CRM pattern, but the card says "number of employees". A dropdown is
  also more structure than one number.
- **Rejected: `type="number"`.** It rejects commas in some browsers, adds
  spinners, and changes the value on scroll. It would also differ from the size
  field.
- **Rejected: totalling headcount in the summary.** Nobody asked for it, and a
  total headcount across targets means little.
- **Rejected: leaving the seed alone.** A first-time visitor would then see
  the field only in the forms, and a reviewer couldn't see the card display
  without adding a deal first.

## Acceptance criteria

The steps follow on from each other on the seeded board, starting from a first
visit.

#### Each sample deal shows its company's number of employees

1. Look at the "Northwind Analytics" card in the "Sourcing" column.
2. Beneath "Software" it reads "180 employees".
3. Look at the "Kestrel Energy Services" card in "Investment committee".
4. It reads "1,300 employees".

#### A new opportunity can be added with a number of employees

1. In "New opportunity", type "Acme Logistics" into "Company".
2. Type "1,200" into "Employees".
3. Press "Add deal".
4. A new "Acme Logistics" card appears in "Sourcing" reading "1,200 employees", and the "Employees" field in "New opportunity" is empty again.

#### A new opportunity can be added without a number of employees

1. Type "Quiet Co" into "Company" and leave "Employees" empty.
2. Press "Add deal".
3. A "Quiet Co" card appears in "Sourcing" with no line mentioning employees.

#### A number of employees that isn't a whole number above 0 is refused

1. Type "Bad Count Ltd" into "Company" and "0" into "Employees".
2. Press "Add deal".
3. "Enter a whole number above 0" appears beneath "Employees", the cursor is in "Employees", and no "Bad Count Ltd" card appears.
4. Replace "0" with "12.5" and press "Add deal".
5. The same message is still shown and no "Bad Count Ltd" card appears.
6. Replace "12.5" with "40" and press "Add deal".
7. The message disappears and a "Bad Count Ltd" card reading "40 employees" appears in "Sourcing".

#### A single employee reads "1 employee"

1. Type "Solo Ventures" into "Company" and "1" into "Employees".
2. Press "Add deal".
3. The "Solo Ventures" card reads "1 employee", not "1 employees".

#### The number of employees can be changed or removed when editing a deal

1. On the "Northwind Analytics" card, press "Edit".
2. The "Employees" field shows "180".
3. Replace it with "210" and press "Save".
4. The card reads "210 employees".
5. Press "Edit" again, clear "Employees", and press "Save".
6. The card no longer has a line mentioning employees.

#### Numbers of employees survive a reload

1. Reload the page.
2. "Acme Logistics" still reads "1,200 employees", "Kestrel Energy Services" still reads "1,300 employees", and "Northwind Analytics" still has no line mentioning employees.

## Test strategy

- **`validateDeal.ts` (unit):**
  - `parseEmployees`: blank and spaces give `undefined`; "250", " 250 " and
    "1,200" give 250, 250 and 1200; "0", "-3", "12.5", "abc" and "1e3" give
    `null`.
  - `validateDeal` returns `employees` as a number in the deal, `undefined`
    when blank, and `{ errors: { employees: 'Enter a whole number above 0' } }`
    for an invalid value. It reports company, size and employees errors
    together when all three are wrong.
- **`types.ts` (unit):** `formatEmployees(1)` is "1 employee",
  `formatEmployees(75)` is "75 employees", and `formatEmployees(1300)` is
  "1,300 employees".
- **`AddDealForm` (component):**
  - submitting with "1,200" in "Employees" calls `onAdd` with `employees: 1200`
    and clears the field;
  - a blank "Employees" calls `onAdd` with `employees: undefined`;
  - "0", "12.5" and "abc" show the alert "Enter a whole number above 0", set
    `aria-invalid` and the accessible description on "Employees", focus it, and
    don't call `onAdd`;
  - with a valid company and both employees and size invalid, focus goes to
    "Employees" (first on screen); with company also invalid, focus goes to
    "Company";
  - the labels in tab order are Company, Sector, Employees, Deal size (£m),
    Owner.
- **`EditDealForm` (component):** pre-fills "Employees" from the deal, or
  leaves it empty when the deal has none; saving a changed value calls `onSave`
  with the number; saving a cleared field calls `onSave` with
  `employees: undefined`; an invalid value shows the alert and focuses the field.
- **`PipelineBoard` (component):** a deal with `employees: 1300` shows "1,300
  employees" on its card; a deal without `employees` shows no text matching
  /employee/; the line is hidden while that card's edit form is open.
- **Existing tests** pass. Their exact-object assertions are updated to include
  `employees`, and the add-form "clears the fields" case includes "Employees"
  in its list of labels.
- **Walkthrough (`app/e2e/pipeline.spec.ts`, end to end):** replaced by DF-15's
  walkthrough. It has one `uatStep` per flattened acceptance-criteria step
  above, in order, on one page, finishing with `page.reload()` for the last
  criterion. The header comment says it is DF-15's walkthrough and that it
  replaced DF-14's.
