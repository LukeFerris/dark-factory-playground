# Setting the factory up

From an empty GitHub repository and no Jira site to a card that builds itself.
Budget an hour or so, most of it waiting for Jira.

Four steps need a human, because they involve credentials that can only be
issued once or UI that has no API. They are marked **Checkpoint A** to
**Checkpoint D** below, and `.env.example` marks the values each one produces.
**Checkpoint E** is optional and comes after the factory is already working.

## Before you start

| You need | Why |
| --- | --- |
| Node 22 (`.nvmrc` pins it) | The workspaces and CI both build on 22 |
| `gh`, `git`, `jq`, `curl` | The bootstrap scripts shell out to all four |
| `claude` | `npm i -g @anthropic-ai/claude-code` |
| Docker (optional) | Only to build preview images locally |
| A GitHub account you control | The App is installed on your own repository |
| That repository public, **or** GitHub Pro | Rulesets are the containment, and they need one or the other. On a free plan a private repository returns `403 Upgrade to GitHub Pro or make this repository public` for every ruleset call |
| A Jira Cloud site (Free is enough) | `https://<you>.atlassian.net` |
| An Anthropic API key | The agent's only credential |

```bash
git clone <this repo> && cd dark-factory-playground
cp .env.example .env
npm ci
bootstrap/preflight.sh
```

Preflight will fail on the checkpoint values — that is expected. It should pass
everything else. Two failures worth calling out now:

- **`gh active account`** — `gh` can hold several accounts and only one is
  active. If you are signed in as more than one, `gh auth switch -u $GH_OWNER`.
- **`gh workflow scope`** — pushing `.github/workflows/**` needs the `workflow`
  scope. Switch to the right account first, then `gh auth refresh -h
  github.com -s workflow` — `refresh` has no account flag and always acts on
  whichever account is active.

---

## Checkpoint A — the GitHub App

An App, not a personal access token. A PAT would carry your own permissions
everywhere; an App carries exactly the permissions you grant it, on exactly the
repositories you install it on, and its commits are plainly attributed to a bot.

1. **Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Name it `<your-handle>-factory`. Homepage URL can be the repository.
3. **Uncheck Webhook → Active.** There are no webhooks; the poller does the
   polling.
4. Repository permissions — grant exactly these, and nothing else:

   | Permission | Access | Used for |
   | --- | --- | --- |
   | Contents | Read and write | Pushing `card/*` branches |
   | Pull requests | Read and write | Opening and updating the draft PR |
   | Issues | Read and write | Reading and posting PR comments, labels |
   | Actions | Read and write | The poller dispatching the stage workflows |
   | Deployments | Read and write | Recording the preview Deployment |
   | Packages | Read and write | Pushing and deleting the `pr-<n>` image |
   | Metadata | Read-only | Mandatory |

   Grant nothing else. In particular **do not** grant Administration, Members,
   or anything organisation-level.
5. **Where can this App be installed?** Only on this account.
6. Create it. On the App's page:
   - note the **App ID** → `FACTORY_APP_ID`
   - **Generate a private key**, save the `.pem` to `secrets/factory-app.pem`
     → `FACTORY_APP_KEY_PATH` (`secrets/` is git-ignored; the key is shown once)
   - note the App's **slug** from its URL; the bot login is `<slug>[bot]`
     → `FACTORY_BOT_LOGIN`
7. **Install App** → your account → **Only select repositories** → this one.

> The App must not be able to push to `main`, approve, or merge. That is not set
> here — it comes from the `main protection` ruleset that `bootstrap/github.sh`
> creates with no bypass actors. Do not add one.

---

## Checkpoint B — Jira Cloud

Two accounts: yours, and the factory's. They must be different people as far as
Jira is concerned, and the reason is at the end of this section.

### Your account — for the bootstrap scripts only

1. Create a free Jira Cloud site if you do not have one:
   `https://<you>.atlassian.net` → `JIRA_BASE`.
