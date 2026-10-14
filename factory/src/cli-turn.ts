// The commands that make up a turn on a card's branch: gathering the task,
// checking out the branch, merging main in, and checking and publishing what
// the agent did.
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { required } from './env.ts'
import * as jira from './jira.ts'
import { gather } from './gather.ts'
import { prepareBranch } from './branch.ts'
import { currentBranch } from './git.ts'
import {
  abortMerge,
  attemptMerge,
  finishMerge,
  mergeQuestionResult,
  readMergeResult,
  readMergeState,
  recordMerge,
} from './merge.ts'
import { refresh, refreshTargets, reportedChecks } from './refresh.ts'
import { validate } from './validate.ts'
import { acceptTurn } from './accept.ts'
import { publish } from './publish.ts'
import { RESULT_PATH, readMeta, turnBase, updateMeta, writeFileEnsuringDir } from './meta.ts'
import { EXIT, parseNumber, parseRetry, parseStage } from './cli-shared.ts'

export function registerTurnCommands(program: Command): void {
  gatherCommand(program)
  prepareBranchCommand(program)
  mergeBegin(program)
  mergeFinishCommand(program)
  refreshPlan(program)
  refreshCommand(program)
  acceptCommand(program)
  validateCommand(program)
  publishCommand(program)
}

function gatherCommand(program: Command): void {
  program
    .command('gather')
    .description('Write .agent/in/task.md and .agent/in/meta.json for a turn.')
    .argument('<key>', 'Issue key')
    .requiredOption('--stage <stage>', 'design | build')
    .option('--pr <number>', 'PR number, for build turns', parseNumber)
    .option(
      '--retry <n>',
      'Which automatic turn this is, after required checks failed',
      parseRetry,
      0,
    )
    .action(async (key: string, opts: { stage: string; pr?: number; retry: number }) => {
      const meta = await gather({
        key,
        stage: parseStage(opts.stage),
        pr: opts.pr,
        retry: opts.retry,
      })
      console.log(`gather: ${meta.key} stage=${meta.stage} turn=${meta.turn}`)
    })
}

function prepareBranchCommand(program: Command): void {
  program
    .command('prepare-branch')
    .description("Check out (or create) the card's branch.")
    .argument('<key>', 'Issue key')
    .action(async (key: string) => {
      const issue = await jira.getIssue(jira.configFromEnv(), key)
      const summary = (issue.fields['summary'] as string) ?? key
      console.log(prepareBranch(key, summary))
    })
}

// The merge, in pieces rather than one command, because the middle of it runs
// an agent: `merge-begin` works out whether main merges and describes a conflict
// in .agent/in/merge.json, the agent resolves it in a job holding nothing but an
// Anthropic key, and `accept` merges again and has `finishMerge` decide whether
// what came back is a commit or a question for the card (ADR 0008). turn.yml
// calls them in that order. `merge-finish` is the same decision for a merge
// left in this checkout's index, which turn.yml's `prepare` uses to clear a
// refused one.

function mergeBegin(program: Command): void {
  program
    .command('merge-begin')
    .description('Start merging origin/main into the checked-out card branch.')
    .argument('<key>', 'Issue key')
    .action(async (key: string) => {
      const issue = await jira.getIssue(jira.configFromEnv(), key)
      const summary = (issue.fields['summary'] as string) ?? key
      recordMerge(attemptMerge(currentBranch()), key, summary)
    })
}

function mergeFinishCommand(program: Command): void {
  program
    .command('merge-finish')
    .description('Commit a resolved merge, or report the conflict on the card and stop the turn.')
    .action(mergeFinish)
}

function mergeFinish(): void {
  const state = readMergeState()
  if (state.state === 'up-to-date' || state.state === 'merged') {
    console.log(`merge-finish: nothing to finish (${state.state}).`)
    return
  }

  // A refused merge never reached an agent — attemptMerge aborted it on the
  // spot — so there is no result to read and nothing to check. It goes
  // straight to the same question on the card.
  const result = state.state === 'refused' ? null : readMergeResult()
  const outcome =
    result === null
      ? { ok: false, problems: [`The conflict is in ${state.denied.join(', ')}.`], sha: null }
      : finishMerge(state, result)

  if (outcome.ok) {
    updateMeta({ base_sha: outcome.sha as string })
    console.log(`merge-finish: merged as ${(outcome.sha as string).slice(0, 12)}.`)
    return
  }

  abortMerge()
  // Hand the failure to `report`, which already knows how to put a question
  // on a card and move it to Blocked on engineer. Exiting non-zero skips the
  // build agent; the workflow's report step runs regardless and reads this.
  writeFileEnsuringDir(
    RESULT_PATH,
    `${JSON.stringify(mergeQuestionResult(state, outcome.problems, result), null, 2)}\n`,
  )
  console.error('merge-finish: the merge from main was not resolved.')
  for (const problem of outcome.problems) console.error(`  - ${problem}`)
  process.exit(EXIT.MERGE)
}

