# Factory changelog

Corrections to the build plan, and changes to the factory's own machinery. When
an API detail in the plan turns out to be wrong, the fix goes in the code and
the reason goes here — not into a silent workaround.

Application changes made by build agents are not recorded here; they are in the
PRs and in each card's `docs/design/<KEY>/build-log.md`.

## 2026-09-25

### The factory ships

Asked what happens when a card is dragged to **Done**, went to read the code,
and the answer was: nothing. Not "nothing much" — the poller looks at two
columns and neither is Done, triage's docstring says outright that *"a card in
Backlog or Done is not the factory's problem"*, and `grep -rni production`
over the whole repository returned no matches at all.

Which exposed the bigger hole behind it. On merge, `ci.yml` ran the tests and
`build-teardown.yml` destroyed the preview the card had been reviewed on, and
**nothing replaced it**. The end state of a card was code on `main`, running
nowhere. The factory could design, build, preview and review software and had
never shipped any. The two halves of "finished" were also unconnected: you
could merge without the card moving, or move the card with nothing merged.

New `production.yml`, on `pull_request: closed`:

1. gated on `merged == true`, a `card/` branch, and the azure backend
2. `factory production-up <merge-sha>` — builds the merge commit in ACR,
   deploys `df-production`, blocks until the URL answers
3. `factory ship <pr> --url …` — comments the live URL on the card and moves
   it to **Done**

Step 3 only runs if step 2 succeeded, which is ADR 0003's rule moved one
column right: the card did not say *In review* before there was something to
review, and it does not say *Done* before the thing is live.

Production is the same Container App as a preview in every respect that could
make it a different artefact — same registry, environment, managed identity
and Dockerfile. Two differences on purpose: `min-replicas: 1`, so it never
sleeps and needs no launcher, and an image tagged `main-<sha>` rather than
`pr-<n>`. The tag is not cosmetic: `az containerapp update --image` only makes
a new revision when the *reference* changes, so a fixed tag like `latest`
would push new bytes and leave the old revision serving.

Things worth knowing:

- **`pull_request: closed`, not `push: main`.** A merge fires both,
  concurrently, and only one can own the ordering. The pull request carries
  the card key in two places; a bare push would have to ask the API which PR a
  commit came from. And the main ruleset forbids direct pushes, so nothing is
  missed by not listening for them.
- **A `factory-production` concurrency group.** Two merges close together
  would collide on one Container App and Azure would reject the second with
  `ContainerAppOperationInProgress` — which is not a guess, it is how the old
  `pull_request`-triggered preview died when it raced a turn on PR #20.
  `cancel-in-progress: false`, because the loser is a commit that still has to
  reach production.
- **No new Azure credential.** A `pull_request` event presents
  `repo:<slug>:pull_request`, which `identity.tf` already provisions for
  teardown.
- **Scale is create-time only.** `upsertApp` sets the image on the update path
  and nothing else, so editing the replica constants will not move an app that
  already exists. Unlike the preview cooldown, which is reapplied every turn
  precisely so it converges.
- **Production is azure-only.** The `ghcr` stub pushes an image nobody serves;
  closing a card on the strength of a package page would be a lie. The
  workflow skips and the card stays in review.

And **Done became a status nobody can fake**: a Jira transition condition
restricts it to the bot account. A condition rather than a permission because
it *hides* the transition — so it vanishes from the board, and
`factory jira-transition` (which resolves by destination first) reports
`has no transition to "Done"` rather than a bare 403. Conditions bind project
admins too, so there is deliberately no manual override; ADR 0004 argues why,
and what to do if that turns out to be wrong.

That condition is the one part of this that `bootstrap/` cannot do. The bot is
deliberately not a project administrator — asking Jira for `/project/DF/role`
as the bot returns *"You cannot edit the configuration of this project"* —
which is the same separation that stops it deleting its own cards, and it
cuts both ways: the account the condition protects cannot install the
condition. It is four clicks in a browser, written up as *Locking Done to the
factory* in `SETUP.md`. It also needs a **company-managed** project; team-
managed ones have no transition conditions at all. `bootstrap/jira.sh` already
creates the right kind, and helpfully gives every status a single *global*
transition in, so there is exactly one transition into *Done* to guard.

Still unproven: no build PR has ever been closed in this repository, so
`build-teardown.yml` has never run either. The first card merged after this
lands exercises both for the first time, at once.

### The card no longer says "come and look" before there is anything to see

DF-5's preview came up, worked, and was nowhere in Jira. Chased it and found
it was not a glitch but the ordering, which had been wrong since the first
card and had simply never been looked at directly:

1. `publish` pushes the branch, opens the PR, applies `factory:active`
2. `report` comments on Jira and moves the card to **In review**
3. …the label event fires…
4. `build-setup.yml` starts, builds an image, waits for a container

So `report` read `meta.preview_url` at step 2, before anything had written
one. Turn 1's Jira comment could not carry a preview link — not sometimes,
ever. Confirmed on DF-4: PR #16's factory block has the URL, none of DF-4's
Jira comments do.

The link was the symptom. **In review** is not a status, it is an instruction
to a human to go and look, and the card was sending it minutes before the
thing existed. Appending the link to the Jira comment once the deploy finished
would have made the card eventually correct; it needs to be correct when it is
read.

`build-start.yml` and `build-turn.yml` each gained a `preview` job:

| Job | Holds | Does |
| --- | --- | --- |
| `turn` | `contents: read` | Agent, validate, publish, upload `.agent/` |
| `preview` | `packages`/`deployments`/`id-token`/`pull-requests` write | Restore the artifact, deploy, wait for a 200, **then** report |

The thing that makes this cheap is that **a job carries its own
`permissions:` block**. Deployment was a separate workflow purely to keep
registry and Azure credentials out of the agent's reach; a second job enforces
that identically and gets `needs:`, job outputs and same-run artifact passing
thrown in. Nothing about the credential boundary is weaker — see ADR 0003 and
`SECURITY.md`.

`build-setup.yml` loses both `pull_request` triggers and becomes the manual
retry: the thing you run when a `preview` job failed and the fix is "deploy
again", not "run the turn again". New `kickoff` input, off by default, because
turn 1 now posts the kickoff comment itself.

Four things worth knowing:

- **`if: always()` on the preview job was a bug I wrote and caught.** A job
  whose `if:` rejects it is *skipped*, and `always()` treats skipped as reason
  to run. build-turn's four comment guards live on the `turn` job, so a
  comment from the bot would skip the agent and then cheerfully report on a
  turn that never happened. It is
  `!cancelled() && needs.turn.result != 'skipped'` in both files.
- **The OIDC subject changed shape and nobody had to do anything.** Previews
  used to deploy on `pull_request` events; they now deploy from
  `workflow_dispatch` and `issue_comment`, which Actions runs against the
  default branch and which therefore present `…:ref:refs/heads/main`. That
  federated credential already existed as the retry path. The two subjects
  swapped which is the common case; `pull_request` is now only
  `build-teardown.yml`.
