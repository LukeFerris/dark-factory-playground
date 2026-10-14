---
name: install-enki
description: |
  **Install Enki on a team's Jira space and GitHub repository**: checks what
  the repository already has, asks the human only for the keys that are
  missing, in a `.env` file, then reads the space and the repository and shows
  them what is there, plans the change with them, and makes every change
  itself through Jira's and GitHub's APIs, from a dry run they have approved.
  Works on company-managed and team-managed spaces. Trigger: "/install-enki",
  "set up Enki on our board", "install the dark factory on Jira", "connect Enki
  to project X", "move our repo to Enki".
---

# Install Enki on a Jira space and its repository

Enki needs two things set up: the **Jira space** (statuses, workflow, locks,
board, Automation rules) and the **repository** (the GitHub App, secrets and
variables, branch rules, Enki's code and workflows, previews on Azure Container
Apps). This skill covers both. Enki isn't usable until both are done, and
neither side is switched on until the other is ready.

Work through the four stages in order. Each stage covers both sides.

1. **Get the keys.** Check what the repository already has, then ask the human
   for only what's missing, in a `.env` file.
2. **Look.** Read-only. Show the human what the space and the repository hold.
3. **Plan it together, then dry run.** Still read-only.
4. **Apply, then prove it.**

Keys come first so the plan is made against the board and the repository as
they really are, not what someone remembers of them. Nothing changes in Jira or
GitHub until stage 4.

**Rules that hold throughout:**

- **You make every change, through the API.** The human's jobs are the ones only
  a person can do: creating identities and keys, putting them in the `.env`
  file, and reviewing pull requests. Never give them clicks to make in Jira or
  GitHub. If a call fails, stop, show them the call and what came back, and work
  out another API route with them. The one exception is in stage 4: if the
  Automation API refuses them, the human may *choose* to build the rules
  themselves from a guide you write.
- **Never ask for a token in chat.** Tokens go in a file outside the repository,
  `~/.config/enki/<site>.env` with `chmod 600`, and you read them from there.
  Never print a token, never put one in a command's arguments, and never commit
  one. Pass curl credentials on stdin (`-K -`), and secret values to
  `gh secret set` on stdin.
- **Use the human's own GitHub login, without switching it.** `gh` can hold
  several accounts. Pick one per command with
  `GH_TOKEN=$(gh auth token -u <account>) gh …`, and never `gh auth switch`.
- **Check before you ask.** A secret, variable or setting the repository already
  has is not asked for again. `check-repo.sh` says what is there.
- **Back up before you change anything.** Before the first Jira write, save every
  card and the space's configuration (stage 4, step A0). Compare against it
  after.
- **Dry run, approval, then apply.** Before any write, show the human every call
  you will make, with its method, path and a summary of the payload. Then wait
  for a yes. Approval for one change does not cover the next.
- **Use project-specific names.** The playground's `bootstrap/jira.sh` uses
  fixed names: a workflow called "Factory", a scheme called "Factory scheme",
  and rules called "Factory: …". A second project would modify the first
  project's objects. Name everything after the project, for example
  "Enki — ACME".
- **Never delete what you did not create.** Boards, workflows, schemes, rules,
  rulesets and workflows in the repository that were there before stay. If one
  is in the way, tell the human.
- **The repository's own gates stand.** Enki's commits go through the
  repository's own checks and hooks, the golden path's included. It never
  bypasses or weakens them. Enki's code is written for this repository, using
  the playground as the reference, not copied across whole.

### The helpers

Both sit next to this file. They are scripts rather than shell functions written
out here, because the skill loader replaces numbered placeholders in this file
with the words the skill was invoked with, which broke a function's arguments.
Run them with `bash`: the human's shell may be zsh, where the `${!v}` forms
below fail with "bad substitution".

- **`jira.sh`** calls Jira as the admin or the bot. It uses Basic auth, sends the
  credentials to curl on stdin, and prints the HTTP status as its last line:

  ```bash
  ENKI_ENV=~/.config/enki/<site>.env <this skill's directory>/jira.sh ADMIN|BOT METHOD PATH [BODY-FILE]
  ```

- **`check-repo.sh`** reads the repository and prints one line for each thing
  Enki needs there: `ok`, `MISSING`, `WRONG` (there, but not as Enki needs it)
  or `SEE` (needs a person to confirm). It only reads.

  ```bash
  GH_TOKEN=$(gh auth token -u <account>) bash <this skill's directory>/check-repo.sh OWNER/REPO
  ```