2. Your Atlassian account email → `JIRA_USER`.
3. **id.atlassian.com → Security → API tokens → Create API token.** Copy it
   once → `JIRA_TOKEN`.
4. Leave `JIRA_PROJECT_KEY=DF` unless you want a different key.

You need permission to create projects, statuses and workflows on the site —
site admin on a personal site, which you will have by default. These two values
stay on this machine: `bootstrap/` uses them, and `bootstrap/github.sh` never
stores them in GitHub.

### The factory's account — what the pipeline runs as

5. Make a second Atlassian account and invite it to the site as a **licensed
   user**, not an admin: **Settings → User management → Invite users**, product
   access *Jira*, role *Member*. A `+suffix` on your own address works if your
   mail provider supports it (`you+factory@example.com`).
6. Give it an obviously non-human display name — it is what appears above every
   card comment for the rest of the project's life.
7. Sign in as that account once to accept the invitation, then create an API
   token for it the same way → `JIRA_BOT_EMAIL` and `JIRA_BOT_TOKEN`.

A plain licensed user gets exactly what the factory needs from the project's
default permission scheme — browse, comment, transition, edit, create — and
nothing more. *Delete Issues* and *Administer Projects* belong to a project role
it is not in, so the factory cannot remove a card or reconfigure the project
even if a turn goes badly wrong. Do not "fix" that by adding it to the
Administrators role.

> **Why it cannot be your account.** The factory reacts to comments on cards —
> that is how a blocked card comes back, and how a change of mind on a card in
> review starts a turn. The test it uses is whether the newest comment is *not*
> the factory's, which is only a meaningful question if the factory is a
> distinct author. Run the factory as yourself and every card reads as
> permanently answered by itself, with no error to explain it.
> `bootstrap/github.sh` refuses to run if `JIRA_BOT_EMAIL` equals `JIRA_USER`.

---

## Checkpoint C — the Anthropic key

`console.anthropic.com` → API keys → Create key → `ANTHROPIC_API_KEY`.

This is the only credential the agent ever sees, and it never sees it directly:
it is set on the Agent step of a workflow and nowhere else.

The poller holds it too, for a different job: comment triage makes one
classifier call per new comment on a card. That is not an agent — no tools, no
repository, one of three words back — and `SECURITY.md` says why the
distinction matters. The model is `claude-haiku-4-5-20251001` unless you set the
optional `FACTORY_TRIAGE_MODEL` repository variable.

---

## Run the bootstrap

With `.env` filled in:

```bash
bootstrap/preflight.sh          # should now pass with no warnings that matter

git push -u origin main         # must come first — see below

bootstrap/github.sh --dry-run   # read what it intends to do
bootstrap/github.sh

bootstrap/jira.sh --dry-run     # read the payloads; Jira's API is fussy
bootstrap/jira.sh

bootstrap/smoke.sh
```

**Push before `github.sh`, not after.** `github.sh` creates the `main
protection` ruleset, which requires a pull request and a green `ci` with no
bypass actors — including you. On an empty repository that can never be
satisfied: `ci` cannot run until the workflows are on the default branch, and
they cannot get there without this push. Run it the other way round and GitHub
rejects the push with *Required status check "ci" is expected*. If you have
already created the ruleset, set its enforcement to `disabled`, push, and set it
back to `active`:

```bash
RS=$(gh api "repos/$GH_OWNER/$GH_REPO/rulesets" --jq '.[]|select(.name=="main protection")|.id')
gh api -X PUT "repos/$GH_OWNER/$GH_REPO/rulesets/$RS" -f enforcement=disabled --silent
git push -u origin main
gh api -X PUT "repos/$GH_OWNER/$GH_REPO/rulesets/$RS" -f enforcement=active --silent
```

Check it went back on before you go further — an unenforced `main protection` is
the one failure mode this whole design exists to prevent:

```bash
gh api "repos/$GH_OWNER/$GH_REPO/rulesets/$RS" --jq '{enforcement, bypass: (.bypass_actors|length)}'
# want: {"enforcement":"active","bypass":0}
```

`smoke.sh` reports the workflows as unregistered until the push has landed on
the default branch. Every other check should pass on the first run.

One thing it cannot check: secrets are write-only, so a ✓ beside
`FACTORY_APP_KEY` means a secret of that name exists, not that it holds a key.
The first poller run is what proves it — a failure at *Mint App token* is in
`RUNBOOK.md`.

---

## Checkpoint D — board columns

`bootstrap/jira.sh` does this now. It is still a checkpoint because it is the
step most likely to need a human: it goes through an undocumented endpoint, and
if Atlassian changes it the script warns and carries on rather than failing.

Ten columns, one status each, in the order a card travels:

| # | Column | # | Column |
| --- | --- | --- | --- |
| 1 | Backlog | 6 | Ready for build |
| 2 | Ready for design | 7 | Building |
| 3 | Designing | 8 | Blocked on engineer |
| 4 | Blocked on architect | 9 | In review |
| 5 | Design review | 10 | Done |

Each *Blocked on …* sits just before the review status it shares a parent with:
both are exits from the same running state, and the blocked one goes backwards.

`smoke.sh` checks all ten are mapped. A status left unmapped still works — the
factory transitions by name, never by column — but its cards vanish from the
board, which is the worst way to find out.

**Column 1 is the backlog, not a board column.** With the Kanban backlog
enabled, *Backlog* cards appear in the **Backlog** tab rather than on the board.
That suits a status the factory never touches.

If the script warned instead, do it by hand at **Board → ⋯ → Configure board →
Columns**. Collapsing the ten into fewer columns is fine — group each stage with
its twin (*Ready for design* with *Ready for build*, and so on) so both laps
look the same — but keep **Done** rightmost, because Jira's completion rule
follows the last column.

### Two boards

The `kanban-classic` template creates its own board, named `<PROJECT> board`,
with none of the factory's statuses mapped. `bootstrap/jira.sh` creates a second
one called **Dark Factory** and warns about the first, which is the one the
sidebar links to by default. Delete it so you cannot land on it by mistake:

```bash
curl -u "$JIRA_USER:$JIRA_TOKEN" -X DELETE "$JIRA_BASE/rest/agile/1.0/board/<id>"
```

Check the name before you delete — `smoke.sh` names the stray board, and the
factory's is always *Dark Factory*.

---

## First card

```bash
bootstrap/smoke.sh --card
gh workflow run poller.yml --repo "$GH_OWNER/$GH_REPO" -f window_seconds=0
bootstrap/trace.sh
```

That files a real card ("greet the user by name"), moves it to *Ready for
design*, and starts a single poll immediately rather than waiting for the next
scheduled one — `window_seconds=0` means one pass, so the run ends instead of
idling for the rest of its window. Within a few minutes you should have a
`card/DF-1-…` branch and a pull request with a design document on it. That
branch and that PR are the card's for the rest of its life — the build turns
commit to the same one. The PR is opened as a draft and comes out of draft on
the turn the agent says the work is ready to look at, so a PR still marked draft
is one the factory has not finished with.

`bootstrap/trace.sh` is the thing to watch it with. It shows every card's status
next to the last few Actions runs, refreshing every five seconds, and marks the
cards that are waiting on **you**. It is read-only and runs from anywhere, so
leave it in a second terminal. `--once` prints a single snapshot.

Watch for the card reaching *Designing* **before** the design run appears. That
is not a race — the poller claims a card and then dispatches, so a failed
dispatch leaves it visibly stuck rather than handing it to two agents.

A running poller picks a card up within `FACTORY_POLL_INTERVAL_SECONDS`
(default 30). The `schedule:` only decides how soon a run starts after the last
one ended — GitHub's minimum there is five minutes, and it is often slower. Two
repository variables tune it:

