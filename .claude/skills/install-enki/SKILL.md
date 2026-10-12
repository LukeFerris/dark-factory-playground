---
name: install-enki
description: |
  **Install Enki on a Jira space**: asks the human for the keys it needs, in a
  `.env` file, then reads the space and shows them what is there, then plans
  the change with them, and makes every change itself through Jira's API, from
  a dry run they have approved. Works on company-managed and team-managed
  spaces. Trigger: "/install-enki", "set up Enki on our board", "install the
  dark factory on Jira", "connect Enki to project X".
---

# Install Enki on a Jira space

This skill is about the Jira side only: the space, its workflow, its board and
the Automation rules that wake Enki. The repository side (the golden path's
gates, the GitHub App, Azure Container Apps previews, the workflows) is
separate, and Enki is not usable until both are done.

Work through the four stages in order:

1. **Get the keys.** The human creates them and puts them in a `.env` file.
2. **Look at the space.** Read-only. Show the human what is there.
3. **Plan it together, then dry run.** Still read-only.
4. **Apply, then prove it.**

Keys come first so the plan is made against the board as it really is, with
real columns and real card counts, not what someone remembers of it. Nothing
changes in Jira until stage 4: the Jira admin's token is only used to read
until the human approves the dry run.

**Rules that hold throughout:**

- **You make every change, through the API.** The human's only hands-on job is
  creating identities and keys and putting them in the `.env` file. Never give
  them clicks to make in Jira. If a call fails, stop, show them the call and
  what Jira said, and work out another API route with them. Do not hand the
  change over as a click-path.
- **Never ask for a token in chat.** Tokens go in a file outside the repository,
  `~/.config/enki/<site>.env` with `chmod 600`, and you read them from there.
  Never print a token, never put one in a command's arguments, and never commit
  one. Pass curl credentials on stdin (`-K -`), as below.
- **Dry run, approval, then apply.** Before any write, show the human every call
  you will make, with its method, path and a summary of the payload. Then wait
  for a yes. Approval for one change does not cover the next.
- **Use project-specific names.** The playground's `bootstrap/jira.sh` uses
  fixed names: a workflow called "Factory", a scheme called "Factory scheme",
  and rules called "Factory: …". A second project would modify the first
  project's objects. Name everything after the project, for example
  "Enki — ACME".
- **Never delete what you did not create.** Boards, workflows, schemes and rules
  that were there before stay. If one is in the way, tell the human.

The rest of this skill calls Jira through `jira.sh`, which sits next to this
file. It uses Basic auth, sends the credentials to curl on stdin, and prints the
HTTP status as its last line:

```bash
ENKI_ENV=~/.config/enki/<site>.env <this skill's directory>/jira.sh ADMIN|BOT METHOD PATH [BODY-FILE]
```

It is a script rather than a shell function written out here because the skill
loader replaces numbered placeholders in this file with the words the skill was
invoked with, which broke the function's arguments.

---

## Stage 1: Get the keys

Ask only which Jira site and which space (its key, such as `WKB`), or whether
Enki gets a new space. Everything else about the space comes from the API in
stage 2. Don't ask whether it is team-managed or company-managed, or what its
columns are: people often can't find the one and misremember the other.

Then ask for the keys, in so many words. For example:

> To look at your board, and later to make the changes we agree, I need some
> keys. I've created `~/.config/enki/<site>.env` with the names to fill in.
> Please create the keys below, paste each one into that file, save it, and
> tell me when it's done. Don't paste them here. I'll only read from Jira until
> you've seen and approved a plan.

Create that file yourself, with the names and no values, and `chmod 600` it:

```
JIRA_BASE=https://<site>.atlassian.net
JIRA_USER=
JIRA_TOKEN=
JIRA_BOT_BASE=
JIRA_BOT_EMAIL=
JIRA_BOT_TOKEN=
FACTORY_DISPATCH_PAT=
```

Fill in `JIRA_BASE`, and `JIRA_BOT_BASE` once the route below is known. Leave
every secret to the human.

### What the human has to create