---

## Stage 1: Get the keys

Ask which Jira site and space (its key, such as `WKB`), or whether Enki gets a
new space, and which GitHub repository. Everything else about them comes from
the APIs in stage 2. Don't ask whether the space is team-managed or
company-managed, or what its columns are: people often can't find the one and
misremember the other.

### Check the repository first

Reading the repository needs nothing new: the human's own `gh` login is enough.
Run `check-repo.sh` now, before asking for any key. Whatever it reports `ok` is
not asked for. In particular:

- A **secret** it reports `ok` is taken as installed. Secrets can't be read back,
  so the first poller run is what proves the value.
- A **variable** it reports `WRONG` because it was set as a secret
  (`FACTORY_APP_ID` and `FACTORY_BOT_LOGIN` often are) needs its value again.
  These two aren't secret: the App's id is on its settings page, and the bot
  login is `<the App's slug>[bot]`.
- If the human's login has no **admin rights** on the repository, they need a
  repo admin, or one has to run stage 4's repository part.

### Ask for what's missing

Then ask for the keys, in so many words. For example:

> To look at your board, and later to make the changes we agree, I need some
> keys. I've created `~/.config/enki/<site>.env` with the names to fill in.
> Please create the keys below, paste each one into that file, save it, and
> tell me when it's done. Don't paste them here. I'll only read until you've
> seen and approved a plan.

Create that file yourself, with the names and no values, and `chmod 600` it.
Leave out any line whose value the repository already has:

```
JIRA_BASE=https://<site>.atlassian.net
JIRA_USER=
JIRA_TOKEN=
JIRA_BOT_BASE=
JIRA_BOT_EMAIL=
JIRA_BOT_TOKEN=
FACTORY_DISPATCH_PAT=
ANTHROPIC_API_KEY=
FACTORY_APP_ID=
FACTORY_BOT_LOGIN=
FACTORY_APP_KEY_PATH=
```

Fill in what isn't secret yourself: `JIRA_BASE`, `JIRA_BOT_BASE` once the route
below is known, and `JIRA_BOT_EMAIL` if you can find it (see below). Leave every
secret to the human.

### What the human has to create

| Who                | What                                                                                                                                                                                 | Goes in                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| An **Atlassian org admin** | A service account for Enki: admin.atlassian.com → the org → Directory → Service accounts → Create. Name it "Enki", give it Jira on this site, and create an API token for it with the scopes listed below. | `JIRA_BOT_EMAIL`, `JIRA_BOT_TOKEN` |
| A **Jira admin**, or the space's admin | Their own API token, for making the changes: id.atlassian.com → Security → API tokens → Create. A space admin can do everything but create Automation rules through the API (stage 4, step A7). | `JIRA_USER`, `JIRA_TOKEN` |
| A **GitHub org owner**, for an org's repository | A GitHub App for Enki, with exactly the permissions in `docs/factory/SETUP.md`, Checkpoint A, installed on this repository only. Webhook off. They generate a private key and save the `.pem` outside any repository, `chmod 600`. | `FACTORY_APP_ID`, `FACTORY_BOT_LOGIN`, `FACTORY_APP_KEY_PATH` |
| Whoever owns the repo | A fine-grained GitHub PAT with only Actions: read and write, on this repository only. An org may have to approve it before it works. | `FACTORY_DISPATCH_PAT` |
| Whoever holds the Anthropic account | An Anthropic API key for Enki. | `ANTHROPIC_API_KEY` |

Tell the human plainly that **they will probably need an Atlassian org admin**
for the service account, and **a GitHub org owner** for the App. Neither a Jira
admin nor a repo admin is enough. If the Atlassian org admin can't help or
won't, use the licensed-user route below.

When they say the file is saved, check that every name has a value, without
printing any. Under `bash`, not zsh:

```bash
bash <<'EOF'
set -a; . ~/.config/enki/<site>.env; set +a
for v in $(grep -o '^[A-Z_]*' ~/.config/enki/<site>.env); do
  [[ -n ${!v:-} ]] && echo "$v set" || echo "$v MISSING"
done
EOF
```

### Which route Enki takes in Jira

Enki has to be able to do everything a teammate does on a card. It needs to be:

1. **assigned** a card, because handing a card over means assigning it;
2. **@mentioned** in a comment, which is how people ask Enki for more on a card
   in review and how they stop it;
3. able to **post comments**, which is how it reports every turn;
4. able to **move a card**, including to Done.