- **`upload-artifact@v4` roots the artifact at the least common ancestor of
  its search paths.** With `.agent/in/` and `.agent/out/` that is `.agent`, so
  entries are `in/…` and `out/…` and `download-artifact` with `path: .agent`
  puts them back where `readMeta()` looks. No code changed for this to work:
  `report` reads `meta.json` and `result.json` off disk, and `preview-up`
  already wrote the URL into whatever `meta.json` it found.
- **A push to a card branch by hand no longer redeploys.** That was
  `synchronize`, and it is gone. Run `build-setup.yml`. In practice someone
  pushing to a card branch was going to check the result themselves anyway.

The cost, stated plainly: a turn's wall-clock now includes the image build,
because reporting waits on it. That is not avoidable. To say "there is
something to look at" you have to wait until there is.

### A preview link that works the moment it is clicked

The first real preview came up and took 30-40 seconds to answer, which is long
enough that the reasonable conclusion is "this is broken". Measured properly it
is worse than it looks, and the shape of the problem matters: Container Apps
does not *refuse* a request to an app scaled to zero, it holds it. DNS 16ms,
connect 44ms, TLS 81ms — then 22.4 seconds of silence, then a 200. Warm, the
same request answers in 97ms.

That rules out the obvious fix. A loading page cannot be served by the preview,
because the preview is the thing that is asleep. So this is three changes, each
covering what the one before it cannot:

- **`preview-up` waits for the app to answer before it returns.** The cold
  start is spent in CI, where nobody is watching, so the app is already hot
  when the kickoff comment lands. It closes a second hole too, which had gone
  unnoticed: this is the first check in the pipeline that the URL being
  published serves anything at all. A container that never answers now fails
  the job instead of being posted as a confident link. Budget is three
  minutes; any non-5xx answer counts as awake, because the question is whether
  the container is up, not whether the app is right.
- **The scale-to-zero cooldown goes from 300s to an hour**, via
  `AZURE_PREVIEW_COOLDOWN_SECONDS`. Azure's default is shorter than the gap
  between the "build finished" notification and somebody actually clicking, so
  the app being warmed had usually gone cold again by the time it mattered. As
  of az 2.84.0 no `containerapp` command exposes the property at all; it is
  reachable only through `az resource update --set
  properties.template.scale.cooldownPeriod=…`, which takes effect in place and
  creates no new revision. At Azure's published uksouth rate an idle 0.25 vCPU
  / 0.5 GiB replica is $0.0108/hour, so an hour of warmth per build turn costs
  about a penny — and it still reaches zero on its own, so an open PR nobody
  looks at bills nothing.
- **A launcher page covers everything left over** — the person who comes back
  tomorrow. `infra/azure/launcher.tf` puts a static site on an Azure Storage
  account in the same resource group: always awake, no compute, no deployment
  token, and still inside the one group that `az group delete` removes.
  Given `?u=<preview url>` it renders instantly, explains that previews sleep,
  counts the seconds, and forwards the moment the app answers. It refuses any
  redirect target outside `*.azurecontainerapps.io`, both in the page and in
  `launcherFor()`, so it cannot be turned into an open redirect.

The split that keeps this honest: **only links a human clicks go through the
launcher** — the kickoff comment, the Jira report, the PR's "View deployment"
button. `PREVIEW_URL` and the factory block keep the raw app URL, because the
agent's build turn curls it to check the site is serving, and a loading page
would answer 200 whether or not there was anything behind it. That is exactly
the trap the `ghcr` stub already falls into by pointing at a package page.

One honest cost: creating a storage account puts its access keys in the local
Terraform state, so the state is no longer secret-free. The key can write one
public HTML file in one `$web` container and nothing else. The alternative —
keys disabled, Entra data-plane role — needs a role assignment created in the
same apply that uses it, and propagation would make the first apply fail.

### Nothing was carrying the preview URL

DF-4 was the first card to run the whole pipeline, and it ended with the
kickoff step failing on `.agent/in/meta.json is missing`. Pulling on that
found four faults in a row, all on the path a preview URL has to travel from
the runner that raises it to the people and agents who need it. Each one
failed silently, which is why a pipeline that had "worked" had never once
delivered a preview link.

- **`kickoff` read meta.json, which cannot exist where it runs.** `factory
  gather` writes that file during a build turn in build-start.yml; kickoff
  runs in build-setup.yml — a different workflow, a different runner, a fresh
  checkout, and `.agent/` is gitignored. Not a flake: the kickoff comment has
  never been posted, on any card. It now takes the card key and the preview
  URL off the pull request, falling back to the `card/<KEY>-` branch name when
  the body has been rewritten by hand.
- **`parseFactoryBlock` found the prose instead of the block.** It searched
  for the bare `<!-- factory` marker, and the paragraph the factory itself
  writes above the block quotes it — "the `<!-- factory … -->` block below is
  machine-read". So it parsed that sentence as JSON, failed, and returned
  null. Downstream, `preview-up` decided there was no block and declined to
  record the URL; on a second turn `upsertFactoryBlock` would have rewritten
  from the middle of the sentence and eaten the paragraph. Both markers now
  only count on a line of their own, and the last pair wins. Verified against
  PR #16's real body: the old code returns null on it.
- **`gather` hard-coded `preview_url: null`.** `PREVIEW_URL` has therefore
  been empty in every build turn there has ever been — the agent is told to
  open the running site and given nowhere to look. The build agent on DF-4
  said as much in its own summary and nobody had read it as a bug. It now
  reads the URL off the PR's factory block, which is the whole reason
  `preview-up` writes it there.
- **build-setup.yml had no `pull-requests: write`.** The body write would have
  started failing the moment the parser began finding the block. Nothing had
  ever got that far, so the missing scope was invisible.

`preview-up` now emits a warning when there is no readable block rather than
skipping in silence. A preview URL that reaches nobody is worth more noise
than that.

## 2026-09-24

### The preview estate is Terraform, and CI cannot hand out roles

The `azure` backend was written against a setup recipe: a dozen `az` commands
and nine `gh variable set` lines in `SELF-HOSTING.md`. Nobody had run it. Two
problems with leaving it that way — a recipe drifts from the code it configures
with nothing to catch it, and `AZURE_CLIENT_ID` being a number a human retyped
is exactly the kind of thing that is wrong for a week before anyone notices.

**Done:** `infra/azure/` provisions the whole estate, and the same apply sets
all ten repository variables, each read off the resource Terraform just made.

- **The pull identity changed, and that is the substantive part.**
  `--registry-identity system` asks Azure to create each preview app's own
  identity and grant it `AcrPull` at create time. Granting a role is a role
  assignment, so the CI principal must hold **User Access Administrator** on
  the group — the power to grant itself anything else there too. For a pipeline
  whose entire argument is that no step holds more than it needs, that is the
  wrong trade. Terraform creates one user-assigned identity, grants it `AcrPull`
  once, and passes its resource id as `AZURE_PREVIEW_IDENTITY`. CI is left with
  `Contributor` on one resource group and `Managed Identity Operator` on one
  identity, neither of which can create a role assignment.
