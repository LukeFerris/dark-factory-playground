import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { REPO_ROOT, loadDotEnv, required } from './env.ts'
import * as jira from './jira.ts'
import { announce } from './announce.ts'
import { gather } from './gather.ts'
import { prepareBranch } from './branch.ts'
import { triagePass } from './triage.ts'
import { releaseOrphans, stop, takeCard } from './lock.ts'
import { currentBranch } from './git.ts'
import { findPrForCard } from './github.ts'
import {
  abortMerge,
  attemptMerge,
  finishMerge,
  mergeQuestionResult,
  readMergeResult,
  readMergeState,
  recordMerge,
} from './merge.ts'
import { claimCard, sentInBy } from './progress.ts'
import { refresh, refreshTargets } from './refresh.ts'
import { validate } from './validate.ts'
import { publish } from './publish.ts'
import { report } from './report.ts'
import { kickoff, previewDown, previewUp } from './preview.ts'
import { productionUp, ship } from './production.ts'
import { EVIDENCE_DIR, SLIDES_PATH, buildSlides } from './evidence.ts'
import { RESULT_PATH, readMeta, turnBase, updateMeta, writeFileEnsuringDir } from './meta.ts'
import { ResultSchema, Stage, toJsonSchema } from './schema.ts'

loadDotEnv()

/**
 * Exit codes are part of the contract with the workflows:
 *   0 ok · 1 unexpected · 2 Jira auth · 3 no such transition · 4 validation failed
 *   5 the merge from main could not be resolved
 */
const EXIT = { OK: 0, ERROR: 1, AUTH: 2, TRANSITION: 3, VALIDATION: 4, MERGE: 5 } as const

const program = new Command()
program
  .name('factory')
  .description('The Dark Factory pipeline. Each subcommand is one workflow step.')
  .showHelpAfterError()

function parseStage(value: string): Stage {
  const parsed = Stage.safeParse(value)
  if (!parsed.success) throw new Error(`--stage must be "design" or "build", got "${value}"`)
  return parsed.data
}

program
  .command('jira-search')
  .description('Run a JQL query and print matching issue keys, one per line.')
  .argument('<jql>', 'JQL query')
  .action(async (jql: string) => {
    const issues = await jira.search(jira.configFromEnv(), jql)
    for (const issue of issues) console.log(issue.key)
  })

// The third poller source, and the only one that reads rather than counts.
// Unlike jira-search this does the whole job itself — decide, move, explain,
// dispatch — because the four steps have an order that matters and splitting
// them across shell would put that order in a place nothing can test.
program
  .command('triage')
  .description('Read new comments on waiting cards and start the agent each one calls for.')
  .option('--dry-run', 'Decide and print, but change nothing and start nothing', false)
  .action(async (opts: { dryRun: boolean }) => {
    const outcomes = await triagePass({
      cfg: jira.configFromEnv(),
      projectKey: required('JIRA_PROJECT_KEY'),
      dryRun: opts.dryRun,
    })
    if (outcomes.length === 0) {
      console.log('triage: no new comments on any waiting card')
      return
    }
    for (const o of outcomes) {
      const done = o.action === 'none' ? 'noted' : o.acted ? 'dispatched' : 'FAILED'
      console.log(`triage: ${o.key} (${o.status}) -> ${o.action} [${done}] — ${o.reason}`)
    }
  })

program
  .command('stop')
  .description('Act on "@Enki stop": cancel the card\'s run and put the card back.')
  .argument('<key>', 'Issue key, e.g. DF-1')
  .option('--dry-run', 'Check and print, but cancel nothing and move nothing', false)
  .action(async (key: string, opts: { dryRun: boolean }) => {
    const outcome = await stop({ cfg: jira.configFromEnv(), key, dryRun: opts.dryRun })
    console.log(`stop: ${key} -> ${outcome}`)
  })

program
  .command('release-orphans')
  .description('Let go of every locked card that no run is working on.')
  .option('--dry-run', 'Print what would be let go, and change nothing', false)
  .action(async (opts: { dryRun: boolean }) => {
    const released = await releaseOrphans({
      cfg: jira.configFromEnv(),
      projectKey: required('JIRA_PROJECT_KEY'),
      dryRun: opts.dryRun,
    })
    console.log(
      released.length === 0
        ? 'release-orphans: none'
        : `release-orphans: let go of ${released.join(', ')}`,
    )
  })

program
  .command('jira-take')
  .description(
    'Move a card into a locked status, unless it is in one, and assign it to the factory.',
  )
  .argument('<key>', 'Issue key, e.g. DF-1')
  .argument('<status>', 'The locked status, e.g. Building')
  .action(async (key: string, status: string) => {
    await takeCard(jira.configFromEnv(), key, status)
    console.log(`${key} taken`)
  })