| Who                | What                                                                                                                                                                                 | Goes in                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| An **org admin**   | A service account for Enki: admin.atlassian.com → the org → Directory → Service accounts → Create. Name it "Enki", give it Jira on this site, and create an API token for it with the scopes listed below. | `JIRA_BOT_EMAIL`, `JIRA_BOT_TOKEN`        |
| A **Jira admin**   | Their own API token, for making the changes: id.atlassian.com → Security → API tokens → Create. They need Jira admin on the site, plus Automation access on the space.             | `JIRA_USER`, `JIRA_TOKEN`                 |
| Whoever owns the repo | A fine-grained GitHub PAT with Actions read and write on the repo.                                                                                                              | `FACTORY_DISPATCH_PAT`                    |

Tell the human plainly that **they will probably need an org admin** for the
service account. A Jira admin is not enough. If the org admin can't help or
won't, use the licensed-user route below.

When they say the file is saved, check that every name has a value, without
printing any:

```bash
set -a; . ~/.config/enki/<site>.env; set +a
for v in JIRA_BASE JIRA_USER JIRA_TOKEN JIRA_BOT_BASE JIRA_BOT_EMAIL JIRA_BOT_TOKEN FACTORY_DISPATCH_PAT; do
  [[ -n ${!v:-} ]] && echo "$v set" || echo "$v MISSING"
done
```

### Which route Enki takes

Enki has to be able to do everything a teammate does on a card. It needs to be:

1. **assigned** a card, because handing a card over means assigning it;
2. **@mentioned** in a comment, which is how people ask Enki for more on a card
   in review and how they stop it;
3. able to **post comments**, which is how it reports every turn;
4. able to **move a card**, including to Done.

**Service account (preferred).** It costs no licence, and it is clearly a bot.
Its token is scoped, and a scoped token only works through the API gateway, not
the site URL:

- `JIRA_BOT_BASE=https://api.atlassian.com/ex/jira/<cloudId>`, where the cloudId
  comes from `curl -s $JIRA_BASE/_edge/tenant_info | jq -r .cloudId`.
- In the repository, the `JIRA_BASE` the factory's workflows use is the gateway
  URL. The factory only uses `JIRA_BASE` for API calls (`factory/src/jira-http.ts`),
  never for links people click, so this is safe.
- A service account's `accountType` is `app`, not `atlassian`.
  `bootstrap/jira.sh` and `bootstrap/jira-triggers.sh` accept both. Any other
  code that filters on `accountType == "atlassian"` will not find the bot.
  Record the bot's accountId from `GET /rest/api/3/myself` as the bot.