- **`azureConfig()` gained `identity`, defaulting to `system`.** Unset, the
  broader-permission path still works exactly as before; `deployPreview` only
  adds `--user-assigned` when there is something to attach.
- **Two federated credentials, not one.** Entra matches the subject exactly and
  Actions presents two shapes here: `pull_request` for both preview workflows,
  and `ref:refs/heads/main` for the `workflow_dispatch` retry. The original
  notes described only the second, which would have failed on every real
  preview. Note the `pull_request` subject names no branch — that is how GitHub
  mints it.
- **`Contributor` on the group is enough for `az acr build`.** ACR Tasks wants
  Contributor on the registry, which is inherited. The separate `AcrPush`
  assignment the notes called for is redundant.
- **The registry suffix is `substr(sha1(subscription_id), 0, 8)`, not
  `random_string`.** ACR names are globally unique and hyphen-free, so one is
  needed; deriving it deterministically means a rebuilt state produces the same
  name. A new name would orphan every image in the old registry.
- **State is local and gitignored; the lock file is committed.** One operator,
  no bootstrap chicken-and-egg. The state names the app registration and the
  identity but holds no secret — with OIDC there is none to hold. Pinning the
  providers matters more: an unpinned provider changes what `apply` does with
  nobody watching.
- **`apply.sh` defaults to `plan`, and neither `--apply` nor `--destroy` passes
  `-auto-approve`.** It creates billable resources and, on destroy, deletes a
  registry full of images. Neither should happen because a script was run with
  a typo in it. It reads `.env` with `awk` rather than sourcing it, for the
  reason sourcing a data file is always wrong.

**Applied.** 22 resources in `rg-factory-preview`, and a second plan comes back
clean. Four things only running it could have found:

- **`az account show` never calls Azure.** It reads the local token cache, so
  `apply.sh`'s sign-in check described a session whose refresh token had
  expired three months earlier as healthy — and the comment above it claimed
  the opposite. `az account get-access-token` is the call that round-trips.
- **`gh repo view` succeeds against any public repository**, so the script's
  "can you reach the repo" check passed on a machine signed in as an account
  with no write access, and would have failed mid-apply when the provider tried
  to write a variable. It asks about admin now, which is what setting a
  repository variable actually needs.
- **Azure attaches a `Consumption` workload profile to a Container Apps
  environment whether or not you declare one.** The config declared none, so
  every subsequent plan proposed deleting it. Declared explicitly: a plan that
  is never empty is a plan nobody reads, and real drift then hides in the
  noise.
- **GitHub mints an immutable OIDC subject, and the entry above got the prefix
  wrong.** It has the event shapes right: `pull_request` and
  `ref:refs/heads/main`. But new repositories default to
  `use_immutable_subject`, so the subject is
  `repo:<owner>@<owner_id>/<repo>@<repo_id>:<event>` rather than
  `repo:<owner>/<repo>:<event>`, and Entra matches it as an exact string —
  every sign-in failed with `AADSTS700213` until a real token showed what was
  being presented. `identity.tf` reads both ids from GitHub. The immutable
  form is also the better one: a repository name is re-registrable, so trust
  written against a name follows whoever claims it next; the ids are not.

**A preview is real.** PR #16 came up at
`https://df-preview-pr-16.redbush-3ff4fb61.uksouth.azurecontainerapps.io`,
HTTP 200, serving the bundle the build turn produced. Caveat: that was a
re-run of the job after the subject fix, so the path has not yet succeeded on
a first attempt from a clean `synchronize`.

## 2026-09-23

### A comment is an instruction, and only a model can read which one

**Previously, same day:** the entry below closed the design question loop with
`factory jira-answered "Blocked on architect"` — *the newest comment on this
card is not ours, therefore send it back to Designing*. That works, but only
because *Blocked on architect* means one thing. It does not generalise: the
factory also leaves cards in *Design review*, *In review* and *Blocked on
engineer*, and a comment on any of those might be a new requirement, a bug
report, a question, an approval, or "thanks".

**Done:** `jira-answered` is removed. `factory triage` replaces it, and reads
comments across all four statuses where the factory has spoken last and is
waiting on a person.

- **One model call per new comment.** No tools, no repository, a fixed system
  prompt, and a forced tool-call schema whose entire output is one of `design`,
  `build`, `none` plus a sentence. `claude-haiku-4-5-20251001` by default,
  overridable with the `FACTORY_TRIAGE_MODEL` repository variable. `poller.yml`
  therefore now holds `ANTHROPIC_API_KEY`; `SECURITY.md` argues why that is not
  the thing rule 1 exists to prevent.
- **Routing does not have to match the column.** A requirement change on a card
  in *In review* is design work; a fault reported on a card in *Design review*
  is build work. Both cross over.
- **The two *Ready for …* columns are deliberately not triaged.** A human
  moving a card is already an unambiguous instruction and needs no classifier —
  and reading them here as well would hand one card to two runners on the same
  pass.
- **A comment is read exactly once.** Its id is stored on the card as a hidden
  issue property, `factory-triage`. Without it a comment judged `none` would
  stay the newest comment for the life of the card and be re-read every pass.
  `POST /rest/api/3/search/jql` takes a top-level `properties` array and returns
  them inline, so the whole board's marks arrive with the one search that was
  already being made.
- **`none` is silent.** No comment on the card; the reasoning is in the poller's
  Actions log and nowhere else. A card that collects a line of commentary every
  time somebody says "thanks" is worse than one that says nothing.
- **`build-turn.yml` gained a second entrance.** It fired only on
  `issue_comment` and derived everything from the event; it now also takes a
  `workflow_dispatch` with a key, resolving the PR by the `card/<KEY>-` branch
  prefix. The trailing hyphen is load-bearing — without it `DF-3` also matches
  `card/DF-30-…`. `factory card-pr <key>` asks the same question by hand.
- **The order inside `act()` is the design.** Move, explain, mark, dispatch —
  chosen so each failure leaves the least-bad state. The transition goes first
  because it is the step that can legitimately fail, and failing there leaves no
  mark, so the next pass retries cleanly. It is tested rather than left to the
  poller's shell.

Comment text is attacker-controlled in exactly the way task text is. The prompt
says so, `triage.test.ts` pins the paragraph that says it, and the worst a
successful injection buys is the wrong one of three words.

### The "human answers" arrow was a picture, not a feature

**Plan said:** a design turn that asks a question parks the card in *Blocked on
architect*; when a person answers, the card comes back to *Designing* and the
design continues. `STATE-MACHINE.md` drew that arrow.

