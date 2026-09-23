# dark-factory-playground

A Jira card goes into a column. A pull request comes out — designed,
implemented, tested, previewed. A human reviews it and merges it.

This repository is a small working proof of that: an example React app for the
factory to build features into, and the machinery that runs the loop.

```bash
cp .env.example .env
npm ci
bootstrap/preflight.sh
```

Then follow **[docs/factory/SETUP.md](docs/factory/SETUP.md)**.

## Layout

| | |
| --- | --- |
| `app/` | The example React 19 + TypeScript + Vite app |
| `factory/` | `@factory/cli` — every step of a turn, as subcommands |
| `.agent/` | The agent boundary: the two manuals, and the result contract |
| `.github/workflows/` | The poller, design, and build start/setup/turn/teardown |
| `bootstrap/` | Scripts that configure GitHub and Jira from nothing |
| `docs/` | How it works, how to run it, and why it is built this way |
| `PLAN.md` | The build plan this repository was built from. Historical — where it and the code disagree, the code is right and [the changelog](docs/factory/CHANGELOG.md) says why |

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Documentation

- **[Overview](docs/factory/OVERVIEW.md)** — what the factory is and how a turn runs
- **[Setup](docs/factory/SETUP.md)** — from nothing to a card that builds itself
- **[State machine](docs/factory/STATE-MACHINE.md)** — the ten statuses, and who moves each
- **[Runbook](docs/factory/RUNBOOK.md)** — when it does not do what it should
- **[Security](docs/factory/SECURITY.md)** — the containment argument, and where it stops
- **[Self-hosting](docs/factory/SELF-HOSTING.md)** — running it somewhere else
- **[ADR 0001](docs/adr/0001-factory-architecture.md)** — why it is built this way
- **[Changelog](docs/factory/CHANGELOG.md)** — corrections to the build plan

## The short version of the safety argument

The agent holds one credential (`ANTHROPIC_API_KEY`) and no others; every tool
it can use is allow-listed; every file it may write is allow-listed, and that
list never includes its own manual, its own workflow, or its own validator; the
App can push to `card/*` and nowhere else, and cannot approve or merge.

And a human grants every build turn. There is no auto-continue.

[docs/factory/SECURITY.md](docs/factory/SECURITY.md) makes the argument
properly, including what it does not cover.