- Token scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`. Add more
  only if a check in stage 4 fails for lack of one.

> **Not yet proven.** The service-account route has not been run end to end.
> The gateway URL, the `app` account type and the scopes come from Atlassian's
> documentation. The identity checks in Stage 4 decide whether it works.

**Licensed user (fallback).** This is an ordinary Atlassian account, such as
`enki@<company>`, with a Jira licence. It uses a classic API token against the
site URL, so `JIRA_BOT_BASE` is the same as `JIRA_BASE`. It always passes the
identity checks, but it costs a seat.

---

## Stage 2: Look at the space

Everything in this stage is a read. Start with `BOT GET /rest/api/3/myself`, and
record the bot's `accountId` and `accountType`. If the bot can't see the space
yet, say so; giving it access is part of the plan. The service account often
waits on an org admin: if only the Jira admin's keys are in, read the space
with those and plan with the human, and do the bot's checks when its keys
arrive. They're needed before the dry run.

**Every space:**

| What                    | How                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Project and its type    | `GET /rest/api/3/project/<KEY>`; `.style` is `classic` (company-managed) or `next-gen` (team-managed) |
| Work types and statuses | `GET /rest/api/3/project/<KEY>/statuses`                                                  |
| Cards by status         | `POST /rest/api/3/search/approximate-count` with `project = <KEY> AND status = "<name>"`  |
| Boards and columns      | `GET /rest/agile/1.0/board?projectKeyOrId=<KEY>`, then `GET /rest/greenhopper/1.0/rapidviewconfig/editmodel.json?rapidViewId=<id>` |
| Acceptance criteria field | `GET /rest/api/3/issue/<a card>/editmeta`: is there a field called "Acceptance criteria"? |
| Automation rules        | `GET https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1/rule/summary`     |

**Company-managed (`classic`):**

| What                    | How                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Workflow scheme         | `GET /rest/api/3/workflowscheme/project?projectId=<id>`                                   |
| Workflows and conditions | `POST /rest/api/3/workflows?expand=values.transitions` with `{workflowNames: [...]}`     |
| Is the scheme shared?   | `GET /rest/api/3/workflowscheme/<id>/projectUsages`. Changing a shared scheme changes other spaces too. |
| Existing fields         | `GET /rest/api/3/field/search?query=Acceptance%20criteria`                                |

**Team-managed (`next-gen`):**

| What                    | How                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| The workflow            | `POST /rest/api/3/workflows?expand=values.transitions` with `{"projectAndIssueTypes": [{"projectId": "<id>", "issueTypeId": "<a type>"}]}`. Its scope is `PROJECT`; by default every work type shares it. |
| What the space allows   | `GET /rest/api/3/workflows/capabilities?projectId=<id>&issueTypeId=<a type>`. It must list `system:restrict-issue-transition`. |
| The space's statuses    | `GET /rest/api/3/statuses/search?projectId=<id>`                                          |
| Roles                   | `GET /rest/api/3/project/<KEY>/role`. A team-managed space has Administrator, Member and Viewer. |

### Show the human what is there

Write a short summary before proposing anything:

- whether the space is team-managed or company-managed, and its work types;
- the board's columns in order, the statuses behind each, and how many cards
  sit in each status, including statuses that have no column;
- whether there is an "Acceptance criteria" field Enki can read, and how many
  fields of that name the site has;
- the Automation rules already on the space;
- in a company-managed space, whether the workflow scheme is shared with other
  spaces.

---

## Stage 3: Plan it together, then the dry run

Now agree the design, against what stage 2 found. Ask whether people will work
on the same board as Enki, or the board is Enki's alone.

### What is not negotiable

These are what make Enki safe to leave alone with a board. Explain each one in a
sentence; the human needs to know why, not just what.

1. **Ten statuses, one for each step of the process.** They are created as
   Backlog, Ready for design, Designing, Design review, Blocked on architect,
   Ready for build, Building, In review, Blocked on engineer and Done. Existing
   statuses with the same names are reused, not duplicated. Once they exist,
   their ids are written into the repository's `enki.json`, and Enki moves,
   searches and reads cards by id. So the team can rename the columns
   afterwards: in a team-managed space renaming a column renames its status,
   and nothing breaks. What they can't do is delete a status, merge two into
   one column, or add steps Enki would have to know about.
2. **Every status can be reached from every other.** Each status has a global
   transition into it, because a turn can end in any state from any state. The
   gate on Enki's work is the PR review, not the Jira workflow.
3. **Designing and Building belong to Enki.** While a turn runs, only Enki can
   move or reassign the card. A human stops a turn by commenting
   "@Enki stop", not by dragging the card.
4. **Only Enki can move a card to Done.** It does that after the PR has merged
   and production is serving it. A person can drag a card to Done before its
   code ships, and then the board lies.
5. **A card is Enki's only when it is in a Ready column *and* assigned to Enki.**
   The board can be shared with work Enki must never touch.
6. **Acceptance criteria Enki can read.** Enki reads a field called "Acceptance
   criteria" if the card has one, and the card's description always. Where the
   criteria live is settled here: in a team-managed space they usually go
   in the description, under an "Acceptance criteria" heading (see Stage 4).
7. **The Automation rules** that wake Enki: card ready, card assigned, new
   comment, mentioned, stop and sweep (see `docs/factory/JIRA-TRIGGERS.md`).
8. **The repository side**, which is not this skill's job, but the human should
   hear it now. Enki's commits go through the repository's own golden-path gates;
   it does not bypass them. Every PR gets its own preview on **Azure Container
   Apps**, which is required, not optional. A project still on capped preview
   environments, such as Static Web Apps, has to move to Container Apps.

### The options

| Option                                      | When it fits                                                                 | What changes                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. The whole space runs on Enki's workflow** | A new space, or a team happy to adopt the ten statuses for everything. | Every work type uses the Enki workflow. Existing cards are moved from their old statuses into the new ones.                                       |
| **B. Enki gets its own work type**          | An established company-managed space whose other work must keep its own workflow. | A work type, such as "Enki task", is added to the space. Only that type uses the Enki workflow. The board shows Enki's columns beside the existing ones. |
| **C. Enki gets its own board in a new space** | The team wants Enki at arm's length, or the workflow is shared with other spaces. | Nothing in the existing space changes. People raise cards in the new space.                                                             |

Option B has only been proven on company-managed spaces. In a team-managed
space, choose between A and C.

### What happens to the existing cards

Under option A, every card in the space ends up in one of the ten statuses.
Tell the human plainly what that means:

- **Only the status changes.** Each card keeps its comments, history,
  assignee, links and fields. Each move adds a line to the card's history and
  notifies its watchers.
- **A card already in a status with the same name stays put**, such as a card
  in Done when the space already has a Done status.
- **The old statuses stop being used.** In a team-managed space they stay in
  the workflow, because Jira's API won't remove them, but they're empty, no one
  can move a card into them, and they're left off the board. In a
  company-managed space they go with the old workflow.
- **Nothing is assigned to Enki by the move.** A card becomes Enki's work only
  when a person puts it in a Ready column and assigns it to Enki, so moving
  cards doesn't start any turns.

Propose a mapping for every status that has cards, using stage 2's counts, and
agree it status by status. Cards Enki has no business with usually go to
Backlog, and finished ones to Done. Work in progress goes to Backlog unless the
human wants Enki to pick it up, in which case it goes to the Ready column for
its stage, still unassigned.

### Raise what stage 2 found

For example:

- the space is team-managed, so option B is out;
- the scheme is shared with other spaces;
- a status Enki needs exists with different capitals, such as "In Review"
  (stage 4 renames it);
- the space has no "Acceptance criteria" field Enki can read (see stage 4);
- the site has more than one field called "Acceptance criteria" (see Report
  back).

Also agree who in the team is told about "@Enki stop".

Write the agreed plan back to the human in a few lines: the option, the ten
columns in order, the card mapping with counts, where acceptance criteria go,
and who is told. Get a yes before the dry run.

### The dry run

Show the human every call of Stage 4 in order, with what each one creates or
changes, and how many cards each move touches. That includes the scratch card
the identity checks use, and the `enki.json` change to the repository (step 6
of Stage 4). Apply only after they say yes.

---

## Stage 4: Apply, then prove it

Run everything with the Jira admin's token, except the identity checks and the
final proof, which run as the bot. If a call fails, stop and report it. Don't
retry it blindly, and don't hand the human a click-path.

### 1. Check the identity

Run all four checks as the bot, on a scratch card in the space. Then delete the
scratch card. A Jira admin often lacks the space's *Delete work items*
permission (`mypermissions` shows `DELETE_ISSUES`). If so, leave the card in
Backlog and tell the human its key.

| Check     | Call                                                                                           | Passes when                                                          |
| --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Assignable | `ADMIN GET /rest/api/3/user/assignable/search?project=<KEY>&accountId=<bot>`, then `ADMIN PUT /rest/api/3/issue/<card>/assignee {"accountId": "<bot>"}` | The bot is in the list, and the assign returns 204.               |
| Mentionable | `ADMIN POST /rest/api/3/issue/<card>/comment` with an ADF `mention` node `{type: "mention", attrs: {id: "<bot>"}}`, then read it back | The mention node survives, and the bot can see the comment from its own token. |
| Comments  | `BOT POST /rest/api/3/issue/<card>/comment`                                                    | 201, and the comment's `author.accountId` is the bot.                |
| Moves     | `BOT GET /rest/api/3/issue/<card>/transitions`, then `BOT POST` one of them                    | The transitions are listed, and the move returns 204.                |

If the bot can't see the space at all, give it access first (step 8, or the
role step in step 4 for a team-managed space), then rerun the checks.

If any check fails for the service account, tell the human which one failed and
what Jira said. Then go back to Stage 1 for the licensed-user route. Do not work
around a failed check.

### 2. The locks, in either kind of space

Both kinds of space use the same two locks, set through the workflow API:

- **Designing and Building:** two status properties, both set to the bot's
  accountId: `{"jira.permission.transition.user": "<bot>",
  "jira.permission.assign.user": "<bot>"}`.
- **Done:** a `system:restrict-issue-transition` condition on the transition into
  Done, naming the bot. It needs no group:

```json
"conditions": {
  "operation": "ALL",
  "conditionGroups": [],
  "conditions": [
    { "ruleKey": "system:restrict-issue-transition",
      "parameters": { "accountIds": "<bot accountId>" } }
  ]
}
```

On every other transition, leave `conditions` out or send `null`. Rules go in
`conditions` itself: putting them under a `rules` key gets a 400 that names no
field.

`POST /rest/api/3/workflows/update` replaces the whole workflow. Read it first
with `POST /rest/api/3/workflows?expand=values.transitions`, and send everything
back unchanged apart from what you mean to change. Include the workflow's
`version`: a workflow edited since the read gets a 409, not a lost edit.

### 3. A company-managed space

**Statuses.** `GET /rest/api/3/statuses/search` finds the ones that exist.
`POST /rest/api/3/statuses` creates the rest, with scope `GLOBAL` and the
category shown here:

| Status                | Category    |
| --------------------- | ----------- |
| Backlog               | TODO        |
| Ready for design      | TODO        |
| Designing             | IN_PROGRESS |
| Design review         | IN_PROGRESS |
| Blocked on architect  | IN_PROGRESS |
| Ready for build       | TODO        |
| Building              | IN_PROGRESS |
| In review             | IN_PROGRESS |
| Blocked on engineer   | IN_PROGRESS |
| Done                  | DONE        |

**The workflow.** `POST /rest/api/3/workflows/create`, with both locks from
step 2. The shape below is tested. The `bootstrap/jira.sh` "Workflow" section has
the rest, and explains why each required field is there.

- Top-level `statuses[]`: `{statusReference, id, name, statusCategory, description}` for each status.
  The `id` makes Jira reuse an existing status instead of failing on a duplicate name.
- `workflows[0].statuses[]`: `{statusReference, layout: {x, y}, properties}`, where
  `properties` is required even when it is `{}`.
- `transitions`: one `INITIAL` into Backlog, and one `GLOBAL` into each status,
  named after the status.

**The scheme, and assigning it.**

- **Option A:** `POST /rest/api/3/workflowscheme` with the Enki workflow as
  `defaultWorkflow`.
- **Option B:** add the work type to the space's work type scheme. Then set
  `issueTypeMappings: {"<type id>": "<Enki workflow>"}` on a copy of the
  space's scheme.

If the scheme is shared with other spaces, copy it. Never edit a shared scheme
in place. Then `PUT /rest/api/3/workflowscheme/project` with `{workflowSchemeId,
projectId}`.

- A space with no cards returns 204, and the change is done.
- Otherwise Jira returns 303 and a task URL. Poll the URL until the task is
  `COMPLETE`.
- If cards sit in statuses the new workflow doesn't have, the call needs the
  card mapping, as `statusMappingsByIssueTypes`.

**The field.** Create Acceptance criteria (a paragraph), then put it on the
space's screens. The `bootstrap/jira.sh` "Custom fields" section does this. Look
a field up with `/rest/api/3/field/search` before creating it:
`/rest/api/3/field` leaves out fields that aren't on a screen yet, so checking
that first creates duplicates.

**Filter and board**, if the space has no board to use:

- **Filter:** `POST /rest/api/3/filter`, with JQL `project = <KEY> ORDER BY Rank
  ASC`. For option B, add `AND issuetype = "Enki task"`.
- **Board:** `POST /rest/agile/1.0/board`, with `type: "kanban"`, `filterId`,
  and `location: {type: "project", projectKeyOrId: "<KEY>"}`. A board with no
  location doesn't show in the space's sidebar.

Then set the columns (step 5), pin the status ids (step 6) and give the bot
access (step 8).

### 4. A team-managed space

A team-managed space has its own workflow, statuses and board, and Jira's API
reaches all of them. The order matters. Cards have to move before the locks go
on, and the columns have to be set after the last workflow change.

1. **Statuses.** `POST /rest/api/3/statuses` with
   `{"scope": {"type": "PROJECT", "project": {"id": "<id>"}}, "statuses":
   [{"name", "statusCategory"}]}`, using the categories in step 3. An existing
   status of the same name is reused as it is.
   Jira refuses a name that differs from an existing one only in capitals ("Status
   name "In review" already in use"). Rename the existing status instead:
   `PUT /rest/api/3/statuses` with `{"statuses": [{id, name, statusCategory,
   description}]}`. A bare array gets a 400.
2. **Add them to the workflow.** One `workflows/update` that keeps every
   existing status and transition. It adds the new statuses, a `GLOBAL`
   transition into each, and points the `INITIAL` (Create) transition at Backlog.
   No locks yet. While no status is removed, the update needs no status mappings.
3. **Move the cards**, following the agreed mapping, with the admin's
   transitions: `POST /rest/api/3/issue/<key>/transitions`. This has to happen
   before the locks, because afterwards only the bot can move cards into
   Designing, Building or Done. Each move notifies the card's watchers; say so
   in the dry run. For many cards, `POST /rest/api/3/bulk/issues/transition` can
   do them in one go, but it has not been proven here.
4. **Lock, and retire the old statuses.** One more `workflows/update`. It puts
   on both locks from step 2. It also adds the same `restrict-issue-transition`
   condition, naming the bot, to the transition into each template status
   (such as To Do and In Progress), so no person can move a card into one.
   Jira's API won't remove a status from a team-managed workflow. Every
   mapping shape tried was refused, and `DELETE /rest/api/3/statuses` says the
   status is in use. So the old statuses stay in the workflow, empty and
   unreachable, and the next step leaves them off the board. New cards are
   created into Backlog, so none land there.
5. **Board columns, last** (step 5 below). Every workflow update rebuilds a
   team-managed board's columns: one column per status, in Jira's own order,
   template statuses included. So the columns go on after the final workflow
   update. Tell the human that a later workflow change, made by anyone, resets
   them, and the columns PUT has to run again.
6. **The bot's access.** `POST /rest/api/3/project/<id>/role/<Member role id>`
   with `{"user": ["<bot>"]}`. The `categorisedActors` form gets a 400.
7. **Acceptance criteria.** If the space's cards already have a field called
   "Acceptance criteria" (stage 2's `editmeta`), use it. If not, the criteria go
   in the description under an "Acceptance criteria" heading. Enki reads the
   whole description, so they reach it. Don't create a field. Jira's API can
   create one and attach it to a team-managed space with
   `PUT /rest/api/3/field/association`, and its value can then be written and
   read. But no public API puts it on the space's layout, so people never see
   it.

### 5. Board columns

The documented Agile API can only read columns, so this uses the endpoint Jira's
own board settings page calls. It is not in Atlassian's published API, and it
could change without notice.

Read the board first with `GET
/rest/greenhopper/1.0/rapidviewconfig/editmodel.json?rapidViewId=<id>`. Send
existing columns back by their `id`, and leave out every column that isn't one
of the ten:

```
PUT /rest/greenhopper/1.0/rapidviewconfig/columns
{ "currentStatisticsField": {"id": "issueCount_"},
  "rapidViewId": <board id>,
  "mappedColumns": [
    {"id": <column id, if it exists>, "name": "Backlog", "mappedStatuses": [{"id": "<status id>"}],
     "min": "", "max": "", "isKanPlanColumn": false},
    ... one per status, in this order: Backlog, Ready for design, Designing,
        Blocked on architect, Design review, Ready for build, Building,
        Blocked on engineer, In review, Done
  ] }
