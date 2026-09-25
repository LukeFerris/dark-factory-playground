# Self-hosting

Everything in this repository runs on GitHub-hosted runners against a free Jira
site. The preview environment has two backends, selected by the
`FACTORY_PREVIEW_BACKEND` repository variable. This document says what each one
does and what it takes to turn the second one on.

## When the preview is raised

Both backends are raised by `build-setup.yml`, which triggers on the pull
request itself rather than on a dispatch:

| Event | Effect |
| --- | --- |
| `labeled` with `factory:active` | Raise the preview, post the kickoff comment |
| `synchronize` (any push to the PR) | Re-raise the preview at the new commit |
| `pull_request: closed` (`build-teardown.yml`) | Tear it down |

The label arrives at the end of turn 1, when `factory publish` adds it. That
works as a trigger only because the label is applied with the **App
installation token** — events created with `GITHUB_TOKEN` deliberately do not
start new workflow runs, and this is the one place the distinction is load
bearing.

`synchronize` is what makes the preview track the branch. Every build turn
pushes, so every build turn re-enters `preview-up`; both backends are
idempotent for a given PR number.

## Backend: `ghcr` (default)

The stub, and what runs with no cloud account at all.

1. `docker build -f app/Dockerfile .` — a multi-stage build that compiles the
   app on `node:22-alpine` and serves it from `nginx:alpine` as a non-root user
   on port 8080, with a SPA fallback and immutable caching for `/assets/`.
2. Pushes it to `ghcr.io/<owner>/<repo>:pr-<n>`.
3. Creates a GitHub Deployment in the `preview` environment whose target URL is
   the GHCR package page.

**Nothing serves the image.** The "preview URL" on the PR is a link to a
container registry page, not a running application. What the stub proves is the
plumbing — an artifact exists per pull request, its lifecycle is tied to the
PR's, and the build agent is handed a `PREVIEW_URL` it can act on.

The Dockerfile is real and works. `docker build -f app/Dockerfile .` from the
repository root produces a ~50MB image that serves the built SPA. Note the build
context is the **repository root**, not `app/` — `app/` alone is not installable
because it is a workspace of the root `package.json`.

## Backend: `azure` — Container Apps

> **VERIFIED, once.** `infra/azure/` has been applied against a live
> subscription and re-plans clean, and PR #16 came up at
> `https://df-preview-pr-16.redbush-3ff4fb61.uksouth.azurecontainerapps.io`
> serving the build turn's own bundle. Two caveats: that was a *re-run* of the
> job, after fixing the federated credential subject, so a clean first attempt
> from a `synchronize` has not been seen; and `preview-down` has never run, so
> teardown — the half that decides whether a merged card stops billing — is
> still only unit-tested through a stubbed runner.

One Container App per pull request, named `<prefix>-preview-pr-<n>`, serving the
same image the stub builds. `factory/src/azure.ts` holds every `az` call.

**Why Container Apps and not Static Web Apps**, which was the original plan: the
app is already a container with an nginx config in it, and Static Web Apps only
serves static files — the SPA fallback and the cache headers would have to be
re-expressed in its own config format. Container Apps runs what the Dockerfile
already describes. It also scales to zero, which is what makes one environment
per open PR affordable.

**Why ACR and not GHCR as the registry.** Container Apps pulling from a private
GHCR repository needs a durable GitHub credential stored inside Azure. That is
exactly the credential-spreading this project exists to avoid. With ACR the pull
uses a managed identity and nothing is stored anywhere. The build is also
`az acr build`, which uploads the context and builds it in ACR Tasks, so the
runner needs no Docker daemon at all.

### HTTPS

There is nothing to wire. `--ingress external --target-port 8080` gives the app
a managed hostname of the shape

```
https://<app>-<suffix>.<region>.azurecontainerapps.io
```

