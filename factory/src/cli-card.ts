// The commands that read or move a card on the board: the poller's sources,
// the lock, and the claim.
import type { Command } from 'commander'
import { required } from './env.ts'
import * as jira from './jira.ts'
import { triagePass } from './triage.ts'
import { releaseOrphans, stop, takeCard } from './lock.ts'
import { findPrForCard } from './github.ts'
import { claimCard, sentInBy } from './progress.ts'

export function registerCardCommands(program: Command): void {
  jiraSearch(program)
  triage(program)
  stopCommand(program)
  releaseOrphansCommand(program)
  jiraTake(program)
  cardPr(program)
  jiraTransition(program)
  jiraClaim(program)
}

function jiraSearch(program: Command): void {
  program
    .command('jira-search')
    .description('Run a JQL query and print matching issue keys, one per line.')
    .argument('<jql>', 'JQL query')
    .action(async (jql: string) => {
      const issues = await jira.search(jira.configFromEnv(), jql)
      for (const issue of issues) console.log(issue.key)
    })
}

// The third poller source, and the only one that reads rather than counts.
// Unlike jira-search this does the whole job itself — decide, move, explain,
// dispatch — because the four steps have an order that matters and splitting
// them across shell would put that order in a place nothing can test.
function triage(program: Command): void {
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
}

function stopCommand(program: Command): void {
  program
    .command('stop')
    .description('Act on "@Enki stop": cancel the card\'s run and put the card back.')
    .argument('<key>', 'Issue key, e.g. DF-1')
    .option('--dry-run', 'Check and print, but cancel nothing and move nothing', false)
    .action(async (key: string, opts: { dryRun: boolean }) => {
      const outcome = await stop({ cfg: jira.configFromEnv(), key, dryRun: opts.dryRun })
      console.log(`stop: ${key} -> ${outcome}`)
    })
}

function releaseOrphansCommand(program: Command): void {
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
}

function jiraTake(program: Command): void {
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
}

function cardPr(program: Command): void {
  program
    .command('card-pr')
    .description("Print the open pull request number for a card's branch.")
    .argument('<key>', 'Issue key, e.g. DF-1')
    .action((key: string) => {
      const pr = findPrForCard(key)
      if (pr === null) throw new Error(`No open pull request on a card/${key}-* branch.`)
      console.log(pr.number)
    })
}

function jiraTransition(program: Command): void {
  program
    .command('jira-transition')
    .description('Move a card to a status, matched by destination status name.')
    .argument('<key>', 'Issue key, e.g. DF-1')
    .argument('<status>', 'Target status name, e.g. "Design review"')
    .action(async (key: string, status: string) => {
      await jira.transitionTo(jira.configFromEnv(), key, status)
      console.log(`${key} -> ${status}`)
    })
}

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
function jiraClaim(program: Command): void {
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
}
