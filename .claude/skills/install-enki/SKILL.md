---
name: install-enki
description: |
  **Install Enki on a Jira space**: gets the credentials Enki needs, inspects an
  existing Jira project (or creates one), agrees with the human how Enki should
  fit into it, then makes the agreed changes to the board, from a dry run they
  have approved.
  Trigger: "/install-enki", "set up Enki on our board", "install the dark
  factory on Jira", "connect Enki to project X".
---

# Install Enki on a Jira space

This skill is about the Jira side only: the project, its workflow, its board
and the Automation rules that wake Enki. The repository side (the golden path's
gates, the GitHub App, Azure Container Apps previews, the workflows) is
separate, and Enki is not usable until both are done.

Work through the four stages in order. Each one ends with something the human
has agreed to, and nothing changes in Jira until stage 4.

**Rules that hold throughout:**

- **Never ask for a token in chat.** The human puts tokens in a file outside the
  repository, such as `~/.config/enki/<site>.env` with `chmod 600`, and you read
  them from there. Never print a token, never put one in a command's arguments,
  and never commit one. Pass curl credentials on stdin (`-K -`), as below.
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

A helper the rest of this skill assumes (Basic auth, credentials on stdin, last
line of output is the HTTP status):

```bash
# jira ADMIN|BOT METHOD PATH [BODY-FILE]
jira() {
  local who=$1 method=$2 path=$3 body=${4:-} u t
  if [[ $who == BOT ]]; then u=$JIRA_BOT_EMAIL; t=$JIRA_BOT_TOKEN; base=$JIRA_BOT_BASE
  else u=$JIRA_USER; t=$JIRA_TOKEN; base=$JIRA_BASE; fi
  local args=(-s -X "$method" -H 'Accept: application/json' -H 'Content-Type: application/json'
              -w '\n%{http_code}\n' -K -)
  [[ -n $body ]] && args+=(--data-binary "@$body")
  printf 'user = "%s:%s"\n' "$u" "$t" | curl "${args[@]}" "$base$path"
}
# Strip the status line with `sed '$d'`. macOS head has no `-n -1`.
```

---

## Stage 1: Credentials, and who Enki is

### What the human has to do

| Who                | What                                                                                                                                                                                 | Why                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| An **org admin**   | admin.atlassian.com → the org → Directory → Service accounts → Create. Name it "Enki", give it Jira on this site, and create an API token for it with the scopes listed below. | Enki needs its own identity in Jira. Only an organisation admin can create a service account. |
| A **Jira admin**   | Run Stage 4 with their own API token: id.atlassian.com → Security → API tokens → Create. They need Jira admin on the site, plus Automation access on the project.                | Creating workflows, schemes and Automation rules needs Jira admin.                        |
| Whoever owns the repo | A fine-grained GitHub PAT with Actions read and write on the repo, saved as `FACTORY_DISPATCH_PAT`.                                                                                | The Automation rules use it to start `poller.yml` and `stop.yml`.                         |

Tell the human plainly that **they will probably need an org admin** for the
service account. A Jira admin is not enough. If the org admin can't help or
won't, use the licensed-user route below.

Ask the human for the path to their credentials file, never the values. It
holds:

```
JIRA_BASE=https://<site>.atlassian.net
JIRA_USER=<the Jira admin's email>
JIRA_TOKEN=<the Jira admin's API token>
JIRA_BOT_EMAIL=<the service account's email, or the licensed user's>
JIRA_BOT_TOKEN=<its token>
FACTORY_DISPATCH_PAT=<the GitHub PAT>
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
- A service account's `accountType` is `app`, not `atlassian`. Any code that
  finds the bot by filtering on `accountType == "atlassian"` will not find it.
  `bootstrap/jira.sh` and `bootstrap/jira-triggers.sh` both do this today. Look
  the bot up with `GET /rest/api/3/myself` as the bot instead.
- Token scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`. Add more
  only if a check below fails for lack of one.

> **Not yet proven.** The service-account route has not been run end to end.
> The gateway URL, the `app` account type and the scopes come from Atlassian's
> documentation. Run the checks below before relying on any of them.

**Licensed user (fallback).** This is an ordinary Atlassian account, such as
`enki@<company>`, with a Jira licence. It uses a classic API token against the
site URL, so `JIRA_BOT_BASE` is the same as `JIRA_BASE`. It always passes the
four checks, but it costs a seat.