program
  .command('card-pr')
  .description("Print the open pull request number for a card's branch.")
  .argument('<key>', 'Issue key, e.g. DF-1')
  .action((key: string) => {
    const pr = findPrForCard(key)
    if (pr === null) throw new Error(`No open pull request on a card/${key}-* branch.`)
    console.log(pr.number)
  })

program
  .command('jira-transition')
  .description('Move a card to a status, matched by destination status name.')
  .argument('<key>', 'Issue key, e.g. DF-1')
  .argument('<status>', 'Target status name, e.g. "Design review"')
  .action(async (key: string, status: string) => {
    await jira.transitionTo(jira.configFromEnv(), key, status)
    console.log(`${key} -> ${status}`)
  })

// The other half of a claim. The status says the factory has the card; the
// avatar says so on the one view where nobody opens it. Both belong to the
// moment the card is taken, and `announce` — which used to be the only caller
// of claimCard — does not run until the dispatched workflow has a runner, a
// checkout and an `npm ci` behind it. Measured on this project, that left the
// card sitting in Designing or Building with no avatar for 18 to 44 seconds,
// which reads as a card nobody has picked up. Worse, when the dispatch fails
// it reads that way forever.
//
// `--from` is the poller's: the card was sent in by being dragged into that
// status, and it goes back to whoever dragged it. Without it the card goes back
// to whoever holds it now, and claimCard returns early when that is already the
// factory — so `announce` keeping its own call costs nothing.
program
  .command('jira-claim')
  .description('Assign a card to the factory, remembering who it goes back to.')
  .argument('<key>', 'Issue key, e.g. DF-1')
  .option('--from <status>', 'Hand it back to whoever moved it into this status')
  .action(async (key: string, opts: { from?: string }) => {
    const cfg = jira.configFromEnv()
    let handBackTo: string | undefined
    if (opts.from !== undefined) {
      handBackTo = await sentInBy(cfg, key, opts.from).catch((error: Error) => {
        console.error(`::warning::could not read who moved ${key}: ${error.message}`)
        return ''
      })
    }
    await claimCard(cfg, key, handBackTo)
    console.log(`${key} claimed`)
  })

program
  .command('gather')
  .description('Write .agent/in/task.md and .agent/in/meta.json for a turn.')
  .argument('<key>', 'Issue key')
  .requiredOption('--stage <stage>', 'design | build')
  .option('--pr <number>', 'PR number, for build turns', (v) => Number.parseInt(v, 10))
  .action(async (key: string, opts: { stage: string; pr?: number }) => {
    const meta = await gather({ key, stage: parseStage(opts.stage), pr: opts.pr })
    console.log(`gather: ${meta.key} stage=${meta.stage} turn=${meta.turn}`)
  })

program
  .command('prepare-branch')
  .description("Check out (or create) the card's branch.")
  .argument('<key>', 'Issue key')
  .action(async (key: string) => {
    const issue = await jira.getIssue(jira.configFromEnv(), key)
    const summary = (issue.fields['summary'] as string) ?? key
    console.log(prepareBranch(key, summary))
  })

// The merge, in three subcommands rather than one, because the middle of it runs
// an agent: `merge-begin` leaves a conflicted merge in the index and describes it
// in .agent/in/merge.json, the agent resolves it in a step holding nothing but an
// Anthropic key, and `merge-finish` decides whether what came back is a commit or
// a question for the card. `.github/actions/merge-main` is the three of them in
// order and is the only thing that should be calling them.

program
  .command('merge-begin')
  .description('Start merging origin/main into the checked-out card branch.')
  .argument('<key>', 'Issue key')
  .action(async (key: string) => {
    const issue = await jira.getIssue(jira.configFromEnv(), key)
    const summary = (issue.fields['summary'] as string) ?? key
    recordMerge(attemptMerge(currentBranch()), key, summary)
  })

program
  .command('merge-finish')
  .description('Commit a resolved merge, or report the conflict on the card and stop the turn.')
  .action(() => {
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
  })

// The fan-out that keeps the review queue from going stale. `refresh-plan`
// names the cards, one `refresh` runs per card on its own runner.
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

