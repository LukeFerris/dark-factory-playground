import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './env.ts'

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