with a certificate Azure issues and renews. `deployPreview` reads it back from
`properties.configuration.ingress.fqdn` and that is the URL that lands on the
Deployment, in the PR's factory block, and in the agent's `PREVIEW_URL`. No DNS
records, no certificate, no nginx TLS config. A custom domain is possible later
and is not needed for this.

### Setting it up

It is Terraform, in `infra/azure/`. One apply provisions the estate and sets
the twelve repository variables, each read off the Azure resource it just made
— so `AZURE_CLIENT_ID` cannot drift from the app registration it names.

```bash
az login
infra/azure/apply.sh            # plan: shows what it would do, changes nothing
infra/azure/apply.sh --apply
```

`infra/azure/README.md` is the reference for what it builds and why. The two
things worth knowing before you run it:

**The pull identity.** `--registry-identity system` asks Azure to create each
app's own identity and grant it `AcrPull` at create time — which means the CI
principal must be able to create role assignments, i.e. hold **User Access
Administrator** on the group. For a pipeline whose whole argument is that no
step holds more than it needs, that is a poor trade. Terraform creates one
user-assigned identity instead, grants it `AcrPull` once, and passes its
resource id as `AZURE_PREVIEW_IDENTITY`. CI is then only `Contributor` on one
resource group and `Managed Identity Operator` on one identity — neither of
which can grant a role. Leave `AZURE_PREVIEW_IDENTITY` unset and the code falls
back to `system`, so the broader-permission path still works.

**The OIDC subjects.** Entra matches the subject exactly, and Actions presents
two shapes: `repo:<owner>/<repo>:pull_request` for the `pull_request` events
that both preview workflows run on, and `repo:<owner>/<repo>:ref:refs/heads/main`
for the manual `workflow_dispatch` retry. Terraform creates a federated
credential for each. A token from any other repository, branch or event type
matches neither and is refused.

All variables, no secrets in the *repository*: OIDC means there is nothing
long-lived to store there. The local state does hold one — the launcher storage
account's key, which can write one public HTML file and nothing else. See
"State" in `infra/azure/README.md`.

`AZURE_PREVIEW_PREFIX` is what keeps two factories sharing one Container Apps
environment from colliding on `pr-1`.

### Cold starts, and the three things that cover them

A preview runs `--min-replicas 0`, so one nobody is looking at costs nothing.
The bill for that is the first request after idle, and it is bigger than it
sounds: Container Apps does not refuse a request to a sleeping app, it *holds*
it while a replica starts. Measured on a real cold start — TLS complete in
81ms, then 22.4 seconds of silence, then a 200. A blank tab for half a minute
reads as a broken deployment.

| | What it covers |
| --- | --- |
| `preview-up` waits for the app to answer before it returns | The common case. The cold start is spent in CI, so the app is already hot when the kickoff comment lands. It is also the first check that the URL being published serves anything at all — a container that never answers now fails the job instead of being posted as a working link |
| `AZURE_PREVIEW_COOLDOWN_SECONDS`, default 3600 | Staying hot through a review. Azure's default is 300s, shorter than the gap between the notification and the click. An idle replica is $0.0108/hour at Azure's published uksouth rate, so an hour of warmth per build turn is about a penny, and it still reaches zero afterwards |
| `AZURE_PREVIEW_LAUNCHER` | Everything left over — the person who comes back tomorrow. An always-on page on Azure Storage that renders instantly, says what is happening, and forwards when the app answers |

The launcher wraps **only the links a human clicks**: the kickoff comment, the
Jira report comment, and the PR's "View deployment" button. `PREVIEW_URL` and
the factory block keep the raw app URL, because the agent's build turn curls it
to check the site is serving and a loading page would answer 200 regardless.

To take it all down — including the repository variables, which returns the
factory to the `ghcr` stub rather than breaking it:

```bash
infra/azure/apply.sh --destroy
```

Close any open build PRs first and let `build-teardown.yml` remove their
previews. Destroying the environment out from under a running app leaves the
app behind.

### What it costs to leave running