**Actual:** nothing implemented it. `poller.yml` queried the two *Ready for …*
statuses and nothing else, so a blocked card stayed blocked until someone
dragged it back by hand. Two smaller things pointed the same way: the design
document template had an **Open questions** heading, which invites the agent to
write the question down and carry on — the card then says the design is ready
while the undecided part sits in a file on a branch, and the next reader is the
build agent, for whom it is far too late.

**The thing actually in the way was identity.** "A human has answered" is, in
the simplest form that works, *the newest comment on the card is not ours*.
`bootstrap/github.sh` set `JIRA_BOT_EMAIL="$JIRA_USER"`, so the factory
commented as the human it works for, and that test could never be true. Jira
comments also only carried `displayName`, which is not identity — two accounts
can share one.

**Done:**

- The factory has its own Jira account. `JIRA_BOT_EMAIL`/`JIRA_BOT_TOKEN` are a
  separate licensed user; `bootstrap/github.sh` refuses to run if they are
  `JIRA_USER`, and `preflight.sh` compares the two `accountId`s rather than the
  two email addresses. It is also strictly less privileged than the account the
  factory ran as before: a plain licensed user cannot delete an issue or
  administer the project.
- `JiraComment` carries `authorId`. `isAnswered()` compares it against
  `myAccountId()`; `report()` comments *before* it transitions, so a blocked
  card always carries the agent's question as its last word and anything newer
  is the reply.
- `factory jira-answered "<status>"` prints the keys whose questions have been
  answered, and `poller.yml` dispatches `design.yml` for each — a third source
  alongside the two `jira-search` calls, claimed and dispatched identically. A
  card whose question is still unanswered is deliberately not dispatched: it is
  not waiting on the factory, and sending it back would put the agent in front
  of its own question with nothing new to read.
- `gather` marks the factory's own comments as *yours, on an earlier turn*, and
  tells a design turn which round it is — counted from those comments, so
  nothing stores a counter.
- **No more Open questions heading.** `docs/design/README.md` says where
  questions go instead, and `.agent/design.md` forbids parking one in the
  document at all. Pinned by tests, because it is prose doing load-bearing work.

The loop now closes without anyone moving a card: ask on the card, stop, come
back when someone replies, repeat until a turn has nothing to ask. *Design
review* still means what it meant — a human moves the card on from there.

## 2026-09-22

### The design never reached the build agent

**Plan said:** a card gets a `design/KEY-<slug>` branch and then a
`build/KEY-<slug>` branch, and `.agent/build.md` tells the build agent to read
`docs/design/<KEY>/design.md` before it writes anything.

**Actual:** that file was never there. `prepare-branch` cuts a build branch from
`origin/main`; `main` contained exactly one thing under `docs/design/` — the
README. Nothing in `poller.yml`, `build-start.yml` or `build-turn.yml` merged a
design PR, and no step did it by hand. Moving DF-1 to *Ready for build* would
have started a $10 agent, told it to read the approved design, and handed it an
empty path.

The obvious repairs were all worse than they looked. Merging the design PR
automatically needs the App on `main protection`'s bypass list, and a ruleset
bypass is per-ruleset, not per-path — so buying "the factory may merge a design
document" also buys "the factory may merge anything". That is not a deploy-shaped
risk: `main` is the factory's own source, `prepare-branch` merges it into every
reused branch, and the turn then runs the branch's `.agent/*.md` and
`factory/src/*.ts`. Write access to `main` is write access to every future
turn's prompt and validator. It is also the one control the agent cannot reach
by writing files, which is worth more here than usual, because `validate` runs
from the same working tree the agent just wrote to.

**Done:** one branch per card. `card/KEY-<slug>`, opened by the design turn and
continued by every build turn, carrying a single pull request for the card's
whole life. The design document is in the build agent's tree because the stage
before it put it there. Nothing merges to `main` mid-card, nothing bypasses
anything, and the gate stays where it already was — a human moving the card to
*Ready for build*.

The stage still decides what a turn may write, so a build turn sharing a branch
with the design still cannot edit it: `docs/design/*/design.md` is outside the
build allow-list. Tested.

**The one real cost:** `validate` could no longer diff against `origin/main`. On
a shared branch that diff contains the previous stage's work, so every build
turn would have been rejected for a design document it never touched.
`prepare-branch` now records the commit the turn starts from as `base_sha`, and
`validate` measures from there. That is the more correct rule anyway — a turn
should be scoped by what *it* changed — and it fixes a latent version of the same
bug, where build turn 2 was re-validating turn 1's files.

Also moved: `publish` applied `factory:active` only when it *created* the PR. On
a shared branch the design turn creates it, so the label — which is what
`build-setup.yml` and `build-turn.yml` both trigger on — would never have been
applied and the preview would never have come up. Labels are now applied every
turn.

**Rulesets:** `factory design branches` and `factory build branches` replaced by
one `factory card branches` on `refs/heads/card/*`, same rules, App as the sole
bypass. `main protection` untouched and re-verified: `bypass_actors` empty, one
approving review, `ci` required.

### Every turn after the first ran the manual as it was when the branch was cut

**Plan said:** nothing about this, which is the point.

**Actual:** found while trying to re-run DF-2's design turn against the new
acceptance-criteria shape. It would have produced the old shape, and looked like
the change had not worked.

`prepare-branch` checks out the existing branch so a second turn updates the
same PR. Everything the turn then runs comes out of that tree: the agent's
prompt is literally `claude -p "$(cat .agent/design.md)"`, and `npm run factory`
executes `factory/src/*.ts` — the branch's copies of both. DF-2's branch was cut
at `a801ef1`, so a re-run would have used that day's manual, that day's
`ResultSchema` and that day's `validate`, two merges behind.

This is the worst shape a bug can take: the fix looks applied everywhere you
check. `main` has it, the tests pass against it, a fresh card gets it — and
every card already in flight quietly does not. Build cards are the real
exposure, because multi-turn is their normal mode: turns are granted one at a
time by a human comment, so turn 2 onward is where most build work happens, and
all of it would have run a stale prompt against a stale validator.

**Done:** a reused branch is merged up to `origin/main` before the turn starts.
A conflict aborts the merge and fails the turn with the branch named, rather
than resolving itself — the only files an agent commits are its own design or
build output, so a conflict means something needs a human, and carrying on would
run the turn against exactly the stale rules this exists to prevent.

`validate` is unaffected either way: `changedFiles` diffs `origin/main...HEAD`,
three dots, so it has always compared against the merge base and never counted
main's own commits as the agent's work. After the merge the merge base *is*
main's tip, and the diff is the branch's output alone.

**Not unit-tested.** `git()` resolves its cwd from `REPO_ROOT`, so exercising
this needs a scratch repository and a module-level refactor to point it
somewhere else. Verified instead against the real case: a clone checked out at
DF-2's branch merges main cleanly, picks up the new manual and the new
`docs/design/README.md`, and leaves `validate` seeing exactly one changed file —
`docs/design/DF-2/design.md`.

