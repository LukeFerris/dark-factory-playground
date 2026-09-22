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
   | Contents | Read and write | Pushing `design/*` and `build/*` branches |
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

1. Create a free Jira Cloud site if you do not have one:
   `https://<you>.atlassian.net` → `JIRA_BASE`.
2. Your Atlassian account email → `JIRA_USER`.
3. **id.atlassian.com → Security → API tokens → Create API token.** Copy it
   once → `JIRA_TOKEN`.
4. Leave `JIRA_PROJECT_KEY=DF` unless you want a different key.

You need permission to create projects, statuses and workflows on the site —
site admin on a personal site, which you will have by default.

---

## Checkpoint C — the Anthropic key

`console.anthropic.com` → API keys → Create key → `ANTHROPIC_API_KEY`.

This is the only credential the agent ever sees, and it never sees it directly:
it is set on the Agent step of a workflow and nowhere else.

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

---

## Checkpoint D — board columns

The Agile API cannot map statuses onto board columns, so this is a drag in the
UI, and it is the one thing `smoke.sh` cannot verify for you.

**Board → ⋯ → Configure board → Columns**, and arrange:

| Column | Statuses |
| --- | --- |
| Backlog | Backlog |
| Ready | Ready for design, Ready for build |
| In progress | Designing, Building |
| Review | Design review, In review |
| Blocked | Blocked on architect, Blocked on engineer |
| Done | Done |

Put every status in exactly one column. A status left in the unmapped pile
still works — the factory transitions by status name, not by column — but the
card vanishes from the board, which makes the whole thing much harder to watch.

---

## First card

```bash
bootstrap/smoke.sh --card
gh workflow run poller.yml --repo "$GH_OWNER/$GH_REPO"
gh run watch --repo "$GH_OWNER/$GH_REPO"
```

That files a real card ("greet the user by name"), moves it to *Ready for
design*, and starts a poller run immediately rather than waiting for the next
scheduled one. Within a few minutes you should have a `design/DF-1-…` branch and
a draft PR with a design document on it.

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

Review the design. Move the card to *Ready for build*. Wait for the poller. Then
grant turns by commenting on the PR until you are happy, and merge.

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

> **This path is unverified.** It is written and unit-tested but has never run
> against a live subscription. Expect the first failure to be a role assignment.
> `RUNBOOK.md`, "The preview is missing", lists the ones to expect.

You need an Azure subscription. The full walkthrough — resource group, registry,
Container Apps environment, federated credential and the nine repository
variables — is in `SELF-HOSTING.md` under "Backend: `azure` — Container Apps".
In outline:

1. Create the resource group, an ACR, and a Container Apps environment.
2. Register a federated credential for this repository, so no Azure secret is
   stored in GitHub. It needs a subject for `pull_request`, not only for `main`.
3. Grant the service principal `Contributor` on the resource group and
   `AcrPush` on the registry.
4. `gh variable set FACTORY_PREVIEW_BACKEND --body azure`, plus the eight
   `AZURE_*` variables.
5. Push to any open build PR. `build-setup.yml` runs on `synchronize`, so the
   next turn raises the preview without anything else being triggered.

Switching back is one variable: set `FACTORY_PREVIEW_BACKEND` to `ghcr`, or
unset it. Tear down any Container Apps left behind first — an app that outlives
its PR keeps billing.