Previews are created with `--min-replicas 0`, so an app nobody is looking at
runs no replicas and bills nothing but its share of the environment. The trade
is a few seconds of cold start on the first request after idle — worth saying
out loud on the PR, because a reviewer who clicks and sees nothing for four
seconds assumes it is broken.

### Other hosts

Nothing about the factory is Azure-specific. `previewUp` in
`factory/src/preview.ts` is a switch on one variable; any host that can run a
container per pull request and hand back a URL fits the same shape — Cloud Run,
Fly, ECS, or a single VM running the images the stub already builds.

## Running the agent somewhere other than GitHub Actions

The factory CLI is the portable part. Every step of a turn is a subcommand with
no dependency on Actions beyond three environment variables it reads for
convenience (`GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_SERVER_URL`, all
optional). A turn is:

```bash
npm run --silent factory -- gather DF-1 --stage build --pr 7
npm run --silent factory -- prepare-branch DF-1 --stage build
claude -p "$(cat .agent/build.md)" --allowedTools "…" --output-format json \
  > .agent/out/transcript.json
npm run --silent factory -- validate --stage build --base origin/main
npm run --silent factory -- publish --stage build
npm run --silent factory -- report --stage build
```

Run that anywhere with Node 22, `git`, `gh` and `claude`. What you lose by
leaving Actions is the isolation: the workflow's per-step `env:` blocks are what
keep credentials out of the agent's environment. If you run this on a laptop or
a long-lived VM, the agent inherits whatever is in the shell — which undoes
layer 1 of `SECURITY.md`. Put the agent step in a container with an explicit
environment, or accept that the containment argument is now weaker.

## Jira

Nothing here depends on Jira Cloud Free specifically. `factory/src/jira.ts` uses
REST v3 with basic auth and an API token, and pages `POST /rest/api/3/search/jql`
on `nextPageToken`. A Data Center instance would need the auth changed and the
search endpoint checked — Data Center is still on the older `/rest/api/2/search`
shape.

Swapping Jira for something else is a bigger job but a well-bounded one: all
Jira access is confined to `factory/src/jira.ts` and all Jira formatting to
`factory/src/adf.ts`. Nothing else in the codebase knows what a Jira issue is.
The same is true of GitHub, which lives entirely in `factory/src/github.ts`
behind a `Runner` seam that the tests substitute.

## Self-hosted runners

The factory will run on a self-hosted runner unchanged — change `runs-on` in the
six workflows. Two things to think about first:

- **The agent executes model-authored code on that machine.** On GitHub-hosted
  runners the VM is destroyed after the job. A self-hosted runner is not, so a
  build turn's `npm run build` runs on hardware that persists. Use ephemeral
  runners, or containers, or both.
- **`docker build` in `build-setup.yml`** needs a Docker daemon the runner can
  reach — on the `ghcr` backend only. The `azure` backend builds in ACR Tasks
  and needs no daemon, just the `az` CLI.

A self-hosted runner is also the one place caching the agent CLI pays off. On
an ephemeral GitHub-hosted runner it does not: the payload is a ~270MB platform
binary, and a cache restore moves the same bytes over the same network as the
install did. On a persistent runner the npm cache and any Docker layers survive
between jobs, so both become real savings. See the CHANGELOG entry on pinning.

## Cost

| | Rough shape |
| --- | --- |
| Anthropic API | The dominant cost. Capped per step by `--max-budget-usd` |
| GitHub Actions | Free on public repositories; the poller is 144 short runs/day |
| GHCR storage | One image per open PR, deleted on close (`ghcr` backend) |
| Azure Container Apps | Scales to zero; an idle preview bills nothing (`azure` backend) |
| Azure Container Registry | Basic tier, one tag per open PR, deleted on close |
| Jira Cloud Free | Free to 10 users |

The poller is the only thing that runs unattended, and it does nothing but one
JQL query per status unless a card is waiting.
