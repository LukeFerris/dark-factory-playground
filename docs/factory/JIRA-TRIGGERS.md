# Jira triggers

The factory used to find work by asking. `poller.yml` ran on a cron, and because
GitHub's cron is both coarse and unreliable, each run polled in a loop for the
length of a window and then dispatched its own successor — which kept a runner
up more or less continuously. On this repository that is free, because the
repository is public. On a private one it bills every minute of it, roughly $345
a month, per repository. That is what made the old design impossible to install
anywhere else.

Now Jira tells the factory when something has happened. Automation rules on the
project POST to `poller.yml`'s dispatch endpoint; the run does one sweep and
exits. Nothing is up between events. `bootstrap/jira-triggers.sh` creates the
rules; this document is what they are and why.

**Nothing about the poller's logic changed.** It still sweeps both *Ready for …*
columns and still runs comment triage across the four statuses in
`TRIAGE_STATUSES` (`factory/src/triage.ts:44`). It still claims a card by moving
it before dispatching, which is the only thing stopping a card reaching two
agents (`poller.yml`, the `dispatch()` function). The cron is commented out and
`FACTORY_POLL_WINDOW_SECONDS` defaults to `0`. That is the whole change.

---

## The token, and what it can actually do

A Jira Automation rule that calls GitHub has to hold a GitHub credential, because
GitHub has no unauthenticated trigger — no per-workflow URL with a capability
token in it. Every route in is an authenticated REST call. Automation has no
secret store and no crypto primitives, so it cannot mint anything: whatever it
holds is what it sends. So the question is not how to avoid storing a credential
in Jira. It is how little that credential can be allowed to do.

**A fine-grained PAT with `Actions: write` on one repository, and nothing else.**

| It can | It cannot |
| --- | --- |
| Start a workflow run | Push code |
| Cancel or re-run one | Read secrets or variables |
| Disable or enable a workflow | Modify a workflow file |
| Delete runs, their logs, artifacts and caches | Merge anything |
| | Touch any other repository |

There is no narrower permission. *Create a workflow dispatch event* requires
`Actions: write`, and `Actions: write` is all of the left-hand column.

The reason `Actions: write` is enough is that **the PAT does not give the run its
power.** It only starts the run. Once running, the poller mints its own App token
(`poller.yml`, *Mint App token*) and that is what does the work. A dispatch runs
the workflow file as it exists on the ref, so changing what a run *does* needs
`Contents: write` to push a new workflow file — which this token does not have.

That is also why this uses `POST .../actions/workflows/{id}/dispatches` rather
than `repository_dispatch`. The latter would need `Contents: write`, which is
push access, which is a completely different conversation.

Write the residual risk down plainly, because it is not zero: someone with this
token can start factory runs on this repository and cancel them. Starting a
design turn burns Anthropic credits and produces a branch and a draft PR for a
card that was not ready. It is noise with a bill attached. They can also disable
`poller.yml`, which silences the factory, and delete run logs and the
`.agent/out` transcripts uploaded as artifacts, which removes the evidence of what
a run did. Neither changes the code. It does not get code
merged — the output still faces CI, the validator's path allowlist in
`factory/src/schema.ts`, and a required human approval on `main` with an empty
`bypass_actors` list.

### Checkpoint 1 — create it

**Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token.**

| Field | Value |
| --- | --- |
| Resource owner | the account that owns the repository |
| Repository access | **Only select repositories** → this one |
| Repository permissions | **Actions: Read and write**. Nothing else. |
| Expiration | 90 days. Put the date in your calendar; see *Rotation* below. |

Metadata: read-only is granted implicitly and is fine. Grant no account
permissions at all.

The token acts as *you*, so every factory run will show as triggered by your
account rather than by a bot. That is cosmetic, but it is worth knowing before
you go looking for the cause of a run.

### Checkpoint 2 — prove the call before touching Jira

Do this from a shell first. If it does not work here it will not work from
Automation, and Automation's error reporting is worse.

```bash
curl -i -X POST \
  -H "Authorization: Bearer $FACTORY_DISPATCH_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  -d '{"ref":"main"}' \
  "https://api.github.com/repos/$GH_OWNER/$GH_REPO/actions/workflows/poller.yml/dispatches"
```