**Service account (preferred).** It costs no licence, and it is clearly a bot.
Proven on a live space (see "Proven" at the end). Its token is scoped, and a
scoped token only works through the API gateway, not the site URL:

- `JIRA_BOT_BASE=https://api.atlassian.com/ex/jira/<cloudId>`, where the cloudId
  comes from `curl -s $JIRA_BASE/_edge/tenant_info | jq -r .cloudId`.
- Basic auth with the account's email and token works through the gateway, and
  so does `Authorization: Bearer <token>`. If the org admin handed over only the
  token, `GET /rest/api/3/myself` with the Bearer header returns the account's
  email (it looks like `<name>@serviceaccount.atlassian.com`). Put the header in
  curl's config on stdin, like the credentials.
- In the repository, the `JIRA_BASE` the factory's workflows use is the gateway
  URL. The factory only uses `JIRA_BASE` for API calls (`factory/src/jira-http.ts`),
  never for links people click, so this is safe.
- A service account's `accountType` is `app`, not `atlassian`.
  `bootstrap/jira.sh` and `bootstrap/jira-triggers.sh` accept both. Any other
  code that filters on `accountType == "atlassian"` will not find the bot.
  Record the bot's accountId from `GET /rest/api/3/myself` as the bot.
- Token scopes: `read:jira-work`, `write:jira-work`, `read:jira-user`. Add more
  only if a check in stage 4 fails for lack of one.

**Licensed user (fallback).** This is an ordinary Atlassian account, such as
`enki@<company>`, with a Jira licence. It uses a classic API token against the
site URL, so `JIRA_BOT_BASE` is the same as `JIRA_BASE`. It always passes the
identity checks, but it costs a seat.

---

## Stage 2: Look

Everything in this stage is a read.

### The space

Start with `BOT GET /rest/api/3/myself`, and record the bot's `accountId` and
`accountType`. If the bot can't see the space yet, say so; giving it access is
part of the plan. The service account often waits on an org admin: if only the
Jira admin's keys are in, read the space with those and plan with the human,
and do the bot's checks when its keys arrive. They're needed before the dry
run.

Also read the admin's own standing:
`ADMIN GET /rest/api/3/mypermissions?projectKey=<KEY>&permissions=ADMINISTER,ADMINISTER_PROJECTS,DELETE_ISSUES`.
`ADMINISTER` is Jira admin, which the Automation API needs (stage 4, step A7).

**Every space:**

| What                    | How                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Project and its type    | `GET /rest/api/3/project/<KEY>`; `.style` is `classic` (company-managed) or `next-gen` (team-managed) |
| Work types and statuses | `GET /rest/api/3/project/<KEY>/statuses`                                                  |
| Cards by status         | `POST /rest/api/3/search/approximate-count` with `project = <KEY> AND status = "<name>"`. The count lags a few seconds behind a change; check a change with a real search. |
| Boards and columns      | `GET /rest/agile/1.0/board?projectKeyOrId=<KEY>`, then `GET /rest/greenhopper/1.0/rapidviewconfig/editmodel.json?rapidViewId=<id>` |
| Acceptance criteria field | `GET /rest/api/3/issue/<a card>/editmeta`: is there a field called "Acceptance criteria"? |
| Automation rules        | `GET https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1/rule/summary`. A 403 means the admin isn't a Jira admin. |

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

### The repository

`check-repo.sh` has already covered the settings. Read the rest from the
repository itself, in a scratch clone or worktree, never in a checkout someone
is working in:

| What | Where to look |
| --- | --- |
| Its own gates | The CI workflows that run on pull requests, the pre-commit hooks (`.husky/`), lint and coverage config. Which of them are required on the default branch? |
| How it previews a PR today | Static Web Apps, Vercel, nothing? Does the app need a database or other service per preview, such as a Supabase branch? |
| How it ships | The production workflow, and what "production is serving it" means here. Enki moves a card to Done only after that. |
| Its runtime | Node version, package manager, build command, and whether there is a Dockerfile |
| Other agents | `@claude` workflows, Copilot review, loops like Ralph. Enki will run beside them, or they go. |
| Enki already there? | `factory/`, Enki's workflows, `enki.json`. An older factory doesn't read pinned status ids (`factory/src/statuses.ts`). |

### Show the human what is there

Write a short summary before proposing anything.

**The space:**

- whether it is team-managed or company-managed, and its work types;
- the board's columns in order, the statuses behind each, and how many cards
  sit in each status, including statuses that have no column;
