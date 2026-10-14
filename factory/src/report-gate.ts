import * as adf from './adf.ts'
import type { WorkflowResult } from './baseline.ts'
import { dispatchWorkflow, markReady, prBodyAndBranch, updatePrBody } from './github.ts'
import * as jira from './jira.ts'
import { raiseMainRed, withMainRed, type Raised } from './mainred.ts'
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
 * main's required checks on the commit it pushed, and the workflows `verify`
 * dispatched there, less any test main fails as well (ADR 0010).
 *
 * Kept apart from `report` and `report-comment` so that both can use it
 * without either reaching into the other.
 */

/**
 * What became of a finished build turn at the gate: main's required checks and
 * the dispatched workflows on the commit it pushed, and what the factory does
 * about them. Only a build turn that ends `ready_for_review` has one.
 */
export interface Gate {
  decision: Decision
  verdict: Verdict | null
  /** The cards for failures excused because main fails them too. */
  raised?: Raised[]
}

/** Whether a turn has to clear the gate before it can be handed over. */
export function gated(stage: Stage, result: Result): boolean {
  return stage === 'build' && result.status === 'ready_for_review'
}

/** The comment's first line for a turn that reached the gate. */
export function gateHeadline(stage: Stage, gate: Gate): string {
  const headlines: Record<Decision['action'], string> = {
    ready: `${stage} turn finished — ready for review`,
    retry: `${stage} turn finished — checks failed, trying again`,
    blocked: `${stage} turn finished — checks not passing`,
  }
  return headlines[gate.decision.action]
}

/** What a check that did not pass did instead, in words. */
const NOT_PASSING: Record<Exclude<CheckResult['state'], 'pass' | 'fail'>, string> = {
  pending: 'still running',
  missing: 'never reported',
  stale: 'skipped on the push, and never run again when asked',
}

const details = (url: string | null): adf.AdfNode[] =>
  url === null || url === '' ? [] : [adf.text(' ('), adf.link('details', url), adf.text(')')]

function checkInline(c: CheckResult): adf.AdfNode[] {
  const said =
    c.state === 'pass' || c.state === 'fail' ? (c.conclusion ?? 'failed') : NOT_PASSING[c.state]
  return [adf.strong(c.name), adf.text(` — ${said}`), ...details(c.url)]
}

function runInline(r: WorkflowResult): adf.AdfNode[] {
  let said: string
  if (r.state === 'missing') said = 'could not be started'
  else if (r.state === 'pending')
    said = (r.note ?? 'still running').replace(/\.$/, '').toLowerCase()
  else if (r.failed.length > 0) {
    const where = r.baseline === null ? '' : ' that pass on main'
    said = `${r.failed.length} test(s) failed${where}: ${shortList(r.failed)}`
  } else said = r.note ?? r.conclusion ?? 'failed'
  return [adf.strong(r.workflow), adf.text(` — ${said}`), ...details(r.url)]
}

/** A few test names, then how many more. */
function shortList(tests: string[], shown = 5): string {
  const head = tests.slice(0, shown).join('; ')
  return tests.length > shown ? `${head}; and ${tests.length - shown} more` : head
}

/**
 * The checks, as the gate found them: main's required checks and the
 * workflows `verify` dispatched. A green gate says so in a line; otherwise
 * everything that did not pass is listed, linked to its run. Failures excused
 * because main fails them too are listed either way, with their cards.
 */
export function gateSection(gate: Gate): adf.AdfNode[] {
  const blocks: adf.AdfNode[] = [adf.heading('Checks', 4)]
  const { verdict } = gate
  if (verdict === null) {
    return [...blocks, adf.paragraph(adf.text('The factory could not read them.'))]
  }
  const commit = verdict.sha.slice(0, 7)
  const checks = verdict.checks.filter((c) => c.state !== 'pass')
  const runs = verdict.workflows.filter((r) => r.state !== 'pass' && r.state !== 'excused')
  if (checks.length === 0 && runs.length === 0) {
    const total = verdict.checks.length + verdict.workflows.length
    const how = verdict.workflows.some((r) => r.state === 'excused')
      ? 'passed or were excused'
      : 'passed'
    const said = total === 0 ? 'Main requires none.' : `All ${total} ${how} on commit ${commit}.`
    blocks.push(adf.paragraph(adf.text(said)))
  } else {
    blocks.push(
      adf.paragraph(adf.text(`On commit ${commit}:`)),
      adf.bulletList([...checks.map(checkInline), ...runs.map(runInline)]),
    )
  }
  return [...blocks, ...excusedSection(gate, verdict)]
}

/** The tests main fails as well, each with its card. */
function excusedSection(gate: Gate, verdict: Verdict): adf.AdfNode[] {
  const excused = verdict.workflows.flatMap((r) =>
    r.excused.map((test) => ({ workflow: r.workflow, test })),
  )
  if (excused.length === 0) return []
  return [
    adf.paragraph(adf.text('Failing on main as well, so not held against this card:')),
    adf.bulletList(
      excused.map(({ workflow, test }) => {
        const card =
          gate.raised?.find((r) => r.workflow === workflow && r.test === test)?.key ?? null
        return [adf.text(test), adf.text(card === null ? ' — no card raised' : ` — ${card}`)]
      }),
    ),
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
 * Finds or raises a card for each failure the gate excused, and lists them in
 * the pull request's body. Whatever goes wrong here is logged and passed over:
 * the turn's own hand-off matters more.
 */
export async function mainRed(
  cfg: jira.JiraConfig,
  card: { key: string; pr: number | null },
  pr: string | null,
  gate: Gate,
): Promise<void> {
  const workflows = gate.verdict?.workflows ?? []
  gate.raised = await raiseMainRed(cfg, card.key, workflows, pr)
  const number = card.pr
  if (number === null) return
  try {
    const { body } = prBodyAndBranch(number)
    const base = workflows.find((r) => r.excused.length > 0)?.baseline?.sha ?? null
    const next = withMainRed(body, gate.raised, base)
    if (next.trimEnd() !== body.trimEnd()) updatePrBody(number, next)
  } catch (error) {
    console.error(
      `report: could not list the failures main has on the pull request: ${(error as Error).message}`,
    )
  }
}

/** What `report --dry-run` says of the gate, beyond the comment it would post. */
export function logDryRunGate(gate: Gate): void {
  console.log(`report --dry-run: the gate says ${JSON.stringify(gate.decision)}`)
  const excused = gate.verdict?.workflows.flatMap((r) => r.excused) ?? []
  if (excused.length > 0) {
    console.log(`report --dry-run: would find or raise a card for each of ${excused.join(', ')}`)
  }
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