### Check the identity before anything else

Run all four checks as the bot, on a scratch card in a project the bot can see.
Then delete the scratch card. A Jira admin often lacks the project's *Delete
work items* permission (`mypermissions` shows `DELETE_ISSUES`). If so, leave
the card in Backlog and tell the human its key.

| Check     | Call                                                                                           | Passes when                                                          |
| --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Who       | `BOT GET /rest/api/3/myself`                                                                   | 200. Record `accountId` and `accountType`.                           |
| Assignable | `ADMIN GET /rest/api/3/user/assignable/search?project=<KEY>&accountId=<bot>`, then `ADMIN PUT /rest/api/3/issue/<card>/assignee {"accountId": "<bot>"}` | The bot is in the list, and the assign returns 204.               |
| Mentionable | `ADMIN POST /rest/api/3/issue/<card>/comment` with an ADF `mention` node `{type: "mention", attrs: {id: "<bot>"}}`, then read it back | The mention node survives, and the bot can see the comment from its own token. |
| Comments  | `BOT POST /rest/api/3/issue/<card>/comment`                                                    | 201, and the comment's `author.accountId` is the bot.                |
| Moves     | `BOT GET /rest/api/3/issue/<card>/transitions`, then `BOT POST` one of them                    | The transitions are listed, and the move returns 204.                |

If any check fails for the service account, tell the human which one failed and
what Jira said. Then switch to the licensed-user route. Do not work around a
failed check.

---

## Stage 2: Look at the space, or make one

Ask whether Enki is joining an existing project or getting a new one.

**New project.** Create it as company-managed: `POST /rest/api/3/project`, with
`projectTypeKey: "software"` and
`projectTemplateKey: "com.pyxis.greenhopper.jira:gh-simplified-kanban-classic"`.
A team-managed project keeps its workflow private, so the workflow API in
Stage 4 can't reach it. Skip to Stage 3 with nothing to reconcile.

**Existing project.** Read everything below, and write the human a short
summary before asking anything:

| What                    | How                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Project and its style   | `GET /rest/api/3/project/<KEY>`; `.style` is `classic` (company-managed) or `next-gen` (team-managed) |
| Work types              | `GET /rest/api/3/project/<KEY>/statuses`, which gives each work type with its statuses    |
| Workflow scheme         | `GET /rest/api/3/workflowscheme/project?projectId=<id>`                                   |
| Workflows and conditions | `POST /rest/api/3/workflows?expand=values.transitions` with `{workflowNames: [...]}`     |
| Is the scheme shared?   | `GET /rest/api/3/workflowscheme/<id>/projectUsages`. Changing a shared scheme changes other projects too. |
| Boards and columns      | `GET /rest/agile/1.0/board?projectKeyOrId=<KEY>`, then `/board/<id>/configuration`        |
| Cards by status         | `POST /rest/api/3/search/approximate-count` with `project = <KEY> AND status = "<name>"`  |
| Automation rules        | `GET https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1/rule/summary`     |
| Fields                  | `GET /rest/api/3/field/search?query=Acceptance%20criteria` and `?query=Design%20owner`    |

A team-managed project can't be changed into a company-managed one. If the
project is team-managed, say so, and offer either a new company-managed project
or moving the cards.

---

## Stage 3: Agree how Enki fits in

Explain what is fixed and what is up to them. Then lay out the options that fit
what you found, and recommend one.

### What is not negotiable

These are what make Enki safe to leave alone with a board. Explain each one in a
sentence; the human needs to know why, not just what.

1. **The ten statuses, by these exact names.** They are Backlog, Ready for
   design, Designing, Design review, Blocked on architect, Ready for build,
   Building, In review, Blocked on engineer and Done. Enki moves a card by the
   name of the status it is going to, so a renamed status leaves cards stuck.
   Existing statuses with the same names are reused, not duplicated.
2. **Every status can be reached from every other.** Each status has a global
   transition into it, because a turn can end in any state from any state. The
   gate on Enki's work is the PR review, not the Jira workflow.
3. **Designing and Building belong to Enki.** While a turn runs, only Enki can
   move or reassign the card. Two status properties set this:
   `jira.permission.transition.user` and `jira.permission.assign.user`, both
   set to the bot's accountId. A human stops a turn by commenting
   "@Enki stop", not by dragging the card.