- whether there is an "Acceptance criteria" field Enki can read, and how many
  fields of that name the site has;
- the Automation rules already on the space, and whether the admin is a Jira
  admin;
- in a company-managed space, whether the workflow scheme is shared with other
  spaces.

**The repository:** `check-repo.sh`'s lines that aren't `ok`, and what the table
above found. Say plainly when the repository's own tests aren't required on the
default branch, because Enki's PRs could then merge with failing tests.

---

## Stage 3: Plan it together, then the dry run

Now agree the design, against what stage 2 found. Ask whether people will work
on the same board as Enki, or the board is Enki's alone.

### What is not negotiable

These are what make Enki safe to leave alone with a board and a repository.
Explain each one in a sentence; the human needs to know why, not just what.

**In Jira:**

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
   in the description, under an "Acceptance criteria" heading (see stage 4).
7. **The Automation rules** that wake Enki: card ready, card assigned, new
   comment, mentioned, stop and sweep (see `docs/factory/JIRA-TRIGGERS.md`).

**In the repository:**

8. **The default branch takes only reviewed, tested work.** A pull request, at
   least one human approval given after the last push, and the repository's own
   tests as required checks. Nothing, the App included, may bypass that. This is
   the gate on everything Enki writes.
9. **`card/*` branches belong to the App.** Only it can create, push to or
   delete them, so no person pushes onto a branch mid-turn and nothing else can
   pose as Enki.
10. **The App gets exactly the permissions in SETUP.md, Checkpoint A**, on this
    repository only. The workflows' own `GITHUB_TOKEN` is read-only, and Actions
    can't approve pull requests, or Enki could approve its own work.
11. **Enki's commits pass the repository's own gates.** Hooks, lint, coverage
    and the golden path's checks run on Enki's commits as on anyone's. A commit
    they refuse is an outcome Enki reports on the card, not something it gets
    round.
12. **Every PR gets its own preview on Azure Container Apps.** Required, not
    optional: reviewers judge Enki's work on a running site. A repository still
    on capped preview environments, such as Static Web Apps, moves to Container
    Apps. Where the app needs its own data per preview, such as a Supabase
    branch, the preview gets it.

### The options for the space

| Option                                      | When it fits                                                                 | What changes                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. The whole space runs on Enki's workflow** | A new space, or a team happy to adopt the ten statuses for everything. | Every work type uses the Enki workflow. Existing cards end up in the new statuses, by renaming or moving.                                       |
| **B. Enki gets its own work type**          | An established company-managed space whose other work must keep its own workflow. | A work type, such as "Enki task", is added to the space. Only that type uses the Enki workflow. The board shows Enki's columns beside the existing ones. |
| **C. Enki gets its own board in a new space** | The team wants Enki at arm's length, or the workflow is shared with other spaces. | Nothing in the existing space changes. People raise cards in the new space.                                                             |

Option B has only been proven on company-managed spaces. In a team-managed
space, choose between A and C.

### What happens to the existing cards

Under option A, every card in the space ends up in one of the ten statuses.
Tell the human plainly what that means:

- **Prefer renaming to moving, in a team-managed space.** Where every card in an
  old status should land in the same new one, rename the old status instead
  (To Do → Backlog, In Progress → Building, In Review → In review). The cards
  don't move, nobody is notified, and the status keeps its id. Only the label
  changes.
- **Cards that do move keep everything else.** Each keeps its comments,
  history, assignee, links and fields. Each move adds a line to the card's
  history and notifies its watchers.
- **A card already in a status with the same name stays put**, such as a card
  in Done when the space already has a Done status.
- **Old statuses that are neither renamed nor kept stop being used.** In a
  team-managed space they stay in the workflow, because Jira's API won't remove
  them, but they're empty, no one can move a card into them, and they're left
  off the board. In a company-managed space they go with the old workflow.
- **Nothing is assigned to Enki by the change.** A card becomes Enki's work only
  when a person puts it in a Ready column and assigns it to Enki, so no turn
  starts.
- **Cards in a locked status after the change stay where they are**, but people
  can no longer move them out of Designing or Building, or into Done. If cards
  people are still working on would land in Building, rename to something else
  or move them first.

Propose a mapping for every status that has cards, using stage 2's counts, and
agree it status by status. Cards Enki has no business with usually go to
Backlog, and finished ones to Done. Work in progress goes to Backlog unless the
human wants Enki to pick it up, in which case it goes to the Ready column for
its stage, still unassigned.

### The plan for the repository