`204 No Content` is success and there is no body. A `404` here almost always
means the token cannot see the repository — the endpoint hides permission
failures as not-found — so check *Repository access* before you check anything
else. A `422` means the ref is wrong or the workflow has no `workflow_dispatch`
trigger.

Then confirm a run appeared:

```bash
gh run list --workflow poller.yml --repo "$GH_OWNER/$GH_REPO" --limit 3
```

---

## Checkpoint 3 — the rules

**Run the script.** Put the PAT in `.env` as `FACTORY_DISPATCH_PAT`, then:

```bash
bootstrap/jira-triggers.sh --dry-run   # rehearse; the PAT prints as a placeholder
bootstrap/jira-triggers.sh             # create and enable the three flows
```

It creates the three rules below through Atlassian's
[Automation Rule Management API](https://developer.atlassian.com/cloud/automation/rest/api-group-rule-management/),
scoped to this project, with the PAT in a secure header that Jira masks in the
editor and in every read. It checks the PAT can see `poller.yml` before handing
it to Jira, skips any flow that already exists by name, and leaves an existing
flow's state alone, so a flow switched off on purpose stays off. To change a
flow, delete it in Jira and re-run.

It needs `JIRA_USER` to be allowed to administer automation on the project. The
factory bot is refused (403), which is correct: an agent's account has no
business editing the rules that start agents.

The tables below are what the script creates, and the route by hand if the API
is unavailable. Atlassian has renamed things since they were first written:
projects are **spaces**, rules are **flows**, issues are **work items**, and the
page is **Space settings → Automation → Create flow**. In the trigger picker,
search rather than scroll; the Jira triggers are listed below the Automation,
Compass and Confluence groups.

All of these are **single-project rules**, which matters for more than tidiness:
single-project rules have no monthly execution limit on any paid Jira tier, and
do not count against the global/multi-project pool. Scope every rule to this
project and the volume question never arises.

Each rule's action is the same **Send web request**:

| Field | Value |
| --- | --- |
| Web request URL | `https://api.github.com/repos/<owner>/<repo>/actions/workflows/poller.yml/dispatches` |
| HTTP method | `POST` |
| Web request body | Custom data |
| Custom data | `{"ref":"main"}` |
| Headers | `Authorization: Bearer <the PAT>` · `Accept: application/vnd.github+json` · `X-GitHub-Api-Version: 2022-11-28` |
| Delay execution | **off** |

Leave *Wait for response* on while you are setting up — a 204 with an empty body
is a pass, and the rule audit log will show you the status code. It is the only
place a failed call is visible.

### Rule 1 — a card became ready

| | |
| --- | --- |
| Name | `Factory: card ready` |
| Trigger | **Work item transitioned** |
| From status | *(blank — any)* |
| To status | `Ready for design`, `Ready for build` |
| Action | Send web request |

Both columns in one rule. The poller sweeps both anyway, so there is nothing to
be gained by telling it which one moved.

### Rule 2 — somebody commented

| | |
| --- | --- |
| Name | `Factory: new comment` |
| Trigger | **Work item commented** |
| Condition | **Work item fields condition** (formerly Issue fields condition) → Status → *is one of* → `Design review`, `Blocked on architect`, `In review`, `Blocked on engineer` |
| Condition | **User condition** → `{{initiator}}` → *is not* → the factory bot account |
| Action | Send web request |

Both conditions are there to stop paying for runs that cannot do anything.

The status condition mirrors `TRIAGE_STATUSES` (`factory/src/triage.ts:44`) —
those are the only four statuses triage looks at, so a comment anywhere else
would start a run that sweeps and finds nothing. `poller.test.ts` asserts that
the row above, and the `TRIAGE_STATUSES` line in `bootstrap/jira-triggers.sh`,
list exactly those four, so changing the constant fails CI until both are
changed with it. **The live flow in Jira is not checked by anything.** After a
change, delete *Factory: new comment* in Jira and re-run the script to recreate
it from the current list.

The script writes this condition as a JQL condition (`status in (…)`) and the
initiator check as a smart-value comparison (`{{initiator.accountId}}` is not the
bot's account id). That is the same test as the two conditions in the table,
expressed in forms the API takes as plain values.

The initiator condition excludes the factory's own comments. It cannot loop
without it — triage only acts on comments newer than the factory's own, so a
factory comment produces a run that decides to do nothing — but it would file a
run for every comment the factory writes, which is most of them.

### Rule 3 — the backstop

| | |
| --- | --- |
| Name | `Factory: sweep` |
| Trigger | **Scheduled**, every 30 minutes (the script writes cron `0 0/30 * * * ?`) |
| JQL | `project = <KEY> AND status in ("Ready for design", "Ready for build")` |
| Action | Send web request |

A push trigger's failure mode is a dropped event, and a dropped event under the
old design was a late card whereas here it is a card that waits forever. This is
the answer to that, and it deliberately lives on the Jira side rather than as a
low-frequency GitHub cron: **when the JQL matches nothing, no action runs, so no
GitHub run is filed and nothing is billed.** A GitHub cron cannot make that
distinction — it has to start a job to find out there was no work.

It only covers the two *Ready for …* columns. A dropped comment event is not
covered, because a JQL cannot express "has a comment newer than the factory's
own" — that question is the whole of `factory triage` and it needs the factory's
own account to answer. In practice a stalled comment is visible on the board (a
card sitting in *Blocked on architect* with an answer on it) and one
`gh workflow run poller.yml` fixes it. If that turns out to happen often, widen
the JQL to all four `TRIAGE_STATUSES` and accept sweeping on a timer instead.

---

## What it costs

| | Billed minutes | Latency |
| --- | --- | --- |
| Old: continuous window | ~43,200/month | ~30s |
| Old: `*/15` cron, single pass | ~2,880/month | up to 5 hours in practice |
| **Jira triggers** | **one per board event** | **~30s** |

A run is one billed minute because GitHub rounds every job up to the minute, and
the pass itself is a few seconds — the minute goes on checkout, `npm ci` and
minting the token. So the bill is now proportional to how much the team actually
uses the board rather than to the passage of time, which is the property that
makes this installable in a private repository.

Latency is dominated by that same setup, not by the trigger. Jira fires the rule
within a second or two of the transition.

---

## Reverting

Two changes, no code:

```bash
gh variable set FACTORY_POLL_WINDOW_SECONDS --body 3000 --repo "$GH_OWNER/$GH_REPO"
```

and uncomment the `schedule:` block in `poller.yml`. Disable the Automation
rules or leave them — an extra dispatch during a window just queues behind the
run in flight and the concurrency group collapses it.

That is also the path onto a self-hosted runner. Once Actions minutes stop
costing anything, continuous polling is the cheapest option rather than the
dearest, and the whole of this document becomes optional.

---

## Rotation

The PAT expires. When it does, the factory goes silent with no error anywhere in
GitHub — the dispatch never arrives, so there is no run to fail. The only signal
is in the Jira rule audit log, on the Jira side, where nobody is looking.

This is the genuine operational weakness of the design and it is worth being
blunt about it: a credential held outside the system, with an expiry, and no
alarm. Mitigations, in order of how much they cost:

- Put the expiry date in a calendar reminder. Do this at minimum.
- Keep rule 3 (the backstop). It fails at the same moment for the same reason,
  so it is not independent — but a board that has gone quiet for half a day is
  easier to notice than one that has gone quiet for ten minutes.
- Leave the `schedule:` block ready to uncomment, which is why it is still
  there.

A GitHub App would not expire, but Automation cannot mint App tokens — signing a
JWT needs crypto primitives it does not have. That is the argument for an
Atlassian Forge app if this pattern goes further than the playground: Forge has
encrypted environment variables and a Node runtime, so it can hold a private key
and mint a one-hour token per call, and nothing long-lived sits in Jira at all.

---

## When nothing happens

Work outward from the board.

1. **Did the rule fire?** Space settings → Automation → *Audit
   log*. This is the only place a failed web request is recorded.
2. **Did it get a 204?** Anything else is the token or the URL. Re-run the curl
   from Checkpoint 2.
3. **Did a run appear?** `gh run list --workflow poller.yml --limit 5`. If the
   rule got a 204 and no run exists, check the workflow is enabled —
   `gh workflow list --all` — since a previously scheduled workflow can have
   been auto-disabled before the cron was removed.
4. **Did the run find the card?** Read the log. `none waiting in Ready for
   design` with a card sitting in that column means the JQL and the board
   disagree, which is a status-name mismatch, not a trigger problem.

The rest of the failure modes are unchanged and are in
[RUNBOOK.md](RUNBOOK.md).