4. **Only Enki can move a card to Done.** It does that after the PR has merged
   and production is serving it. A person can drag a card to Done before its
   code ships, and then the board lies. The lock is a
   `system:restrict-issue-transition` condition on the transition into Done,
   naming the bot. It needs no group.
5. **A card is Enki's only when it is in a Ready column *and* assigned to Enki.**
   The board can be shared with work Enki must never touch.
6. **Two fields:** Acceptance criteria (a paragraph) and Design owner (a user
   picker), both on the project's screens. Enki finds them by name.
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
| **A. The whole project runs on Enki's workflow** | A new project, or a team happy to adopt the ten statuses for everything. | The project's scheme points every work type at the Enki workflow. Existing cards are mapped from their old statuses into the new ones.            |
| **B. Enki gets its own work type**          | An established project whose other work must keep its own workflow.          | A work type, such as "Enki task", is added to the project. The scheme maps only that type to the Enki workflow. The board shows Enki's columns beside the existing ones. |
| **C. Enki gets its own board in a new project** | The team wants Enki at arm's length, or the scheme is shared with other projects. | Nothing in the existing project changes. People raise cards in the new project.                                                            |

For A and B, if the scheme is shared with other projects, copy it. Never edit a
shared scheme in place.

For A, existing cards need a status mapping when the scheme changes. Draw it up
with the human: each old status → one of the ten. Cards Enki has no business
with usually go to Backlog or Done.

Also agree:

- whether to remove board columns nobody will use, or leave them;
- whether the empty placeholder "Backlog" column Jira keeps at the front of a
  Kanban board stays (it is harmless);
- who in the team is told about "@Enki stop".

Write the agreed plan back to the human in a few lines, and get a yes before
Stage 4.

---

## Stage 4: Make the changes

First show the human the dry run: every call in order, with what it creates or
changes. Apply only after they say yes. Run it with the Jira admin's token,
except the final checks, which run as the bot.

### 1. Statuses

`GET /rest/api/3/statuses/search` finds the ones that exist. `POST
/rest/api/3/statuses` creates the rest, with scope `GLOBAL` and the category
shown here:

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

### 2. The workflow, with both locks

`POST /rest/api/3/workflows/create`. The shape below is tested. The
`bootstrap/jira.sh` "Workflow" section has the rest, and explains why each
required field is there.

- Top-level `statuses[]`: `{statusReference, id, name, statusCategory, description}` for each status.
  The `id` makes Jira reuse an existing status instead of failing on a duplicate name.
- `workflows[0].statuses[]`: `{statusReference, layout: {x, y}, properties}`, where
  `properties` is required even when it is `{}`. On Designing and Building, set:
  `{"jira.permission.transition.user": "<bot>", "jira.permission.assign.user": "<bot>"}`.
- `transitions`: one `INITIAL` into Backlog, and one `GLOBAL` into each status,
  named after the status.
- The transition into Done carries the Done lock:

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

**For an existing Enki workflow** that lacks a lock, use
`POST /rest/api/3/workflows/update`. It replaces the whole workflow. Read it
first, with `POST /rest/api/3/workflows?expand=values.transitions`, and send
everything back unchanged apart from the conditions and properties. Include the
workflow's `version`: a workflow edited since the read gets a 409, not a lost
edit.

### 3. The scheme, and assigning it

- **Option A:** `POST /rest/api/3/workflowscheme` with the Enki workflow as
  `defaultWorkflow`.
- **Option B:** add the work type to the project's work type scheme. Then set
  `issueTypeMappings: {"<type id>": "<Enki workflow>"}` on a copy of the
  project's scheme.

Then `PUT /rest/api/3/workflowscheme/project` with `{workflowSchemeId,
projectId}`.

- A project with no cards returns 204, and the change is done.
- Otherwise Jira returns 303 and a task URL. Poll the URL until the task is
  `COMPLETE`.
- If cards sit in statuses the new workflow doesn't have, the call needs the
  status mapping from Stage 3, as `statusMappingsByIssueTypes`.

### 4. Fields

Create Acceptance criteria and Design owner, then put both on the project's
screens. The `bootstrap/jira.sh` "Custom fields" section does this. Look a field
up with `/rest/api/3/field/search` before creating it: `/rest/api/3/field`
leaves out fields that aren't on a screen yet, so checking that first creates
duplicates.