program
  .command('refresh')
  .description("Merge main into one in-review card's branch, or hand it to the build agent.")
  .argument('<key>', 'Issue key')
  .requiredOption('--because-pr <number>', 'The pull request whose merge set this off', (v) =>
    Number.parseInt(v, 10),
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

program
  .command('evidence-slides')
  .description("Build the captioned walkthrough video from a capture run's screenshots.")
  .option('--dir <path>', 'Where the screenshots are', EVIDENCE_DIR)
  .option('--out <path>', 'Where the video goes', SLIDES_PATH)
  .action((opts: { dir: string; out: string }) => {
    // Every path out of here is exit 0, deliberately. A card that is finished
    // must reach a human whether or not a video could be made of it, so the
    // worst this command does is say why there isn't one and let `report` go
    // on without it.
    if (!existsSync(RESULT_PATH)) {
      console.log('evidence-slides: skipped — the turn wrote no result')
      return
    }
    const parsed = ResultSchema.safeParse(JSON.parse(readFileSync(RESULT_PATH, 'utf8')))
    if (!parsed.success) {
      console.log('evidence-slides: skipped — the result does not parse')
      return
    }

    const outcome = buildSlides({ result: parsed.data, dir: opts.dir, out: opts.out })
    if (outcome.missing.length > 0) {
      console.log(`evidence-slides: no screenshot for step(s) ${outcome.missing.join(', ')}`)
    }
    if (outcome.orphans.length > 0) {
      console.log(
        `::warning::evidence-slides: dropped screenshot(s) for step(s) ${outcome.orphans.join(', ')}, which the card does not list`,
      )
    }
    console.log(
      outcome.ok
        ? `evidence-slides: ${outcome.slides} slide(s) → ${outcome.video}`
        : `evidence-slides: no video — ${outcome.reason}`,
    )
  })

// The bookends of a turn. `announce` says it has started, `report` says what
// it did — and between them the card would otherwise be silent for however
// long the agent takes, because a status change notifies nobody.
program
  .command('announce')
  .description('Comment on the card to say this turn has started.')
  .option('--dry-run', 'Print the comment without posting', false)
  .action(async (opts: { dryRun: boolean }) => {
    await announce({ dryRun: opts.dryRun })
  })

program
  .command('report')
  .description('Post the Jira comment and apply the status transition for this turn.')
  .requiredOption('--stage <stage>', 'design | build')
  .option('--pr-url <url>', 'Pull request URL to link')
  .option('--dry-run', 'Print the comment without posting', false)
  .action(async (opts: { stage: string; prUrl?: string; dryRun: boolean }) => {
    await report({ stage: parseStage(opts.stage), prUrl: opts.prUrl, dryRun: opts.dryRun })
  })

program
  .command('preview-up')
  .description('Build and push the PR image, and record a preview Deployment.')
  .argument('<pr>', 'PR number', (v) => Number.parseInt(v, 10))
  .option('--dry-run', 'Print what would happen', false)
  .action(async (pr: number, opts: { dryRun: boolean }) => {
    console.log(await previewUp(pr, opts.dryRun))
  })

program
  .command('preview-down')
  .description('Mark the preview deployment inactive and delete the PR image.')
  .argument('<pr>', 'PR number', (v) => Number.parseInt(v, 10))
  .option('--dry-run', 'Print what would happen', false)
  .action((pr: number, opts: { dryRun: boolean }) => {
    previewDown(pr, opts.dryRun)
  })

// The two halves of shipping, kept apart on purpose. `production-up` proves
// the site is live; `ship` tells Jira. Running them as one command would make
// "the card says Done" and "the deployment answered" a single fallible step,
// and the ordering between them is the whole point.
program
  .command('production-up')
  .description('Build the merge commit, deploy it to production, and wait for it to answer.')
  .argument('<sha>', 'The merge commit on main')
  .option('--dry-run', 'Print what would happen', false)
  .action(async (sha: string, opts: { dryRun: boolean }) => {
    console.log(await productionUp(sha, opts.dryRun))
  })

program
  .command('ship')
  .description('Move a merged card to Done and record where it went live.')
  .argument('<pr>', 'PR number', (v) => Number.parseInt(v, 10))
  .requiredOption('--url <url>', 'The production URL now serving this card')
  .option('--dry-run', 'Print the comment without posting or transitioning', false)
  .action(async (pr: number, opts: { url: string; dryRun: boolean }) => {
    await ship({ pr, url: opts.url, dryRun: opts.dryRun })
  })

program
  .command('kickoff')
  .description('Post the first-turn comment on a build PR.')
  .argument('<pr>', 'PR number', (v) => Number.parseInt(v, 10))
  .option('--dry-run', 'Print the comment without posting', false)
  .action((pr: number, opts: { dryRun: boolean }) => {
    kickoff(pr, opts.dryRun)
  })

program
  .command('emit-schema')
  .description('Regenerate .agent/result.schema.json from factory/src/schema.ts.')
  .action(() => {
    const path = resolve(REPO_ROOT, '.agent/result.schema.json')
    writeFileEnsuringDir(path, `${JSON.stringify(toJsonSchema(), null, 2)}\n`)
    console.log(path)
  })

program
  .command('meta')
  .description('Print the current turn metadata (debugging aid).')
  .action(() => {
    console.log(JSON.stringify(readMeta(), null, 2))
  })

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof jira.JiraAuthError) {
      console.error(error.message)
      process.exit(EXIT.AUTH)
    }
    if (error instanceof jira.JiraTransitionError) {
      console.error(error.message)
      process.exit(EXIT.TRANSITION)
    }
    console.error((error as Error).message)
    process.exit(EXIT.ERROR)
  }
}

await main()
