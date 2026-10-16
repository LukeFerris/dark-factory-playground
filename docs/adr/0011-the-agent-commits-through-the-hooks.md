# 11. The agent commits through the hooks

Date: 2026-10-16

## Status

Accepted. Supersedes what [0008](0008-code-the-agent-touched-never-shares-a-job-with-a-token.md)
says the turn's bundle holds and who commits it. The boundary in 0008 stands.

## Context

Since 0008 the agent job committed everything a turn wrote as one commit, with
`--no-verify`, and `accept` applied it as an uncommitted patch for `publish` to
commit, again with `--no-verify`. The publishing job holds tokens and must not
run the card's code, and the pre-commit hook runs it: lint-staged, the tests,
the coverage gate. So no gate ran when a turn was committed. `Commit gates`
ran them over the pull request afterwards, and nothing waited for it.

On CVC Workbench that made `Commit gates` red on every card, starting with
the first one through the whole process (WKB-150). The agent never ran
Prettier, because only the hook runs it, and the hook never ran. A stopgap ran
Prettier in the agent job. It fixed formatting and left the other gates where
they were.

The golden path's rule for an agent is simpler: commit at the end of the work,
and never use `--no-verify`. The hook is how an agent's work meets the
repository's gates, and the pattern audit only binds an agent's commits. An
agent that never commits never meets either.

## Decision

**The agent commits its own work, through the repository's hooks.** Both
stages do. The manuals say so in the golden path's words: "You must commit at
the end of your work - you may never use --no-verify". The agent stages its
work, runs `npx lint-staged`, audits the staged diff with `/check-patterns`,
and commits with plain `git commit`, prefixing each message with the card's
key. A hook that fails is work for the agent to do. A gate it cannot pass
without a change outside its paths ends the turn `blocked`.

**The agent job is equipped as the dev container is.** It runs what the dev
container's `post-create.sh` runs: `scripts/install-harness-tools.sh`, for the
pinned gitleaks and osv-scanner, git-ai and its capture hook, and `npx husky`.
The hook's first step, `check-tools.sh`, fails closed if any of it is missing,
so a runner that is not equipped cannot commit at all. A design turn gets
`npm ci` too, because the hook runs lint-staged.

**The agent is given commits, and nothing past the hooks.** Both stages may run
`git add`, `git commit`, `git status`, `git diff` and `git log`,
`npx lint-staged`, the `/check-patterns` skill and `sha256sum`, for the audit's
stamp. A design turn can run nothing else. `Bash(git commit:*)` would also
allow `-n`, `--no-verify` and `HUSKY=0`, and `check-staged-coverage.mjs` honours
`STAGED_COVERAGE_SKIP=1`, so a `PreToolUse` hook refuses any command carrying
those or `hooksPath`, and any edit to `.husky/`, the gate
scripts, or `.claude/`. The workflow writes that hook to `$RUNNER_TEMP`, outside
the checkout, and passes it with `--settings`. The hook refuses edits to
itself as well, since outside the checkout is not out of reach.
The job sets git's identity to the factory's bot before the agent runs.

**The bundle is the agent's commits.** The job packages a turn by listing what
it left uncommitted in `uncommitted.txt` and bundling whatever it committed
after the commit it was given. It commits nothing for the agent. No commits
means no bundle, and an empty turn.

**`accept` keeps the agent's commits.** It still merges main itself and takes
only the conflicted files from the agent's merge. Then it takes the agent's
commits, which must be:

- a straight line, with no merges, on the agent's merge of main, or on the
  commit it was given when there was nothing to merge;
- signed as the factory, author and committer both, which no person's commit
  is;
- everything the turn wrote, with `uncommitted.txt` empty;
- each within the stage's paths, judged commit by commit. `publish` pushes
  every commit, so a change to a denied path that a later commit undoes is
  refused here, although `validate`, which judges where the branch ends up,
  would let it through.

Anything else is refused, as is a turn with no `uncommitted.txt`, because that
job never got as far as packaging. With no merge, the agent's commits are taken
exactly as they are. With one, each is remade on `accept`'s own merge, with the
same tree, message, author and dates. `validate` judges the whole change
against `origin/main` as it always has. `publish` pushes the commits unchanged,
adding one of its own, still with `--no-verify`, only when it has regenerated
the lockfile.

**`Commit gates` is the backstop, and `verify` waits for it.** The new
`FACTORY_VERIFY_CHECKS` names checks that a finished build must pass although
main does not require them. `verify` waits for them as it does for the
required checks, and never excuses one. Set it to `Commit gates`.

## Consequences

- A card's history is the agent's own commits, in its words, with the merges
  `accept` made between them. Each commit has met the hooks.
- The pattern audit binds every turn. The hook only enforces it when
  `CLAUDECODE` or `AI_AGENT` is set. Claude Code sets the first, and the agent
  job sets the second.
- A turn costs more. The coverage gate runs the test suite at each commit that
  stages source files, and the job installs the harness tools on every turn.
- A turn that runs out of budget before its last commit loses what it did not
  commit. The build manual allows committing as the work goes.
- The guard is not a seal. A build agent runs `npm run` scripts it can edit, so
  it can run anything a shell can. `accept` and `validate` still refuse changes outside
  the agent's paths, which include the hooks, and `Commit gates` runs the gates
  again where the agent cannot reach.
- The merge commits the agent job makes stay `--no-verify`. They hand the merge
  over, `accept` makes its own, and they are never pushed.
- The stopgap that ran Prettier in the agent job is not needed.