### 5. Filter, board and columns

- **Filter:** `POST /rest/api/3/filter`, with JQL `project = <KEY> ORDER BY Rank
  ASC`. For option B, add `AND issuetype = "Enki task"`.
- **Board:** `POST /rest/agile/1.0/board`, with `type: "kanban"`, `filterId`,
  and `location: {type: "project", projectKeyOrId: "<KEY>"}`. A board with no
  location doesn't show in the project's sidebar.
- **Columns:** the documented Agile API can only read columns, so this uses the
  endpoint Jira's own board settings page calls. It is not in Atlassian's
  published API, and it could change without notice:

```
PUT /rest/greenhopper/1.0/rapidviewconfig/columns
{ "currentStatisticsField": {"id": "issueCount_"},
  "rapidViewId": <board id>,
  "mappedColumns": [
    {"name": "Backlog", "mappedStatuses": [{"id": "<id>"}], "min": "", "max": "", "isKanPlanColumn": false},
    ... one per status, in this order: Backlog, Ready for design, Designing,
        Blocked on architect, Design review, Ready for build, Building,
        Blocked on engineer, In review, Done
  ] }
```

Check the result with `GET /rest/agile/1.0/board/<id>/configuration`. Jira keeps
its own empty "Backlog" placeholder column at the front; leave it.

**If the PUT fails, don't retry it.** Give the human the clicks instead:

1. Open the board, then **⋯** (top right) → **Board settings** → **Columns and
   statuses**.
2. Create columns until there are ten, named as above, in that order. Use
   **+** at the right-hand end, and drag a column by its header to move it.
3. Drag each status from **Unmapped statuses** (or from the template's To Do,
   In Progress and Done columns) into the column of the same name.
4. Delete the template's To Do and In Progress columns once they are empty.
5. Each "Blocked on …" column sits just before the review column it pairs with.
   Both are ways out of the same running state, and "blocked" is the one that
   goes backwards.

### 6. The bot's access

Enki needs to browse the project, assign cards, move them and comment.
Check this as the bot with `GET /rest/api/3/mypermissions?projectKey=<KEY>&permissions=BROWSE_PROJECTS,ASSIGNABLE_USER,TRANSITION_ISSUES,ADD_COMMENTS,EDIT_ISSUES`.
If a permission is missing, add the bot to the project role that the
permission scheme grants it to, and tell the human which role you used.

### 7. The Automation rules

Create the six rules from `bootstrap/jira-triggers.sh` with the Automation Rule
Management API, at
`https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1`, using the
Jira admin's token.

- Scope each rule to this project's ARI only.
- Name each rule after the project, so two projects don't share rules.
- The script finds the bot with a filter that misses service accounts (see
  Stage 1). Pass it the bot's accountId instead.
- The rules are created disabled. Enable them once the human confirms the
  repository side is ready, so Enki isn't sent work it can't do yet.

### 8. Prove it

Run these on a scratch card that is never in a Ready column and never assigned
to Enki, so that no Automation rule fires. Then delete the card, or leave it in
Done if the admin cannot delete it:

- **As the admin:** `GET /issue/<card>/transitions` does **not** offer Done.
  `POST`ing the Done transition is refused with a 400, and the card stays put.
- **As the bot:** Done is offered, and the move returns 204.
- **Each lock:** move the card into Designing as the bot. As the admin, the
  card should offer no transitions. Moving it should be refused with a 400, and
  reassigning it with a 403. Do the same in Building. Move the card on within
  ten minutes: the poller releases a locked card that has no run behind it.
- **The board:** shows the ten columns, and the card sits in the right one.

These calls were proven on 7 October 2026, on a scratch project on a
non-production site:

- the workflow create with the Done condition, and the update that strips it
  and puts it back;
- the bot passing every check while the admin is refused Done;
- the column PUT, and the licensed bot passing all five identity checks;
- every lock on a live project's workflow, applied by `bootstrap/jira.sh` from
  the update above.

Report to the human what changed, with links to the board, the workflow and the
rules. Then remind them of the tokens: the Jira admin's token was only for
setup, and they can revoke it now. Keep the bot's token, because Enki uses it
on every turn.