```

Each "Blocked on …" column sits just before the review column it pairs with.
Both are ways out of the same running state, and "blocked" is the one that goes
backwards.

- **Company-managed Kanban board from the template:** Jira keeps an empty
  placeholder column, flagged `isKanPlanColumn: true`, at the front. Send it
  back as it was, in front; `bootstrap/jira.sh` shows how.
- **Team-managed board:** it has no placeholder. The template statuses left out
  show as unmapped, which is what you want.

Read the board back and check it shows the ten columns in that order.

### 6. Pin the status ids in the repository

Enki finds the ten statuses by the ids in `enki.json` at the repository root,
so that renaming a column changes nothing but its label. Write them once the
statuses exist, which means after step 3's statuses or step 4's first step,
and check them against the space:

1. `GET /rest/api/3/statuses/search?projectId=<id>` (team-managed) or
   `GET /rest/api/3/statuses/search` (company-managed), and take the id of each
   of the ten. In a company-managed space, take the ids the Enki workflow uses
   (its `statuses[].statusReference`), not just any status with the name.
2. Write them under `jira.statuses`, keeping everything else the file already
   holds:

   ```json
   { "jira": { "statuses": {
       "Backlog": "10054", "Ready for design": "10055", "Designing": "10056",
       "Design review": "10057", "Blocked on architect": "10058",
       "Ready for build": "10059", "Building": "10060", "In review": "10061",
       "Blocked on engineer": "10062", "Done": "10063" } } }
   ```

   The keys are always these ten names, whatever the columns are called later.
   All ten or none: the factory refuses a partial list, or an id used twice.
3. Agents are never allowed to edit `enki.json`, so this goes in as its own
   pull request for a person to review. Tell the human it has to merge before
   anyone renames a column. Until it does, Enki goes by name.

The repository's factory has to be one that reads `jira.statuses`
(`factory/src/statuses.ts`). An older one ignores it and goes by name.

### 7. The Automation rules

Create the six rules from `bootstrap/jira-triggers.sh` with the Automation Rule
Management API, at
`https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1`, using the
Jira admin's token.

- Scope each rule to this space's ARI only:
  `ari:cloud:jira:<cloudId>:project/<id>`.
- Name each rule after the space, so two spaces don't share rules.
- The script finds the bot by searching for `JIRA_BOT_EMAIL`. Check that the
  accountId it prints is the one `myself` gave in stage 2.
- The rules are created disabled. Enable them, through the same API, once the
  human confirms the repository side is ready, so Enki isn't sent work it can't
  do yet.

### 8. The bot's access in a company-managed space

Enki needs to browse the space, assign cards, move them and comment.
Check this as the bot with `GET /rest/api/3/mypermissions?projectKey=<KEY>&permissions=BROWSE_PROJECTS,ASSIGNABLE_USER,TRANSITION_ISSUES,ADD_COMMENTS,EDIT_ISSUES`.
If a permission is missing, add the bot to the project role that the
permission scheme grants it to, and tell the human which role you used. Run the
same check in a team-managed space after its role step.

### 9. Prove it

Run these on a scratch card that is never in a Ready column and never assigned
to Enki, so that no Automation rule fires. Then delete the card, or leave it in
Done if the admin cannot delete it:

- **As the admin:** `GET /issue/<card>/transitions` does **not** offer Done, or
  any retired template status. `POST`ing the Done transition is refused with a
  400, and the card stays put.
- **As the bot:** Done is offered, and the move returns 204.
- **Each lock:** move the card into Designing as the bot. As the admin, the
  card should offer no transitions. Moving it should be refused with a 400, and
  reassigning it with a 403. Do the same in Building. Move the card on within
  ten minutes: the poller releases a locked card that has no run behind it.
- **The board:** shows the ten columns, and the card sits in the right one.
- **The pinned ids:** each id in `enki.json` is a status in the Enki workflow,
  under the name it is pinned to, and the scratch card's moves above went
  through those ids.

These calls were proven on non-production sites, on scratch spaces:

- **Company-managed, 7 October 2026:**
  - the workflow create with the Done condition, and the update that strips it
    and puts it back;
  - the bot passing every check while the admin is refused Done;
  - the column PUT, and the licensed bot passing all five identity checks;
  - every lock on a live project's workflow, applied by `bootstrap/jira.sh`
    from the update above.
- **Team-managed, 9 to 12 October 2026:**
  - the capabilities read listing `restrict-issue-transition`;
  - creating project-scoped statuses, and renaming "In Review" to "In review";
  - adding the ten statuses to the workflow, and moving cards across with the
    admin's transitions;
  - both locks: the admin refused moves (400), reassignment (403) and Done
    (400), while the bot assigns, moves and closes;
  - retiring the template statuses with the bot-only condition, and a new card
    landing in Backlog;
  - the column PUT after the final workflow update, with both locks intact
    after it;
  - adding the bot to the Member role;
  - creating a field and attaching it to the space: the value is stored but not
    shown;
  - Jira refusing to remove a status from the workflow.

Not yet proven: Automation rules on a team-managed space, option B on a
team-managed space, and the bulk transition.

### Report back

Tell the human what changed, with links to the board, the workflow, the
rules and the `enki.json` pull request. Then:

- **Tokens:** the Jira admin's token was only for setup, and they can revoke it
  and clear `JIRA_USER` and `JIRA_TOKEN` from the `.env` file now. Keep the
  bot's token, because Enki uses it on every turn.
- **Acceptance criteria:** the factory finds the field by name across the whole
  site (`factory/src/gather.ts`). If the site has more than one field called
  "Acceptance criteria", it can read the wrong one and find nothing. Say so if
  stage 2 found more than one.