### An acceptance criterion and a click are not the same thing

**Previous entry said:** `acceptance_criteria` is a numbered list of the steps a
person takes in their browser to check the card worked.

**Actual:** that collapsed two things into one and lost the more important of
them. DF-2's card came back with five numbered clicks under the heading
"Acceptance criteria" and no statement anywhere of what "done" meant. A
reviewer could follow the steps; they could not disagree with the requirement,
because the requirement was never written down — only the procedure for
observing it. Worse, it is the procedure that ages: rename a label and every
"criterion" on the card is false, while the thing actually being asked for has
not changed at all.

**Done:** `acceptance_criteria` is now a list of `{ criterion, steps }`. The
criterion is what has to be true when the card is done — an outcome a reviewer
can argue with before any code exists. The steps are the browser actions that
prove that one criterion, and nothing else. The card comment and the PR body
render both: bulleted criteria under "Acceptance criteria", then a "Proving it"
section with each criterion in bold above its own numbered walkthrough.

They are one object rather than two parallel arrays so they cannot drift. Two
lists would need the agent to keep them in the same order and the same length,
and nothing would notice when it stopped doing so.

**The design document gets the same section**, which was the other half of the
miss. `docs/design/README.md` now requires an "Acceptance criteria" heading
between "Risks and alternatives" and "Test strategy", one subsection per
criterion with its steps numbered beneath. The card comment is what a reviewer
reads; the design document is what the *build agent* reads, and shipping the
criteria only to Jira left the stage that has to satisfy them working from
prose. The new heading also states what it is not: the test strategy is what
stops a criterion regressing, the criterion is what a person checks by hand
once, and neither substitutes for the other.

**Enforced:** `validate` already rejected a `ready_for_review` turn with an
empty `acceptance_criteria`; it now also rejects any criterion with no steps,
naming the criterion in the message. A criterion nobody can check is a wish,
and the failure mode this guards against is the easy one — writing three
confident outcomes and steps for two of them.

### The card comment never linked the pull request

**Plan said:** every Jira comment links the PR, the preview and the Actions run.

**Actual:** it linked the run. `buildComment` takes a `prUrl`, `report` takes a
`--pr-url`, and neither workflow has ever passed one — `publish` prints the URL
and sets no step output, so the flag was unreachable from the only place that
calls it. Two cards went through before anyone noticed, because a comment that
links *something* looks like a comment that links everything.

**Done:** `report` no longer waits to be told. `meta.json` holds the PR number
from the moment `publish` creates or finds it — and from turn one on a build —
so `report` builds the URL from that and `GITHUB_REPOSITORY`. `--pr-url` still
overrides, for a hand-run report.

The step-output route was the obvious fix and is the wrong one: `report` runs
on `always()`, which is exactly when `publish` may have been skipped, and a
step output that does not exist yields an empty string. Reading meta instead
means a **rejected** turn also links the PR — which is the case where a human
most needs to go and look at it.

### The card comment says how to check the work, in a browser

**Plan said:** `result.json` carries `summary`, `assumptions`, `questions`,
`artifacts` and `reason`, and `report` turns them into a Jira comment.

**Actual:** the first real card produced a comment that was accurate and
useless to a reviewer. It said what the agent decided; it did not say what to
go and do about it. Everything a human needed in order to check the work was a
click away in the design document, which is exactly the click nobody makes.

**Done:** two fields, `context` and `acceptance_criteria`, and the comment now
follows the house ticket template — Summary, Context, Acceptance criteria, then
the turn's own Questions and Assumptions. `acceptance_criteria` is a numbered
list of the steps a person takes **in their browser, with the app already
open**, to check the card worked. Not the test plan, not the diff: the steps.
The same list goes into the PR body, under the preview link.

Both manuals spell out what separates a step from an implementation note, with
worked examples of each, and the rule that makes them checkable: the last step
is an observable outcome, and a step naming a component, a file, a prop or a
selector is not a step a user can take.

**Enforced, not merely requested.** `validate` rejects a `ready_for_review`
turn whose `acceptance_criteria` is empty, the same way it already rejects a
`blocked` turn with no questions. A soft rule in a prompt is followed most of
the time, and "most of the time" is how a card ends up back where it started.
The rejection costs a re-run of a turn that had otherwise finished — that is
the price, and it is worth paying, because the alternative is a reviewer
reconstructing the steps themselves on every card. `blocked`, `question` and
`failed` turns are exempt: they have nothing to verify, and asking for steps
would only teach the agent to invent them.

The three contract rules moved out of `validate` into an exported
`contractProblems`, which is the first time any of them has been unit-tested —
they were previously unreachable without a git repository and a result file on
disk.

**Watch for:** Jira comments are ADF, not Markdown, so `*emphasis*` and
backticks reach the card as literal punctuation. The manuals now say to quote
on-screen text with `"` and write plain prose. If a future change wants real
emphasis on the card, it needs marks in `adf.ts`, not Markdown in the string.

**First live card (DF-2), and the one thing it got wrong:** the design produced
five steps, and the fourth was not a step — "the page has no text field, so
there is no name to type in" — a true and useful observation, parked where a
reader counting numbered steps will try to follow it. Both manuals now say that
every entry is an action or an observation, and that "why this cannot be
checked in a browser" belongs in `context`, with an example of the same fact
written correctly in each place.

### The poller polls in a loop, because cron cannot go below five minutes

**Plan said:** a scheduled workflow every ten minutes.

**Actual:** ten minutes is a long time to watch nothing happen, and the obvious
fix does not exist — GitHub's floor for `schedule:` is five minutes, and
scheduled runs are routinely later than their slot under load. There is no cron
that gives a thirty-second reaction.

**Done:** the cron drops to `*/5` and stops being where latency comes from. A
run now loops, polling every `FACTORY_POLL_INTERVAL_SECONDS` (default 30) until
`FACTORY_POLL_WINDOW_SECONDS` (default 270) is up, and the cron only starts the
next run. Both are repository variables and both are overridable per dispatch.
Checkout, `npm ci` and minting the App token dominate the cost of a run, so
passes after the first are nearly free.

Neither value is trusted: a non-numeric or missing one falls back to the
default, the interval is floored at 5s so a bad value cannot spin the loop, and
the window is capped at 3000s because the App token is minted once and lasts an
hour.

**The cost, stated plainly:** a window just under the cron interval means a
runner is up almost continuously. That is free on a public repository and
unremarkable for a playground, but it is a real machine kept busy for something
idle most of the time. `FACTORY_POLL_WINDOW_SECONDS=0` restores exactly the old
one-pass-per-tick behaviour.

### The board existed, worked, and was invisible

**Plan said:** create a filter and a Kanban board over it, then map the statuses
onto columns by hand, because the Agile API cannot do it.

**Actual:** three separate faults, each hidden by the next.