// The fan-out that keeps the review queue from going stale. `refresh-plan`
// names the cards, one `refresh` runs per card on its own runner.
function refreshPlan(program: Command): void {
  program
    .command('refresh-plan')
    .description('Print, as JSON, every card in "In review" whose branch may need main merging in.')
    .option(
      '--exclude <keys>',
      'Comma-separated keys to leave alone, e.g. the card that just merged',
      '',
    )
    .action(async (opts: { exclude: string }) => {
      const exclude = opts.exclude
        .split(',')
        .map((k) => k.trim().toUpperCase())
        .filter((k) => k !== '')
      const targets = await refreshTargets(
        jira.configFromEnv(),
        required('JIRA_PROJECT_KEY'),
        exclude,
      )
      console.log(JSON.stringify(targets))
    })
}

function refreshCommand(program: Command): void {
  program
    .command('refresh')
    .description("Merge main into one in-review card's branch, or hand it to the build agent.")
    .argument('<key>', 'Issue key')
    .requiredOption(
      '--because-pr <number>',
      'The pull request whose merge set this off',
      parseNumber,
    )
    .requiredOption('--because-title <title>', "That pull request's title")
    .option('--main <ref>', 'The commit of main to merge, rather than origin/main as fetched now')
    .option(
      '--checks <outcome>',
      'How the checks went on the same merge in another job: "passed", or the command that failed. ' +
        'Without it they are run here.',
    )
    .option('--dry-run', 'Decide and print, but push nothing and change nothing', false)
    .action(async (key: string, opts: RefreshOptions) => {
      const outcome = await refresh({
        key,
        because: { number: opts.becausePr, title: opts.becauseTitle },
        cfg: jira.configFromEnv(),
        dryRun: opts.dryRun,
        ...(opts.main !== undefined ? { main: opts.main } : {}),
        ...(opts.checks !== undefined ? { checks: reportedChecks(opts.checks) } : {}),
      })
      console.log(`refresh: ${outcome.state} — ${outcome.detail}`)
    })
}

interface RefreshOptions {
  becausePr: number
  becauseTitle: string
  main?: string
  checks?: string
  dryRun: boolean
}

// The join between the agent's job and the job that publishes it (ADR 0008).
// The agent job hands over a git bundle and its result; this merges main again
// here, takes from the agent's merge only the conflicted files, and lays the
// turn's work on top as uncommitted changes, ready for `validate`.
function acceptCommand(program: Command): void {
  program
    .command('accept')
    .description("Take an agent job's turn onto the card branch without running any of it.")
    .requiredOption('--stage <stage>', 'design | build')
    .requiredOption('--bundle <path>', 'The git bundle the agent job left')
    .action((opts: { stage: string; bundle: string }) => {
      const outcome = acceptTurn(parseStage(opts.stage), resolve(opts.bundle))
      if (outcome.state === 'accepted') {
        console.log(`accept: the turn is on ${outcome.base.slice(0, 12)}, uncommitted.`)
        return
      }
      const unresolved = outcome.state === 'merge-unresolved'
      console.error(
        unresolved ? 'accept: the merge from main was not resolved.' : 'accept: REJECTED',
      )
      for (const problem of outcome.problems) console.error(`  - ${problem}`)
      process.exit(unresolved ? EXIT.MERGE : EXIT.VALIDATION)
    })
}

function validateCommand(program: Command): void {
  program
    .command('validate')
    .description('Check the result contract and that the diff stays in scope.')
    .requiredOption('--stage <stage>', 'design | build')
    // No default. The base is the commit the turn started from, recorded in meta
    // at checkout; passing origin/main here would measure a build turn against
    // everything the design turn put on the shared branch.
    .option('--base <ref>', "Base to diff against (default: the turn's base_sha)")
    .action((opts: { stage: string; base?: string }) => {
      const outcome = validate(parseStage(opts.stage), opts.base ?? turnBase())
      if (outcome.ok) {
        console.log(`validate: ok (status "${outcome.result.status}")`)
        return
      }
      console.error('validate: REJECTED')
      for (const problem of outcome.problems) console.error(`  - ${problem}`)
      process.exit(EXIT.VALIDATION)
    })
}

function publishCommand(program: Command): void {
  program
    .command('publish')
    .description('Commit in-scope changes, push, and create or update the draft PR.')
    .requiredOption('--stage <stage>', 'design | build')
    .option('--dry-run', 'Print what would happen without pushing', false)
    .action(async (opts: { stage: string; dryRun: boolean }) => {
      const meta = readMeta()
      const issue = await jira.getIssue(jira.configFromEnv(), meta.key)
      publish({
        stage: parseStage(opts.stage),
        cardSummary: (issue.fields['summary'] as string) ?? meta.key,
        dryRun: opts.dryRun,
      })
    })
}
