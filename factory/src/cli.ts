import { resolve } from 'node:path'
import { Command } from 'commander'
import { REPO_ROOT, loadDotEnv, required } from './env.ts'
import * as jira from './jira.ts'
import { gather } from './gather.ts'
import { prepareBranch } from './branch.ts'
import { triagePass } from './triage.ts'
import { findPrForCard } from './github.ts'
import { validate } from './validate.ts'
import { publish } from './publish.ts'
import { report } from './report.ts'
import { kickoff, previewDown, previewUp } from './preview.ts'
import { readMeta, turnBase, writeFileEnsuringDir } from './meta.ts'
import { Stage, toJsonSchema } from './schema.ts'

loadDotEnv()

/**
 * Exit codes are part of the contract with the workflows:
 *   0 ok · 1 unexpected · 2 Jira auth · 3 no such transition · 4 validation failed
 */
const EXIT = { OK: 0, ERROR: 1, AUTH: 2, TRANSITION: 3, VALIDATION: 4 } as const

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
    const branch = prepareBranch(key, summary)
    console.log(branch)
  })

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
  .action((pr: number, opts: { dryRun: boolean }) => {
    console.log(previewUp(pr, opts.dryRun))
  })

program
  .command('preview-down')
  .description('Mark the preview deployment inactive and delete the PR image.')
  .argument('<pr>', 'PR number', (v) => Number.parseInt(v, 10))
  .option('--dry-run', 'Print what would happen', false)
  .action((pr: number, opts: { dryRun: boolean }) => {
    previewDown(pr, opts.dryRun)
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
