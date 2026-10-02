import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './env.ts'
import { TRIAGE_STATUSES } from './triage.ts'

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

  // An avatar is decoration on the work; the work is the dispatch below it.
  // claimCard already warns rather than throwing, and `|| true` is the second
  // belt — `set -e` is on in that step.
  it('never lets a failed claim stop the dispatch', () => {
    expect(yaml).toContain('jira-claim "$key" || true')
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
 * The comment rule's status list, against the one the code actually uses.
 *
 * Rule 2 in JIRA-TRIGGERS.md only fires for comments on cards in the statuses
 * triage looks at, so that a comment anywhere else does not buy a billed minute
 * to discover there is nothing to do. The live list is in Jira, where no test
 * can reach it. This stops the document drifting from the code, so that the
 * route by hand, at least, is right.
 */
describe('the comment rule in JIRA-TRIGGERS.md', () => {
  const doc = readFileSync(resolve(REPO_ROOT, 'docs/factory/JIRA-TRIGGERS.md'), 'utf8')
  const row = doc.split('\n').find((line) => line.includes('Issue fields condition'))

  it('names exactly the statuses triage looks at', () => {
    expect(row).toBeDefined()
    const named = [...(row ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1])
    expect(named).toEqual([...TRIAGE_STATUSES])
  })
})

/**
 * The same list, in the script that creates the rule.
 *
 * bootstrap/jira-triggers.sh writes the comment flow's status condition from
 * its own copy of the list, because a shell script cannot import triage.ts.
 * The flow it creates is only as current as that copy.
 */
describe('the comment rule in bootstrap/jira-triggers.sh', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'bootstrap/jira-triggers.sh'), 'utf8')
  const line = script.split('\n').find((candidate) => candidate.startsWith('TRIAGE_STATUSES=('))

  it('names exactly the statuses triage looks at', () => {
    expect(line).toBeDefined()
    const named = [...(line ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(named).toEqual([...TRIAGE_STATUSES])
  })
})