```bash
gh variable set FACTORY_POLL_INTERVAL_SECONDS --body 30    # seconds between passes
gh variable set FACTORY_POLL_WINDOW_SECONDS   --body 270   # how long a run polls
```

Leaving the window just under the cron interval keeps a runner busy more or less
continuously. That is free on a public repository and fine for a playground, but
it is real compute for something that is idle most of the time. Set the window
to `0` to go back to one pass per tick, and dispatch the poller by hand when you
want a card picked up now.

The card may stop at *Blocked on architect* first, with the agent's questions in
one comment. Answer them by replying on the card — a single comment, in your own
words. Nothing else is needed: the poller notices that the newest comment is not
the factory's, reads it, brings the card back to *Designing*, and the next turn
folds your answers into the same design document. That repeats until a turn has
nothing left to ask, which is when the card reaches *Design review*.

Review the design. The card comment is written to be read on its own: a summary,
the context, the acceptance criteria, and under "Proving it" the exact browser
steps for each one.

Read the criteria first and the steps second. The criteria are the contract the
build has to satisfy, so a criterion you disagree with is the cheapest thing in
the whole pipeline to fix — it is a comment on a card, before any code exists,
and it is what the build agent is handed. The steps are only how you check; if
the steps look wrong but the criterion is right, say that, because the build
turn is allowed to correct them and will.

After a build turn the same section is a claim about working software rather
than a contract, and the preview link sits right above it.

Move the card to *Ready for build*. Wait for the poller. Then grant turns by
commenting on the PR until you are happy, and merge.

You can also just say what you want on the card, from any status the factory
left it in. Triage reads the comment, decides whether it is design work, build
work or neither, moves the card and says on it why. Most comments are neither,
and triage stays silent about those — the reasoning is in the poller's log.

`STATE-MACHINE.md` describes each status and who moves it. `RUNBOOK.md` covers
what to do when one of these steps does not do what it says here.

---

## Checkpoint E — real preview environments (optional)

Out of the box the preview is a stub: an image per PR, and nothing serving it.
That is enough to watch the factory work. To get a real running site per pull
request, on its own HTTPS URL, switch the backend to Azure Container Apps.

**Do this after Checkpoint D, not instead of it.** Get a card through the loop
first; a broken preview is much easier to diagnose when everything else is known
good.

> **Verified, once.** The Terraform has been applied against a live
> subscription and re-plans clean, and one pull request has come up as a real
> site on its own HTTPS URL. Teardown has not run yet, and the one preview was
> a re-run rather than a clean first attempt. `RUNBOOK.md`, "The preview is
> missing", lists the failures to expect.

You need an Azure subscription. Everything else is Terraform, in `infra/azure/`:
the resource group, registry, Container Apps environment, the pull identity, the
app registration and its two federated credentials, and all ten repository
variables — each set from the resource it was just read off, so none of them can
drift from what they name.

```bash
az login
infra/azure/apply.sh            # plan: shows what it would do, changes nothing
infra/azure/apply.sh --apply
```

Read the plan before you approve it. Then push to any open build PR:
`build-setup.yml` runs on `synchronize`, so the next turn raises the preview
without anything else being triggered.

`infra/azure/README.md` explains what it builds and why, in particular why
previews pull with a user-assigned identity rather than asking Azure to create
one per app — that choice is what keeps CI from needing the power to grant
roles.

Switching back is one variable: set `FACTORY_PREVIEW_BACKEND` to `ghcr`, or
unset it. Terraform owns that variable, so the change shows as drift on the next
plan — which is the point. `infra/azure/apply.sh --destroy` is the way to mean
it permanently, and it removes the variables too, returning the factory to the
stub rather than breaking it. Either way, close the open build PRs and let
`build-teardown.yml` remove their previews first — an app that outlives its PR
keeps billing.