**The board had no project.** `POST /rest/agile/1.0/board` takes an optional
`location`, and without it Jira files the board as cross-project: it exists, it
works, and the project's sidebar never links to it. Nothing reports this.
`GET /board?projectKeyOrId=DF` returns it either way, because that matches on
the board's filter rather than its location — so the check that looked most
like a verification was the one that could not see the problem. The only tells
are `location` missing from `GET /board/{id}` and `isBoardCrossProject: true`
in the config model.

**The template made a second board.** `kanban-classic` creates `DF board`
automatically, with none of the factory's statuses mapped. That one *is*
attached to the project, so it is what the sidebar opens — meaning the board
you land on is the wrong one, and the right one is unreachable from the
project. Seven factory statuses sat in its Unmapped pile.

**The columns were never set.** Correct as documented, but the reason given was
wrong. The *documented* Agile API cannot map statuses to columns —
`/board/{id}/configuration` is read-only. The board settings UI drives
`PUT /rest/greenhopper/1.0/rapidviewconfig/columns`, which works fine, and
`PUT /rest/greenhopper/1.0/rapidviewconfig/boardLocation` attaches an existing
board to a project.

**Done:** `bootstrap/jira.sh` passes `location` on create, repairs a board that
lacks one, maps all ten columns, and warns about any other board on the
project. Both greenhopper calls go through a new `jira_try_write`, which
returns a rejection instead of calling `die` — an undocumented endpoint
changing under us should cost a minute of dragging, not abort the bootstrap.
`smoke.sh` now checks the board's location and that all ten statuses are
mapped, instead of only that a board by that name exists.

**Worth keeping in mind:** "the API returned it" is not "a person can reach it".
Both the board and its columns were present and queryable the whole time. The
check that passed was asking a question adjacent to the one that mattered.

### Every secret was set to a single hyphen

**Plan said:** `bootstrap/github.sh` sets three secrets from `.env`.

**Actual:** it set all three to the literal string `-`. `set_secret` piped the
value into `gh secret set … --body -`, borrowing a stdin convention that `gh`
does not have: `--body` takes the value verbatim, and reads standard input only
when the flag is omitted entirely. The pipe was written and then discarded.

Nothing caught it. A secret cannot be read back, so `smoke.sh` can only check
that a name exists — and all three did exist. The first symptom arrived from a
workflow days later, as `actions/create-github-app-token@v1` failing with
`Invalid keyData` / `ERR_OSSL_ASN1_NOT_ENOUGH_DATA`. That is OpenSSL's way of
saying the PEM it was handed is one byte long.

**Done:** dropped the flag so the pipe is actually read. The App key now goes
through a separate `set_secret_file`, redirected straight from the file, because
`$(cat …)` strips the trailing newline and a PEM is the one value here where the
exact bytes are not worth reasoning about. The dry run prints byte counts, which
is what makes the failure visible next time: 1 byte is obviously wrong, 1679 is
obviously a key.

**Worth keeping in mind:** this class of bug is invisible by design. Write-only
values cannot be verified through the API that stores them, so the only proof a
secret is right is a workflow using it successfully. Until a run passes, treat
every ✓ next to a secret as "a name was created".

### Two bootstrap scripts wrote log output where a caller expected JSON

Both found by running the bootstrap for the first time against a live account
and a live Jira site. Neither could have been caught by unit tests: both only
appear when a real API answers.

**`jira.sh` — `--dry-run` could not get past the first write.** `jira_write`
printed its "would call" rehearsal — the method, the path and the pretty-printed
payload — to stdout. Every caller captures that stdout and pipes it to `jq`
(`PROJECT_ID="$(jira_write POST /rest/api/3/project "$payload" | jq -r '.id')"`),
so `jq` was handed the log text and died with `Invalid numeric literal at line
1, column 4`. The rehearsal now goes to stderr: still on the terminal, no longer
mistaken for a response body. Four capture sites were affected. One of them,
the board creation, redirected stdout to `/dev/null`, so its payload had never
been visible in a dry run at all — it is now.

**`github.sh` — a 403 was parsed as a ruleset id.** `upsert_ruleset` read the
existing id with `gh api .../rulesets --jq ... 2>/dev/null || true`. Rulesets
need GitHub Pro on a private repository; on a free plan the call returns a JSON
error body, which `--jq` passed straight through into `$id`. The script then
believed the ruleset existed and would have issued
`PUT repos/<slug>/rulesets/{"message":"Upgrade to GitHub Pro..."}`. It now lists
first, checks the call succeeded, and dies with the plain reason — a missing
ruleset is a normal state, an unreachable ruleset API is not. This matters more
than a tidy error message: the `main protection` ruleset is the entire
containment story, and failing silently on it means the App is uncontained.

### The documented bootstrap order could not succeed on an empty repository

**Plan said:** run `bootstrap/github.sh`, then `git push -u origin main`.

**Actual:** the push is rejected. `github.sh` creates the `main protection`
ruleset, which requires a pull request and a green `ci` and has no bypass
actors — deliberately, including the human running it. On an empty repository
nothing can satisfy that: `ci` cannot run until the workflows are on the default
branch, and they cannot get there except by this push. GitHub answers
`Required status check "ci" is expected`.

**Done:** `SETUP.md` now pushes before `github.sh`, and documents the
disable/push/re-enable recovery for anyone who has already created the ruleset,
with a verification step — an unenforced `main protection` is the single failure
mode the design exists to prevent, and it is invisible once you have moved on.

`SETUP.md` also now states the prerequisite that made this visible: rulesets
need GitHub Pro on a private repository. On a free plan every ruleset call
returns 403 and the factory has no containment at all.

### Notes from the first live bootstrap

Not defects, but each looked like one for a while.

*Jira ships a global status called "Building".* `jira.sh` creates nine of its
ten statuses and reuses that one. The skip is the idempotency check working, not
a missing status.

*The `kanban-classic` template creates `Backlog` and `Done` itself.* So the run
that appears to create seven statuses has in fact produced all ten: seven new,
one pre-existing global, two from the template. Check
`/rest/api/3/project/DF/statuses` rather than counting the log lines.

### The custom fields were created and then left on no screen

**Plan said:** `jira.sh` creates `Acceptance criteria` and `Design owner`, and
`factory gather` resolves them by name.

**Actual:** both fields existed and neither was usable. `jira.sh` created them
and stopped there, never associating them with the project's screens. A field on
no screen is invisible twice over: it does not appear on the create or edit form,
so no human can put acceptance criteria on a card at all, and — the part that
cost the time — `GET /rest/api/3/field` does not return it. That is the endpoint
`factory/src/gather.ts:26` uses, and a miss there is silent: the criteria render
as `_(none given)_` and the agent simply works without them.

`smoke.sh` reported both as missing and was right to. The first reading was that
Jira's field index lagged behind creation, because `/rest/api/3/field/search`
listed both and each resolved by id. It was not lag. Polling `/rest/api/3/field`
every thirty seconds returned nothing for seven attempts and then both fields on
the eighth — the attempt immediately after they were added to a screen by hand.

