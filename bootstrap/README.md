# `bootstrap/`

Four scripts that turn an empty GitHub repository and an empty Jira site into a
working factory. Run them in this order:

```
bootstrap/preflight.sh           # gate: is this machine able to do any of this?
bootstrap/github.sh --dry-run    # rehearse
bootstrap/github.sh              # apply
bootstrap/jira.sh --dry-run      # rehearse
bootstrap/jira.sh                # apply
bootstrap/smoke.sh               # assert it all landed
```

| Script | What it does | Changes remote state |
| --- | --- | --- |
| `preflight.sh` | Checks the toolchain, `.env`, `gh` identity and scopes, and that the Jira token authenticates | No |
| `github.sh` | Actions permissions, secrets, variables, the `preview` environment, labels, rulesets | Yes |
| `jira.sh` | Project, the ten statuses, the Factory workflow and scheme, custom fields, filter and board | Yes |
| `smoke.sh` | Asserts every one of the above is present and correct | No, unless `--card` |

## Rules these scripts follow

**Nothing calls an external API before `preflight.sh` passes.** It is the gate,
and it is the one script with no dependencies of its own — it does not even
source `lib.sh`, so a broken helper is something preflight can still report.

**`--dry-run` is a complete rehearsal, not a best effort.** Every call that
changes remote state in `github.sh` and `jira.sh` goes through `run()` or
`jira_write()`, both of which print the request instead of sending it. A dry run
that prints nothing surprising means the real run will do nothing surprising.

**They are idempotent.** Each step looks for what it needs before creating it,
so a re-run after a partial failure resumes rather than duplicates. Re-run them
freely after editing `.env`.

**They never echo a secret.** Values are read from `.env` and passed to `gh` or
`curl` on stdin. `preflight.sh` reports credentials as "set", never as their
value.

**They refuse rather than guess.** A missing variable, or one still holding its
`.env.example` placeholder, stops the script with the name of the thing to fix
and a pointer to `docs/factory/SETUP.md`.

## What they deliberately do not do

- **They do not create the GitHub App.** That is Checkpoint A, by hand, in the
  GitHub UI — an App's private key is issued once and cannot be re-read.
- **They do not create the Jira site or the API token.** Checkpoint B.
- **They do not map statuses onto board columns.** The Agile API cannot do it;
  it is a drag in the board settings UI. Checkpoint D. `smoke.sh` cannot see
  whether it has been done, so it is the one thing you have to confirm by eye.
- **They do not grant the App its permissions.** Those are set on the App
  itself at Checkpoint A: repository contents, pull requests, issues, actions,
  deployments and packages, all write; and no access to anything else.

## `--card`

`bootstrap/smoke.sh --card` files a real Jira card in "Ready for design" and
leaves it for the poller. It is the only way to exercise the whole loop, and it
costs a real agent run. It refuses to file anything while any other check is
failing, and it does not clean up after itself.

## If something rejects a payload

Fix it here and record what changed in `docs/factory/CHANGELOG.md`. Do not work
around it in the caller.

The Jira payloads in `jira.sh` have been checked field-by-field against
Atlassian's published OpenAPI spec — every endpoint exists and is undeprecated,
and every schema-required field is sent. They have still never run against a
live site, which needs Checkpoint B; see the note at the top of that file.
