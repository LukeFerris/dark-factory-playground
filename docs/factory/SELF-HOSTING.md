# Self-hosting

Everything in this repository runs on GitHub-hosted runners against a free Jira
site, and the preview environment is a stub. This document says what the stub
actually does, and what it would take to make each piece real.

## The preview, as built

`build-setup.yml` does three things:

1. `docker build -f app/Dockerfile .` — a multi-stage build that compiles the
   app on `node:22-alpine` and serves it from `nginx:alpine` as a non-root user
   on port 8080, with a SPA fallback and immutable caching for `/assets/`.
2. Pushes it to `ghcr.io/<owner>/<repo>:pr-<n>`.
3. Creates a GitHub Deployment in the `preview` environment whose target URL is
   the GHCR package page.

`build-teardown.yml` reverses it when the PR closes: the Deployment is marked
inactive and the `pr-<n>` package version is deleted.

**Nothing serves the image.** The "preview URL" on the PR is a link to a
container registry page, not a running application. What the stub proves is the
plumbing — an artifact exists per pull request, its lifecycle is tied to the
PR's, and the build agent is handed a `PREVIEW_URL` it can act on. Swapping in
real hosting is a change to one job.

The Dockerfile is real and works. `docker build -f app/Dockerfile .` from the
repository root produces a ~50MB image that serves the built SPA. Note the build
context is the **repository root**, not `app/` — `app/` alone is not installable
because it is a workspace of the root `package.json`.

## Making the preview real: Azure Static Web Apps

This was the intended target, and there is a commented-out job at the foot of
`.github/workflows/build-setup.yml` ready for it.

1. Create a Static Web App in the Azure portal. Choose **Other** as the
   deployment source — the GitHub integration would write its own workflow.
2. **Manage deployment token** → copy it.
3. `gh secret set AZURE_SWA_TOKEN --repo "$GH_OWNER/$GH_REPO"`
4. Uncomment the `deploy-azure` job.
5. Point `factory preview-up` at the resulting URL instead of the package page:
   the `previewUp` function in `factory/src/preview.ts` decides what goes into
   the Deployment's `environment_url` and into the PR's factory block.

Static Web Apps gives a per-environment hostname of the shape
`https://<name>-pr-<n>.<region>.azurestaticapps.net`, which is why the job passes
`deployment_environment: pr-<n>`. Free tier allows three staging environments at
once, so a busy factory will need the Standard tier or a teardown that keeps up.

Nothing about the factory is Azure-specific. Any host that can serve a directory
of static files per pull request works — Cloudflare Pages, Netlify, S3 plus
CloudFront, or a single VM running the images the stub already builds.

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
  reach.

## Cost

| | Rough shape |
| --- | --- |
| Anthropic API | The dominant cost. Capped per step by `--max-budget-usd` |
| GitHub Actions | Free on public repositories; the poller is 144 short runs/day |
| GHCR storage | One image per open PR, deleted on close |
| Jira Cloud Free | Free to 10 users |

The poller is the only thing that runs unattended, and it does nothing but one
JQL query per status unless a card is waiting.