**Done:** `ensure_field` now resolves the project's screens through its issue
type screen scheme (`project_screen_ids`) and adds each field to the first tab
of every screen the project uses. A field already on the screen answers 400,
which is the idempotent case and is tolerated rather than fatal.

The same function also now looks fields up through `/rest/api/3/field/search`
rather than `/rest/api/3/field`. This was a second bug hiding behind the first:
a field that exists but is on no screen is absent from `/field`, so a re-run
after a partial bootstrap would not have found it and would have created a
duplicate of the same name on every attempt.

Two portability notes, both from macOS shipping bash 3.2: `readarray` does not
exist, and `"${arr[@]}"` on an empty array is an unbound-variable error under
`set -u`. The array is built with a read loop and the loop is guarded.

## 2026-09-21

### The preview was raised once and never rebuilt, and nothing served it

**Plan said:** a preview environment per pull request, raised by `build-setup`.

**Actual:** two separate gaps, one of them silently wrong in the documentation.

*It was raised once.* `build-start.yml` dispatched `build-setup.yml` at the end
of turn 1, and nothing dispatched it again. `build-turn.yml` did not. So the
preview showed turn 1's build for the life of the PR, while every diagram and
document in the repository described it as tracking the branch. A preview that
is confidently stale is worse than no preview: a reviewer clicks it, sees the
old build, and reports a bug that does not exist.

*Nothing served it.* The GHCR path builds a real image and records a real
Deployment, but the "preview URL" was a link to a container registry page.

**Done, for the trigger:** `build-setup.yml` now runs on the pull request's own
`labeled` and `synchronize` events instead of a dispatch. The hand-off step and
the now-unused PR-number step are gone from `build-start.yml`. This works
because `factory publish` applies `factory:active` with the **App installation
token**, and events made with an App token start workflow runs where events made
with `GITHUB_TOKEN` do not — the same distinction the poller already depends on.
`synchronize` covers every later turn, so the preview follows the branch. The
`labeled` gate matches `github.event.label.name` exactly rather than testing the
label set, or adding any unrelated label to an active PR would re-post the
kickoff comment; the kickoff step is additionally skipped on `synchronize`.
Checkout takes the head SHA, not the merge commit — a preview of a merge commit
is a preview of something that exists nowhere.

**Done, for the hosting:** a second backend, selected by the
`FACTORY_PREVIEW_BACKEND` repository variable. `azure` builds the image with
`az acr build` (in ACR Tasks, so the runner needs no Docker daemon) and runs it
as one Azure Container App per PR with external ingress on 8080. Azure issues
and renews the certificate and hands back an
`https://<app>.<region>.azurecontainerapps.io` FQDN, which becomes the
Deployment URL, the PR factory block's `preview_url` and the agent's
`PREVIEW_URL`. `--min-replicas 0` means an unvisited preview costs nothing, at
the price of a few seconds of cold start. Teardown deletes the app and the image
tag as two independent attempts, because an app that outlives its PR bills by
the hour while a stray image tag only bills for storage.

**Registry is ACR, not GHCR,** deliberately. Container Apps pulling from a
private GHCR repository would need a durable GitHub credential stored inside
Azure — exactly the credential-spreading the security model exists to prevent.
ACR pulls with the app's system-assigned managed identity and stores nothing.

**Azure sign-in is OIDC,** so the repository holds no Azure secret at all: nine
repository variables and zero secrets. `id-token: write` is granted only in
`build-setup.yml` and `build-teardown.yml`, neither of which runs an agent.

**Container Apps, not Static Web Apps,** which the plan named. The app is
already a container carrying its own nginx config; Static Web Apps serves static
files only, so the SPA fallback and cache headers would have to be re-expressed
in its config format. The commented-out `deploy-azure` job is deleted.

**Not verified.** No part of the Azure path has run against a live subscription.
The `az` command shapes follow the documented CLI surface and are pinned by 13
unit tests through a stubbed runner, but a passing test of a command string is
not evidence the command works — see the `shellcheck`/`actionlint` entry below
for why that distinction is worth stating twice. The default stays `ghcr` until
someone has watched it work. `preflight.sh` fails loudly on a half-configured
`azure` backend rather than letting it fail mid-build.

**Watch for:** `--registry-identity system` asks Azure to grant the app's own
identity `AcrPull` at create time, which only succeeds if the deploying
principal can make role assignments. That is the most likely first failure, and
it presents as a successful create followed by `ImagePullFailure`.

**Also watch for:** `build-setup.yml` now builds the PR's own code while holding
`packages: write` and an Azure credential. The workflow file is read from the
base branch so the agent cannot change what runs, and `factory validate` keeps
`.github/`, `factory/` and `bootstrap/` out of reach — but `npm ci` and the
Docker build still run install scripts from `app/package.json`. Recorded in
SECURITY.md under what this does not defend against.

### The agent CLI was installed unpinned, and turns were not reproducible

**Plan said:** install the agent on the runner and run it headless.

**Actual:** all three agent workflows ran `npm i -g @anthropic-ai/claude-code`
with no version. Every job pulled whatever was latest at that moment. That is a
live risk rather than a theoretical one: the `--max-turns` entry below is this
repo already having been bitten by version-coupled flags, and an unpinned
install means a CLI release can change how a turn behaves at 3am with nobody
watching. Turns were also not reproducible after the fact — the artifact
carried `.agent/out/` but not `.agent/in/`, so a failed turn shipped the answer
without the question.

**Done:** the install is pinned to `${{ vars.FACTORY_AGENT_VERSION || '2.1.224' }}`
in `design.yml`, `build-start.yml` and `build-turn.yml`, matching how the budget
variables already work. Artifacts now carry `.agent/in/` as well as
`.agent/out/`. Because a turn is a pure function of `.agent/in/`, those two
changes together make any turn replayable on a laptop with no runner involved —
see RUNBOOK, "Replaying a turn on your own machine". That is a better debugging
story than shelling into a live runner would have been, because it repeats.

**Not done, deliberately:** caching or pre-baking the CLI. Measured, a cold
install is ~2–4s and the payload is a ~270MB platform binary delivered as an
optional dependency. A cache restore or a container pull moves the same 270MB
over the same network, so on an ephemeral runner there is nothing to win. It
only pays off on a persistent self-hosted runner, where a layer cache survives
between jobs — see SELF-HOSTING.md.

**Watch for:** `create-github-app-token@v1` and the other actions are still
mutable major tags rather than commit SHAs. That is the remaining unpinned
dependency, and it is the one that mints the App token.

### `claude --max-turns` does not exist; turns are bounded by spend instead

**Plan said:** run the agent with `--max-turns <n>`.

**Actual:** Claude Code 2.1.224 has no `--max-turns` flag. `claude --help` lists
no turn-count limiter at all. The nearest equivalent is `--max-budget-usd
<amount>`, which caps what a single `--print` run may spend on API calls.

