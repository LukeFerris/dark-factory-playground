// The commands that make up a turn on a card's branch: gathering the task,
// checking out the branch, merging main in, and checking and publishing what
// the agent did.
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
import { refresh, refreshTargets } from './refresh.ts'
import { validate } from './validate.ts'
import { publish } from './publish.ts'
import { RESULT_PATH, readMeta, turnBase, updateMeta, writeFileEnsuringDir } from './meta.ts'
import { EXIT, parseNumber, parseStage } from './cli-shared.ts'

export function registerTurnCommands(program: Command): void {
  gatherCommand(program)
  prepareBranchCommand(program)
  mergeBegin(program)
  mergeFinishCommand(program)
  refreshPlan(program)
  refreshCommand(program)
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
    .action(async (key: string, opts: { stage: string; pr?: number }) => {
      const meta = await gather({ key, stage: parseStage(opts.stage), pr: opts.pr })
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

// The merge, in three subcommands rather than one, because the middle of it runs
// an agent: `merge-begin` leaves a conflicted merge in the index and describes it
// in .agent/in/merge.json, the agent resolves it in a step holding nothing but an
// Anthropic key, and `merge-finish` decides whether what came back is a commit or
// a question for the card. `.github/actions/merge-main` is the three of them in
// order and is the only thing that should be calling them.

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
    .option('--dry-run', 'Decide and print, but push nothing and change nothing', false)
    .action(
      async (key: string, opts: { becausePr: number; becauseTitle: string; dryRun: boolean }) => {
        const outcome = await refresh({
          key,
          because: { number: opts.becausePr, title: opts.becauseTitle },
          cfg: jira.configFromEnv(),
          dryRun: opts.dryRun,
        })
        console.log(`refresh: ${outcome.state} — ${outcome.detail}`)
      },
    )
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
