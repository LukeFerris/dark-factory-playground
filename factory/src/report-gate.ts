import * as adf from './adf.ts'
import { dispatchWorkflow, markReady } from './github.ts'
import * as jira from './jira.ts'
import { releaseCard } from './progress.ts'
import type { Result, Stage } from './schema.ts'
import {
  MAX_RETRIES,
  decide,
  readVerdict,
  type CheckResult,
  type Decision,
  type Verdict,
} from './verify.ts'

/**
 * What `report` does at the gate a finished build has to clear (ADR 0009):
 * main's required checks on the commit it pushed, read by `verify`.
 *
 * Kept apart from `report` and `report-comment` so that both can use it
 * without either reaching into the other.
 */

/**
 * What became of a finished build turn at the gate: main's required checks on
 * the commit it pushed, and what the factory does about them. Only a build turn
 * that ends `ready_for_review` has one.
 */
export interface Gate {
  decision: Decision
  verdict: Verdict | null
}

/** Whether a turn has to clear the gate before it can be handed over. */
export function gated(stage: Stage, result: Result): boolean {
  return stage === 'build' && result.status === 'ready_for_review'
}

/** The comment's first line for a turn that reached the gate. */
export function gateHeadline(stage: Stage, gate: Gate): string {
  const headlines: Record<Decision['action'], string> = {
    ready: `${stage} turn finished — ready for review`,
    retry: `${stage} turn finished — required checks failed, trying again`,
    blocked: `${stage} turn finished — required checks not passing`,
  }
  return headlines[gate.decision.action]
}

/** What a check that did not pass did instead, in words. */
const NOT_PASSING: Record<Exclude<CheckResult['state'], 'pass' | 'fail'>, string> = {
  pending: 'still running',
  missing: 'never reported',
  stale: 'skipped on the push, and never run again when asked',
}

function checkInline(c: CheckResult): adf.AdfNode[] {
  const said =
    c.state === 'pass' || c.state === 'fail' ? (c.conclusion ?? 'failed') : NOT_PASSING[c.state]
  const inline: adf.AdfNode[] = [adf.strong(c.name), adf.text(` — ${said}`)]
  if (c.url !== null && c.url !== '') {
    inline.push(adf.text(' ('), adf.link('details', c.url), adf.text(')'))
  }
  return inline
}

/**
 * The required checks, as the gate found them. A green gate says so in a line;
 * otherwise every check that did not pass is listed, linked to its run.
 */
export function gateSection(gate: Gate): adf.AdfNode[] {
  const heading = adf.heading('Required checks', 4)
  const { verdict } = gate
  if (verdict === null) {
    return [heading, adf.paragraph(adf.text('The factory could not read them.'))]
  }
  const commit = verdict.sha.slice(0, 7)
  const notPassing = verdict.checks.filter((c) => c.state !== 'pass')
  if (notPassing.length === 0) {
    const said =
      verdict.checks.length === 0
        ? 'Main requires none.'
        : `All ${verdict.checks.length} passed on commit ${commit}.`
    return [heading, adf.paragraph(adf.text(said))]
  }
  return [
    heading,
    adf.paragraph(adf.text(`On commit ${commit}:`)),
    adf.bulletList(notPassing.map(checkInline)),
  ]
}

/**
 * What happens next after a gate that did not pass, or `null` after one that
 * did: a green build reads like any other finished build.
 */
export function gateNext(gate: Gate): string | null {
  const { decision } = gate
  if (decision.action === 'retry') {
    return (
      'The card stays in Building and the pull request stays a draft. Another build turn has ' +
      `started to fix the failing checks (automatic turn ${decision.next} of ${MAX_RETRIES}), ` +
      'and its report will follow here.'
    )
  }
  if (decision.action === 'blocked') {
    return (
      `${decision.why} The pull request stays a draft until they pass. Reply on this card ` +
      'with how to go on — a comment here is read on the next poll and starts the next turn from it.'
    )
  }
  return null
}

/**
 * Reads the verdict `verify` left and decides on it. A green one takes the
 * pull request out of draft here, before the comment is written, so that a
 * pull request that will not come out of draft sends the card to a person
 * rather than to In review.
 */
export function atTheGate(pr: number | null, retry: number, dryRun: boolean): Gate {
  const verdict = readVerdict()
  let decision = decide(verdict, retry)
  if (decision.action === 'ready' && pr !== null && !dryRun) {
    try {
      markReady(pr)
    } catch (error) {
      decision = {
        action: 'blocked',
        why: `The required checks passed, but the pull request would not come out of draft: ${(error as Error).message}.`,
      }
    }
  }
  return { decision, verdict }
}

/**
 * Starts the next automatic turn. The card waits in Building for it, so a
 * dispatch that fails would leave it there with nothing running: it goes to a
 * person instead.
 */
export async function startRetry(cfg: jira.JiraConfig, key: string, next: number): Promise<void> {
  try {
    dispatchWorkflow('build-turn.yml', { key, retry: String(next) })
    console.log(
      `report: ${key} stays in Building; automatic turn ${next} of ${MAX_RETRIES} started.`,
    )
  } catch (error) {
    console.error(`::error::could not start the next turn on ${key}: ${(error as Error).message}`)
    process.exitCode = 3
    await handBackAfterAll(cfg, key)
  }
}

/** Says on the card that the retry did not start, and gives it to a person. */
async function handBackAfterAll(cfg: jira.JiraConfig, key: string): Promise<void> {
  const said = adf.doc(
    adf.paragraph(
      adf.text(
        'The next turn could not be started after all, so this card is going to Blocked on ' +
          'engineer instead. The pull request stays a draft. Reply here to start a turn.',
      ),
    ),
  )
  await jira
    .addComment(cfg, key, said)
    .catch((second: Error) =>
      console.error(`report: could not say so on ${key}: ${second.message}`),
    )
  await releaseCard(cfg, key)
  await jira.transitionTo(cfg, key, 'Blocked on engineer').catch((second: Error) => {
    console.error(`report: could not move ${key} to Blocked on engineer either: ${second.message}`)
  })
}