**Done:** every agent step uses `--max-budget-usd`, read from the repository
variables `FACTORY_DESIGN_BUDGET_USD` (default 5) and `FACTORY_BUILD_BUDGET_USD`
(default 10). This is arguably the better bound for the thing we actually care
about — a runaway agent costing money — since turn count is only a proxy for it.
The containment guarantee is unaffected: it never rested on the turn cap, but on
the tool allow-list and the diff-scope check in `factory validate`.

**Watch for:** the flag is version-coupled. If a future Claude Code drops or
renames `--max-budget-usd`, the agent step fails loudly at start-up rather than
running unbounded, because the flag is passed unconditionally.

### Agent steps also pass `--strict-mcp-config`

**Plan said:** run headless `claude -p` with an explicit tool allow-list.

**Done:** the allow-list is there, and the agent steps additionally pass
`--strict-mcp-config` and an explicit `--disallowedTools` list. Without
`--strict-mcp-config`, a runner-level or user-level MCP configuration would be
loaded and could add tools the allow-list never anticipated. The design stage
denies `Bash` outright; both stages deny `WebFetch`, `WebSearch`, `Task` and
`NotebookEdit`.

### Vitest 3, not Vitest 2

**Plan said:** tests with Vitest.

**Actual:** Vitest 2 pins Vite 5. With Vite 6 in `app/`, npm installed a second
copy of Vite nested under `vitest/`, and `vite.config.ts` stopped typechecking:
`vitest/config`'s `defineConfig` expected the nested copy's `Plugin` type while
`@vitejs/plugin-react` returned the root copy's.

**Done:** both workspaces use Vitest 3, which supports Vite 6, so npm dedupes to
a single Vite install and the config typechecks.

### `preview-down` assumed the repo owner was a user, not an org

**Plan said:** `preview-down` "marks the deployment inactive and deletes the
package version". `GH_OWNER` is specified as "GitHub user **or org**".

**Actual:** the GHCR cleanup was hardcoded to `/users/{owner}/packages/...`.
GitHub scopes package routes by owner kind, and `/users/…` and `/orgs/…` are
different endpoints rather than aliases — pointing the user route at an
organisation is a 404, not a redirect. Because `previewDown` wraps the cleanup
in a `try` that only logs (a failed teardown should not fail the workflow), an
org-owned playground would have silently accumulated one container image per
merged card, forever, while reporting success.

Checked as part of a sweep of every GitHub endpoint the repo calls against
GitHub's published `api.github.com.json` (spec version 1.1.4). That sweep found
nothing else: all 17 endpoints exist and none are deprecated. The drift was
confined to Jira, and this one bug was ours rather than GitHub's.

**Done:** `packageVersionsPath()` in `factory/src/github.ts` resolves the owner
kind from `GET /repos/{owner}/{repo}` and builds the right route; `preview-down`
derives both the list and the delete path from it, so the two can no longer
disagree. Three unit tests pin both owner kinds and the lookup itself.

**Not** `/user/packages/...`, which is the obvious-looking third option: that
route means "the authenticated user", and `preview-down` runs under
`GITHUB_TOKEN`, an installation token with no user behind it.

### `shellcheck` and `actionlint` were never actually installed

**Plan said:** validate all YAML with `actionlint` ("install it if missing").

**Actual:** neither tool was present on the machine when the earlier phases
reported "shellcheck clean across all 5 scripts" and "actionlint clean across all
7 workflows". Those claims could not be reproduced, because the commands that
produced them cannot have run.

**Done:** both installed (shellcheck 0.11.0, actionlint 1.7.12) and run for
real. Both claims turned out to be *true* — all 5 scripts and all 7 workflows
are genuinely clean, including the Jira fixes above. The finding is about the
verification, not the code: a green claim from a tool that is not installed is
indistinguishable from a green claim from a tool that is, unless someone checks.
Worth remembering before trusting the next "X passes" in this repo.

### The first build turn runs in `build-start.yml`

**Plan said:** six workflows, with `build-start` opening the work and
`build-turn` running turns granted by a human comment.

**Done:** `build-start.yml` runs turn 1 itself. `factory publish` needs a commit
to open a pull request, and a branch cut from `main` with no commits has nothing
to open a PR against. Turn 1 is granted by the card reaching "Ready for build" —
itself a human action — and every turn after it is granted by a human comment, as
planned. Auto-continue remains off.

### `/rest/api/3/workflow/search` was removed on 1 June 2026

**Plan said:** nothing specific; `bootstrap/jira.sh` was written against the
workflow-search endpoint that was current when the plan was drafted.

**Actual:** `GET /rest/api/3/workflow/search` (singular *workflow*) is gone —
Atlassian removed it on 1 June 2026, three months before this build, per
changelog CHANGE-2569. The replacement is `GET /rest/api/3/workflows/search`
(plural), which also changed response shape: a workflow's name is a plain
`.name` string, where the removed endpoint nested it under `.id.name`.

**Done:** `bootstrap/jira.sh` calls the plural endpoint and selects on `.name`.
The query string is URI-encoded, matching how the filter and board lookups
further down the script already build theirs.

**How it was found:** by checking every endpoint the repo calls against
Atlassian's published OpenAPI spec (`swagger-v3.v3.json`) rather than against
the prose docs. The `deprecated: true` flag on the removed path is what
surfaced it. The same sweep confirmed every other endpoint in `jira.sh` and all
seven used by the factory CLI (`search/jql`, issue read, comment read/write,
transition list/execute, field list) are current and undeprecated.

### The bulk workflow-create payload was missing three required fields

**Plan said:** create the workflow via `POST /rest/api/3/workflows/create`.

**Actual:** the endpoint is correct and current, but the payload the script
built would have been rejected. Checked against the OpenAPI schema:

- `WorkflowStatusUpdate` (the top-level `statuses[]`) marks **`name` and
  `statusCategory`** required. The script sent only `statusReference` and `id`.
- `StatusLayoutUpdate` (the per-workflow `statuses[]`) marks **`properties`**
  required even when empty. The script omitted it.

`id` was already being sent, which is the field that makes the call reuse the
statuses created in the previous step instead of trying to mint new ones — its
absence is the widely-reported `Status name "..." must be unique` failure.

**Done:** `STATUS_SPEC`'s name, category and description are now carried through
into both arrays, and the inner array sends `properties: {}`. The constructed
payload was checked field-by-field against the schema's required lists with the
real `STATUS_SPEC` and a simulated status-search response: 10 statuses, 11
transitions (1 `INITIAL` + 10 `GLOBAL`), unique transition ids, and every
`toStatusReference` resolving to a declared status.

**Still unverified:** this is schema conformance, not a live call. `jira.sh` has
still never run against a real Jira site — that needs Checkpoint B. What changed
is that the first live run should now fail for interesting reasons, if at all,
rather than on three missing required fields.
