import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './env.ts'
import { QUESTION_STATUSES, REVIEW_STATUSES } from './triage.ts'

/**
 * The poller's claim, as written in the workflow.
 *
 * Its dispatch loop is shell, so there is nothing here to call. What these
 * pin is the order of the three commands in it, which is the whole of the
 * design: the transition is the gate that stops a card being handed to two
 * agents, the claim is what puts the factory's avatar on the board at the same
 * moment, and the dispatch comes last because a failure there is the one that
 * leaves a card claimed with nothing running.
 */
describe('how the poller claims a card', () => {
  const yaml = readFileSync(resolve(REPO_ROOT, '.github/workflows/poller.yml'), 'utf8')

  const transition = yaml.indexOf('jira-transition "$key"')
  const claim = yaml.indexOf('jira-claim "$key"')
  const dispatch = yaml.indexOf('gh workflow run "$workflow"')

  it('takes the assignee as well as the status', () => {
    expect(claim).toBeGreaterThan(-1)
  })

  // Before the move, a card the move then rejected would sit in "Ready for …"
  // wearing the bot's avatar — a claim on a card the factory does not have.
  it('claims after the move and before the dispatch', () => {
    expect(transition).toBeGreaterThan(-1)
    expect(dispatch).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(transition)
    expect(claim).toBeLessThan(dispatch)
  })

  // A hand-back is decoration on the work; the work is the dispatch below it.
  // claimCard already warns rather than throwing, and `|| true` is the second
  // belt — `set -e` is on in that step.
  it('never lets a failed claim stop the dispatch', () => {
    expect(yaml).toContain('jira-claim "$key" --from "$waiting_status" || true')
  })

  // The card goes back to whoever dragged it in, which only the history knows.
  it('hands the card back to whoever moved it into the column', () => {
    expect(yaml).toContain('--from "$waiting_status"')
  })
})

/**
 * Which cards the poller takes.
 *
 * A card in a Ready column is only the factory's if it is also assigned to the
 * factory, so people can keep cards on the same board that it never touches.
 * The poller runs as the factory's account, so `currentUser()` is the bot.
 */
describe('which cards the poller takes', () => {
  const yaml = readFileSync(resolve(REPO_ROOT, '.github/workflows/poller.yml'), 'utf8')
  const search = yaml.split('\n').find((line) => line.includes('jql="project = ${JIRA_PROJECT_KEY}'))

  it('takes only cards assigned to the factory', () => {
    expect(search).toBeDefined()
    expect(search).toContain('AND assignee = currentUser()')
  })
})

/**
 * What starts the poller.
 *
 * Jira does, via two Automation rules — see JIRA-TRIGGERS.md. The cron is
 * commented out rather than deleted because it is the fallback for a trigger
 * that depends on a token held outside this repository, so what needs pinning
 * is that it is *off*: an enabled `schedule:` alongside a working push trigger
 * is a runner up on a timer that nobody asked for, and on a private repository
 * that is the difference between pennies and a few hundred dollars a month.
 */
describe('how the poller is started', () => {
  const lines = readFileSync(resolve(REPO_ROOT, '.github/workflows/poller.yml'), 'utf8').split('\n')

  it('can be dispatched', () => {
    expect(lines).toContain('  workflow_dispatch:')
  })

  // Indentation is the assertion: a commented-out trigger is `  # schedule:`.
  it('has no cron', () => {
    expect(lines.filter((line) => /^\s*schedule:/.test(line))).toEqual([])
  })
})

/**
 * The comment rules' status lists, against the ones the code actually uses.
 *
 * Rule 2 in JIRA-TRIGGERS.md fires for any comment on a card where the factory
 * asked a question, and rule 2b for a comment that mentions the factory on a
 * card in review, so that a comment anywhere else does not buy a billed minute
 * to discover there is nothing to do. The live lists are in Jira, where no test
 * can reach them. This stops the document drifting from the code, so that the
 * route by hand, at least, is right.
 */
describe('the comment rules in JIRA-TRIGGERS.md', () => {
  const doc = readFileSync(resolve(REPO_ROOT, 'docs/factory/JIRA-TRIGGERS.md'), 'utf8')
  const rows = doc.split('\n').filter((line) => line.includes('Issue fields condition'))
  const named = (row: string | undefined) => [...(row ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1])

  it('has one status condition per comment rule', () => {
    expect(rows).toHaveLength(2)
  })

  it('names exactly the question statuses in rule 2', () => {
    expect(named(rows[0])).toEqual([...QUESTION_STATUSES])
  })

  it('names exactly the review statuses in rule 2b', () => {
    expect(named(rows[1])).toEqual([...REVIEW_STATUSES])
  })
})

/**
 * The same lists, in the script that creates the rules.
 *
 * bootstrap/jira-triggers.sh writes the comment flows' status conditions from
 * its own copies of the lists, because a shell script cannot import triage.ts.
 * The flows it creates are only as current as those copies.
 */
describe('the comment rules in bootstrap/jira-triggers.sh', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'bootstrap/jira-triggers.sh'), 'utf8')
  const list = (name: string) => {
    const line = script.split('\n').find((candidate) => candidate.startsWith(`${name}=(`))
    return line === undefined ? undefined : [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  }

  it('names exactly the question statuses', () => {
    expect(list('QUESTION_STATUSES')).toEqual([...QUESTION_STATUSES])
  })

  it('names exactly the review statuses', () => {
    expect(list('REVIEW_STATUSES')).toEqual([...REVIEW_STATUSES])
  })
})