Agree each gap `check-repo.sh` found, and three bigger pieces:

- **Enki's code and workflows.** A pull request that adds `factory/`, Enki's
  workflows and `enki.json`, written for this repository: its Node version,
  package manager, build, tests and gates. Use the playground's code as the
  reference, and adapt it; don't copy it across whole. Agree what happens to
  any other agents stage 2 found.
- **Previews on Container Apps.** The Dockerfile, the Azure estate
  (`infra/azure/`, adapted: its own resource group and names), and whatever the
  app needs per preview. Someone with rights on the Azure subscription runs the
  Terraform. A move off Static Web Apps also retires the old preview workflow,
  in the same PR or straight after.
- **Required checks.** Which of the repository's own checks become required on
  the default branch, if none are.

### Raise what stage 2 found

For example:

- the space is team-managed, so option B is out;
- the scheme is shared with other spaces;
- a status Enki needs exists with different capitals, such as "In Review"
  (stage 4 renames it);
- the space has no "Acceptance criteria" field Enki can read (see stage 4);
- the site has more than one field called "Acceptance criteria" (see Report
  back);
- the admin isn't a Jira admin, so the Automation rules need another route
  (stage 4, step A7);
- the repository's tests aren't required on the default branch;
- a variable Enki reads was set as a secret.

Also agree who in the team is told about "@Enki stop", and about Done being
Enki's alone.

Write the agreed plan back to the human in a few lines: the option, the ten
columns in order, the card mapping with counts, where acceptance criteria go,
the repository changes, and who is told. Get a yes before the dry run.

### The dry run

Show the human every call of stage 4 in order, with what each one creates or
changes, and how many cards each move touches. That includes the backup, the
scratch card the identity checks use, every repository setting, and the pull
requests. Apply only after they say yes.

---

## Stage 4: Apply, then prove it

Part A is the space and part B the repository. The Automation rules stay off,
and Enki takes no card, until part C.

Run the Jira calls with the Jira admin's token, except the identity checks and
the final proof, which run as the bot. If a call fails, stop and report it.
Don't retry it blindly, and don't hand the human a click-path.

## Part A: the space

### A0. Back up

Before the first write, save to `~/.config/enki/backups/<KEY>-<date>/`, with
`chmod 600` on every file:

- every card with all its fields: `GET /rest/api/3/search/jql` with
  `jql=project = <KEY> ORDER BY key`, `fields=*all` and `maxResults=100`,
  following `nextPageToken` until there is none, one card per line;
- each card's key, status id and assignee, as a sorted snapshot to compare
  against;
- the project, its statuses, the workflow (read with transitions) and the
  board's `editmodel.json`.

Check the card count matches stage 2's. Nothing here deletes a card, but the
backup is what proves it afterwards.

### A1. Check the identity

Run all four checks as the bot, on a scratch card in the space. Then delete the
scratch card. An admin often lacks the space's *Delete work items* permission
(`mypermissions` shows `DELETE_ISSUES`). If so, leave the card in Backlog and
tell the human its key.

| Check     | Call                                                                                           | Passes when                                                          |
| --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Assignable | `ADMIN GET /rest/api/3/user/assignable/search?project=<KEY>&accountId=<bot>`, then `ADMIN PUT /rest/api/3/issue/<card>/assignee {"accountId": "<bot>"}` | The bot is in the list, and the assign returns 204.               |
| Mentionable | `ADMIN POST /rest/api/3/issue/<card>/comment` with an ADF `mention` node `{type: "mention", attrs: {id: "<bot>"}}`, then read it back | The mention node survives, and the bot can see the comment from its own token. |
| Comments  | `BOT POST /rest/api/3/issue/<card>/comment`                                                    | 201, and the comment's `author.accountId` is the bot.                |
| Moves     | `BOT GET /rest/api/3/issue/<card>/transitions`, then `BOT POST` one of them                    | The transitions are listed, and the move returns 204.                |

If the bot can't see the space at all, give it access first (A8, or the role
step in A4 for a team-managed space), then rerun the checks.

If any check fails for the service account, tell the human which one failed and
what Jira said. Then go back to stage 1 for the licensed-user route. Do not work
around a failed check.

### A2. The locks, in either kind of space

Both kinds of space use the same two locks, set through the workflow API:

- **Designing and Building:** two status properties, both set to the bot's
  accountId: `{"jira.permission.transition.user": "<bot>",
  "jira.permission.assign.user": "<bot>"}`. They stop people moving a card out
  of the status, or reassigning it. People can still move a card *into* one;
  the poller releases a locked card that has no run behind it.
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
`version`: a workflow edited since the read gets a 409, not a lost edit. Two
things the read gives back that the update refuses:

- **The top-level `statuses` already lists statuses just created for the
  space**, so adding them again gets a 400, "You must use a unique status ID /
  reference". Dedupe before sending: `.statuses |= unique_by(.id)`.
- **A transition from Jira's template carries `properties."jira.i18n.title"`**
  (such as `gh.workflow.preset.todo`), which overrides its name on screen.
  Delete that property from any transition you rename, or the old name stays.

### A3. A company-managed space

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
A2. The shape below is tested. The `bootstrap/jira.sh` "Workflow" section has
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

Then set the columns (A5), record the status ids (A6) and give the bot access
(A8).

### A4. A team-managed space

A team-managed space has its own workflow, statuses and board, and Jira's API
reaches all of them. The order matters. Cards have to move before the locks go
on, and the columns have to be set after the last workflow change.

1. **Rename what the mapping keeps.** For each old status whose cards all go to
   the same new status, rename it: `PUT /rest/api/3/statuses` with
   `{"statuses": [{id, name, statusCategory, description}]}`. A bare array gets
   a 400. This is also how a status that differs only in capitals is handled:
   Jira refuses to create "In review" beside "In Review" ("Status name already
   in use"), so rename the existing one.
2. **Create the rest.** `POST /rest/api/3/statuses` with
   `{"scope": {"type": "PROJECT", "project": {"id": "<id>"}}, "statuses":
   [{"name", "statusCategory"}]}`, using the categories in A3.
3. **Add them to the workflow.** One `workflows/update` that keeps every
   existing status and transition. It adds the new statuses, a `GLOBAL`
   transition into each, and points the `INITIAL` (Create) transition at
   Backlog. No locks yet. While no status is removed, the update needs no
   status mappings. Dedupe the statuses, as A2 says.
4. **Move the cards** that the renames didn't place, following the agreed
   mapping, with the admin's transitions: `POST
   /rest/api/3/issue/<key>/transitions`. This has to happen before the locks,
   because afterwards only the bot can move cards into Done, and nobody can move
   them out of Designing or Building. Each move notifies the card's watchers;
   say so in the dry run. For many cards, `POST
   /rest/api/3/bulk/issues/transition` can do them in one go, but it has not
   been proven here.
5. **Lock, rename the transitions, and retire leftovers.** One more
   `workflows/update`. It puts on both locks from A2. It renames each renamed
   status's transition to match, deleting its i18n title (A2). And it adds the
   same `restrict-issue-transition` condition, naming the bot, to the transition
   into any template status that wasn't renamed, so no person can move a card
   into one. Jira's API won't remove a status from a team-managed workflow.
   Every mapping shape tried was refused, and `DELETE /rest/api/3/statuses`
   says the status is in use. So the leftovers stay in the workflow, empty and
   unreachable, and the next step leaves them off the board. New cards are
   created into Backlog, so none land there.
6. **Board columns, last** (A5). Every workflow update rebuilds a team-managed
   board's columns: one column per status, in Jira's own order, template
   statuses included. So the columns go on after the final workflow update.
   Tell the human that a later workflow change, made by anyone, resets them,
   and the columns PUT has to run again.
7. **The bot's access.** `POST /rest/api/3/project/<id>/role/<Member role id>`
   with `{"user": ["<bot>"]}`. The `categorisedActors` form gets a 400.
8. **Acceptance criteria.** If the space's cards already have a field called
   "Acceptance criteria" (stage 2's `editmeta`), use it. If not, the criteria go
   in the description under an "Acceptance criteria" heading. Enki reads the
   whole description, so they reach it. Don't create a field. Jira's API can
   create one and attach it to a team-managed space with
   `PUT /rest/api/3/field/association`, and its value can then be written and
   read. But no public API puts it on the space's layout, so people never see
   it.

A renamed status can take a minute to show its new name on cards, in search
results and on the board. Re-read before deciding a rename failed.

### A5. Board columns

The documented Agile API can only read columns, so this uses the endpoint Jira's
own board settings page calls. It is not in Atlassian's published API, and it
could change without notice.

Read the board first with `GET
/rest/greenhopper/1.0/rapidviewconfig/editmodel.json?rapidViewId=<id>`. Send
existing columns back by their `id`, keep the board's statistics field as it
is, and leave out every column that isn't one of the ten:

```
PUT /rest/greenhopper/1.0/rapidviewconfig/columns
{ "currentStatisticsField": {"id": "<as read, such as issueCount_ or none_>"},
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

### A6. Record the status ids

Enki finds the ten statuses by the ids in `enki.json` at the repository root, so
that renaming a column changes nothing but its label. Take them once the
statuses exist, and check them against the space:

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
3. Save a copy with the backup, and put the file in the repository with Enki's
   code (B3). Agents are never allowed to edit `enki.json`, so it only ever
   changes through a pull request a person reviews. If Enki is already in the
   repository, it goes in as its own pull request. Tell the human it has to
   merge before anyone renames a column. Until it does, Enki goes by name.

The repository's factory has to be one that reads `jira.statuses`
(`factory/src/statuses.ts`). An older one ignores it and goes by name.

### A7. The Automation rules

The six rules are in `bootstrap/jira-triggers.sh`, and
`docs/factory/JIRA-TRIGGERS.md` explains each. Whichever route builds them:

- Scope each rule to this space only.
- Name each rule after the space, such as "Enki WKB: card ready", so two spaces
  don't share rules.
- Pick statuses by id, in triggers and JQL alike (`status in (13439, 13442)`),
  so a renamed column doesn't break a rule.
- The web requests go to this repository's `poller.yml` and `stop.yml`
  dispatch endpoints, with `FACTORY_DISPATCH_PAT` as a hidden
  `Authorization: Bearer` header.
- The rules are created **off**, and stay off until part C.

**Through the API**, if the admin is a Jira admin: the Automation Rule
Management API, at
`https://api.atlassian.com/automation/public/jira/<cloudId>/rest/v1`, with the
admin's token. Scope each rule to `ari:cloud:jira:<cloudId>:project/<id>`. The
script finds the bot by searching for `JIRA_BOT_EMAIL`; check that the accountId
it prints is the one `myself` gave in stage 2.

**By hand, if the API refuses.** The Automation API is for Jira admins only, and
a space admin gets a 403 from it, though they can build the same rules in the
space's settings. Tell the human, and offer two routes: a Jira admin's token,
or they build the rules themselves from a guide you write. That guide is the
one click-path this skill allows, and only when the human chooses it. Make it
exact:

- in the words Jira's builder uses today. Since 2026 Jira calls rules *flows*:
  Space settings → Automation → **Create flow** → **Create from scratch**, then
  **Add trigger**, **Add step** for each condition and action, **Flow details**
  for the name, scope and actor, and **Turn on flow** to save;
- for each rule, its name, then each trigger, condition and action in order,
  with every value written out to copy: status names to pick, JQL with ids, the
  bot's accountId, URLs, bodies and headers;
- leave each rule off (if the builder only offers **Turn on flow**, turn the
  toggle off straight after), and don't press "Validate" on a web request,
  because it sends the request for real;
- Jira Cloud has no shared secret store for flows, so each web request
  carries its own token. Duplicating a flow saves typing, but the hidden
  token is dropped from the copy and has to be pasted again;
- if the PAT doesn't exist yet, `Bearer PENDING` in the header, replaced later.

Publish the guide as a page the human can work through, with copy buttons and
a box to tick per rule. You can't read the rules back with a space admin's
token, so go through them with the human before part C.

### A8. The bot's access in a company-managed space

Enki needs to browse the space, assign cards, move them and comment.
Check this as the bot with `GET /rest/api/3/mypermissions?projectKey=<KEY>&permissions=BROWSE_PROJECTS,ASSIGNABLE_USER,TRANSITION_ISSUES,ADD_COMMENTS,EDIT_ISSUES`.
If a permission is missing, add the bot to the project role that the
permission scheme grants it to, and tell the human which role you used. Run the
same check in a team-managed space after its role step.

### A9. Prove the space

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
- **The ids:** each id recorded in A6 is a status in the Enki workflow, under
  the name it is recorded against.
- **Nothing lost:** the space holds as many cards as the backup, and each card's
  status and assignee match the backup's snapshot, apart from the moves agreed.

## Part B: the repository

Use the human's admin login (`GH_TOKEN=$(gh auth token -u <account>)`), and work
in a scratch worktree, never in a checkout someone is using. Run `check-repo.sh`
before and after.

### B1. Settings

`bootstrap/github.sh` shows each call; make the ones `check-repo.sh` didn't
report `ok`:

- **Actions:** `PUT repos/<R>/actions/permissions/workflow` with
  `default_workflow_permissions=read` and `can_approve_pull_request_reviews=false`.
- **Secrets**, from the `.env` file, the value on stdin:
  `printf '%s' "$ANTHROPIC_API_KEY" | gh secret set ANTHROPIC_API_KEY --repo <R>`,
  the same for `JIRA_BOT_TOKEN`, and `gh secret set FACTORY_APP_KEY --repo <R>
  < "$FACTORY_APP_KEY_PATH"` for the key, byte for byte. Never `--body`, which
  puts the value in the arguments.
- **Variables:** `JIRA_BASE` (the gateway URL for a service account),
  `JIRA_BOT_EMAIL`, `JIRA_PROJECT_KEY`, `FACTORY_APP_ID`, `FACTORY_BOT_LOGIN`,
  and `FACTORY_POLL_WINDOW_SECONDS=0`. A secret of the same name that someone
  set by mistake can stay; Enki doesn't read it. Tell the human, so they can
  remove it.
- **The `preview` environment** and the three `factory:*` labels.
- **`card/*` branches:** the "factory card branches" ruleset from
  `bootstrap/github.sh`, with the App as its only bypass actor.
- **The default branch:** if it already has rules, keep them and add only what
  non-negotiable 8 needs, such as a required check. Classic branch protection
  and rulesets both apply; don't replace one with the other, and don't touch
  rulesets the organization owns. Required checks must be ones that run on
  every pull request, or every PR waits for ever.

### B2. Previews on Container Apps

Adapt `infra/azure/` to the repository: its own resource group and names, and
the variables its Terraform sets. Someone with rights on the Azure subscription
runs `apply.sh` (a plan first, then `--apply`). Add the Dockerfile the preview
image builds from, and whatever the app needs per preview, such as its own
database. Show the plan to the human before it is applied.

### B3. Enki's code and workflows

One pull request, written for this repository, that adds `factory/`, Enki's
workflows and `enki.json` with the ids from A6. It must pass the repository's
own gates, run through its hooks, with nothing bypassed. Retire what the plan
agreed to retire, such as an old preview workflow. A person reviews and merges
it. `enki.json` is denied to Enki's agents, so later changes to it come from
people too.

### B4. Prove the repository

`check-repo.sh` shows `ok` for everything, or `SEE` lines the human has
confirmed. The workflows are registered: `gh workflow list --repo <R>` shows
`poller.yml` and `stop.yml` as active.

## Part C: switch on, and the first card

1. **The PAT:** check it can reach the dispatch endpoints without dispatching:
   `GET repos/<R>/actions/workflows/poller.yml` with it returns 200, and the same
   for `stop.yml`. If the rules were built by hand with `Bearer PENDING`, the
   human puts the PAT in each one now.
2. **Turn on the six rules**, through the API or with the human.
3. **One real card:** with the human, a small card goes to Ready for design and
   is assigned to Enki. Watch it through design, review, build, the preview, the
   merge, and Done. Each step's failure has its own section in
   `docs/factory/RUNBOOK.md`.

---

## Proven

These calls were proven on scratch spaces on non-production sites, and on one
live space:

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
- **A live team-managed space with 179 cards, 12 October 2026**, run by a space
  admin who isn't a Jira admin:
  - the backup, and the before-and-after comparison;
  - renaming four template statuses into Enki's, so no card moved but the one
    agreed;
  - the update's status dedupe, and renaming transitions with their i18n titles
    removed;
  - a service account through the gateway, passing all four identity checks
    and the proof;
  - the Automation API refusing a space admin (403).

Not yet proven: Automation rules on a team-managed space, option B on a
team-managed space, the bulk transition, and part B on a repository other than
the playground.

### Report back

Tell the human what changed, with links to the board, the workflow, the rules,
the backup and the pull requests. Then:

- **Tokens:** the Jira admin's token was only for setup, and they can revoke it
  and clear `JIRA_USER` and `JIRA_TOKEN` from the `.env` file now. Keep the
  bot's token, because Enki uses it on every turn. The PAT expires: put the date
  in a calendar (`docs/factory/JIRA-TRIGGERS.md`, Rotation).
- **Acceptance criteria:** the factory finds the field by name across the whole
  site (`factory/src/gather.ts`). If the site has more than one field called
  "Acceptance criteria", it can read the wrong one and find nothing. Say so if
  stage 2 found more than one.
- **The team:** who was told about "@Enki stop" and the Done lock, and what
  happens to cards people were already working on.
