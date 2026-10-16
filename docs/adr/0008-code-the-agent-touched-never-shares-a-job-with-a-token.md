# 8. Code the agent touched never shares a job with a token

Date: 2026-10-13

## Status

Accepted. Changes the job shape that [0001](0001-factory-architecture.md) and
[0003](0003-the-turn-raises-its-own-preview.md) describe, and the PR-comment
path of [0007](0007-cards-lock-while-the-factory-works-them.md). The decisions
in those records stand.

What the turn's bundle holds, and who commits it, is superseded by
[0011](0011-the-agent-commits-through-the-hooks.md): the agent commits its own
work through the repository's hooks, and `publish` pushes those commits. The
boundary below stands.

## Context

Rule 1 of `docs/factory/SECURITY.md` was "the agent holds no credentials", and
the boundary was the **step**. The Agent step's `env:` held
`ANTHROPIC_API_KEY` and nothing else, and the steps around it, in the same job,
held the App token and `JIRA_BOT_TOKEN`.

A step is not a boundary against code that runs on the runner. A build agent
runs its own tests, `npm ci` and the app, and every GitHub-hosted runner gives
that code passwordless `sudo`. Code that has root on the runner can:

- read the environment and memory of any later step in the same job, including
  `JIRA_BOT_TOKEN` and the App token as they are minted;
- leave something behind that a later step runs: a git hook, a changed
  `node_modules/.bin`, a file `npm run factory` loads;
- read the job's `ACTIONS_RUNTIME_TOKEN` and write the Actions cache. An agent
  job dispatched on main shares main's cache scope, so a poisoned
  `~/.npm` would be restored into every later job on main that used
  `cache: npm`, including ones holding tokens.

The same held, more mildly, for other jobs: `refresh.yml` ran the card's
`npm ci` and check scripts beside the App token and `JIRA_BOT_TOKEN`, and
`build-setup.yml` ran the factory from the PR's own checkout.

None of this needs a subverted model. A malicious dependency the agent was
talked into adding, or one that was already in the tree, gets the same root.

## Decision

**The boundary is the job, and a job is either trusted or untrusted.**

- **Untrusted** jobs run code the agent wrote or touched: the agent itself,
  `npm ci`, tests, the app, Playwright. The agent job holds
  `ANTHROPIC_API_KEY` and a read-only `GITHUB_TOKEN`. Every other untrusted job
  holds nothing but a read-only `GITHUB_TOKEN`.
- **Trusted** jobs hold the tokens. They check the factory out from the
  workflow's own commit of main at the workspace root, and the card beside it
  in `card/`, with `FACTORY_REPO_ROOT` and `ENKI_CONFIG` pointing the factory at
  it. They read the card as data. They never run `npm ci` in it, or anything
  else from it.

**A turn is one reusable workflow, `turn.yml`.** `design.yml`,
`build-start.yml` and `build-turn.yml` are thin callers that keep their names,
triggers and concurrency group, because the lock, triage and refresh dispatch
them by name.

| Job           | Side      | Holds                                         | Does                                                                                                                   |
| ------------- | --------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prepare`     | trusted   | App token, `JIRA_BOT_TOKEN`                   | gathers the card, announces, cuts the branch, `merge-begin`                                                            |
| `agent`       | untrusted | `ANTHROPIC_API_KEY`                           | merges main, resolves conflicts, `npm ci`, runs the agent, which commits through the hooks (0011), bundles its commits |
| `publish`     | trusted   | App token, `JIRA_BOT_TOKEN`                   | `accept`, `validate`, `publish`                                                                                        |
| `preview`     | trusted   | Azure (OIDC), `packages`/`deployments: write` | `preview-up`                                                                                                           |
| `walkthrough` | untrusted | nothing                                       | the card's e2e spec against the preview, recorded                                                                      |
| `report`      | trusted   | App token, `JIRA_BOT_TOKEN`                   | kickoff and report                                                                                                     |

**Only data crosses from untrusted to trusted, and it is judged as data.**

- The turn arrives as a git bundle: one commit of work on top of either the
  commit the turn started from, or a merge of the given commit of main into
  it. `factory accept` does not take the agent's merge. It merges main again
  itself, takes only the files that conflicted from the agent's merge, and
  refuses the turn if the rest of the agent's merge differs from its own. The
  work is applied as a patch and left uncommitted, which is the state
  `validate` and `publish` have always judged a turn in.
- `result.json`, `merge-result.json` and the transcripts are copied in by name,
  and only if each is a regular file. They are parsed against the schema as
  before.
- The walkthrough's evidence goes onto the card as files.
- Untrusted artifacts are downloaded into `$RUNNER_TEMP`, never over the card.
  Trusted artifacts are downloaded by the artifact id a trusted job reported,
  so an untrusted job cannot upload one under a trusted name and have it read.
- No untrusted job's outputs are read, with one exception: refresh's checks job
  reports which command failed. Its value is checked against a fixed list
  (`reportedChecks`), and it only decides whether the card goes back to
  _Building_.

**Refresh is split the same way.** `refresh.yml` plans and fans out to
`refresh-card.yml` per card. Its `checks` job merges the planned commit of main
into the card and runs `npm ci` and the check scripts with no secrets. Its
`refresh` job merges the same commit again (`attemptMerge` now takes the main
it merges), takes the checks' outcome, and pushes or moves the card. It runs no
card code.

**Setup and teardown run the factory from main.** `build-setup.yml` and
`build-teardown.yml` check the factory out from the default branch and the PR
into `card/`.

**No workflow uses `cache: npm`.** Any job dispatched on main can write main's
cache, the agent job included, and every later run on main and every PR
restores it. `ci.yml` holds nothing, but it is the check a merge waits on, so
it does not use the cache either.

**The lockfile is regenerated with `--ignore-scripts`.** `publish` runs
`npm install --package-lock-only` in a trusted job, on a `package.json` the
agent may have written.

## Consequences

- A turn takes longer. There are six jobs where there were two, each on a fresh
  runner, and the factory is installed in four of them. The agent job is still
  most of the time.
- The agent's commits are never pushed. The factory writes the merge and the
  turn's commit itself, as before, so the history on a card branch is
  unchanged.
- Both jobs merge the commit of main that `prepare` recorded, so a later push
  to main does not split them. A turn whose merge disagrees with `publish`'s is
  one the agent job changed, and it is refused rather than published.
- The walkthrough can fail without failing the turn. A failed walkthrough
  leaves the card without evidence. It does not leave a turn unreported.

**What is still not bounded:**

- **The `ghcr` preview backend runs `docker build` in the trusted `preview`
  job**, and a Dockerfile `RUN` executes whatever the card's code asks. The
  `azure` backend builds remotely (`az acr build`) and the `swa` backend builds
  nothing, so this is the stub backend only.
- **An untrusted job can fail, or upload junk, to stop a turn.** That costs one
  turn, and the card is reported as failed.
- **The read-only `GITHUB_TOKEN` in an untrusted job can read the repository.**
  On a private repository that is the code, which the agent can read anyway.
- **`ANTHROPIC_API_KEY` is still on the runner the agent controls.** That was
  always the case. Rotate it like any other.

## Sources

- [Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
  (GitHub Docs): untrusted code on a runner can read its secrets.
- [Caching dependencies: restrictions for accessing a cache](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows#restrictions-for-accessing-a-cache)
  (GitHub Docs): a run on the default branch writes the cache every branch
  restores.
- [Reusing workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows)
  (GitHub Docs): a called workflow's permissions are bounded by its caller's.
