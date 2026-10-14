import { createHash } from 'node:crypto'
import * as adf from './adf.ts'
import type { WorkflowResult } from './baseline.ts'
import * as jira from './jira.ts'

/**
 * A card for each test that fails on main, raised when `verify` excuses it on
 * a pull request (ADR 0010).
 *
 * Excusing a failure is only safe if somebody is told: otherwise main stays
 * red and every card after this one is excused the same way, for ever. So
 * each excused failure gets a card in the same space, in the status a new card
 * starts in, assigned to nobody. It is not Enki's until a person makes it so.
 *
 * Found before it is raised, by a label made from the workflow and the test:
 * the same failure excused on the next turn, or on another card, finds the
 * open card and raises nothing.
 */

/** Cards raised in one report, at most. A broken main fails everything. */
export const MAX_RAISED = 10

export interface Raised {
  workflow: string
  test: string
  /** The card for it, found or raised; null when neither happened. */
  key: string | null
  created: boolean
}

/** The label that marks the card for one test failing on main. */
export function labelFor(workflow: string, test: string): string {
  return `enki-main-red-${createHash('sha256').update(`${workflow}\n${test}`).digest('hex').slice(0, 12)}`
}

/** The space a card is in, from its key. */
const spaceOf = (key: string): string => key.replace(/-\d+$/, '')

const SUMMARY_MAX = 255

function summaryFor(test: string): string {
  const summary = `Failing on main: ${test}`
  return summary.length <= SUMMARY_MAX ? summary : `${summary.slice(0, SUMMARY_MAX - 1)}…`
}

function description(
  result: WorkflowResult,
  test: string,
  card: string,
  pr: string | null,
): adf.AdfDoc {
  const found: adf.AdfNode[] = [adf.text(`Enki found this while verifying ${card}`)]
  if (pr !== null) found.push(adf.text(' ('), adf.link('pull request', pr), adf.text(')'))
  found.push(
    adf.text(
      `. The test failed on the pull request and again on main${
        result.baseline === null || result.baseline.sha === ''
          ? ''
          : ` at ${result.baseline.sha.slice(0, 7)}`
      }, so it was not held against ${card}. Until it is fixed, it is excused on every pull request it fails on.`,
    ),
  )
  const links: adf.AdfNode[] = []
  if (result.url !== null) links.push(adf.link('The pull request run', result.url))
  if (result.baseline?.url != null) {
    if (links.length > 0) links.push(adf.text('  ·  '))
    links.push(adf.link('The run on main', result.baseline.url))
  }
  return adf.doc(
    adf.paragraph(...found),
    adf.paragraph(adf.strong('Workflow: '), adf.text(result.workflow)),
    adf.paragraph(adf.strong('Test')),
    adf.codeBlock(test),
    ...(links.length > 0 ? [adf.paragraph(...links)] : []),
  )
}

/**
 * Finds or raises a card for every excused failure in `workflows`. Nothing in
 * here throws: a card that could not be raised is a line in the log and a
 * null key, never the reason a finished turn does not reach its reviewer.
 */
export async function raiseMainRed(
  cfg: jira.JiraConfig,
  card: string,
  workflows: WorkflowResult[],
  pr: string | null,
): Promise<Raised[]> {
  const excused = workflows.flatMap((result) => result.excused.map((test) => ({ result, test })))
  if (excused.length === 0) return []

  const space = spaceOf(card)
  const type = await typeToRaise(cfg, card)
  const raised: Raised[] = []
  let made = 0
  for (const { result, test } of excused) {
    const entry: Raised = { workflow: result.workflow, test, key: null, created: false }
    raised.push(entry)
    try {
      entry.key = await openCard(cfg, space, labelFor(result.workflow, test))
      if (entry.key !== null || type === null || made >= MAX_RAISED) continue
      entry.key = await jira.createIssue(cfg, {
        project: { key: space },
        issuetype: { id: type },
        summary: summaryFor(test),
        description: description(result, test, card, pr),
        labels: [labelFor(result.workflow, test)],
      })
      entry.created = true
      made += 1
      console.log(`report: raised ${entry.key} for ${test}, which fails on main too.`)
    } catch (error) {
      console.error(
        `report: could not find or raise a card for ${test}: ${(error as Error).message}`,
      )
    }
  }
  if (made >= MAX_RAISED && raised.some((r) => r.key === null)) {
    console.error(
      `report: raised the most cards one report may (${MAX_RAISED}); the rest have none yet.`,
    )
  }
  return raised
}

/**
 * The work type to raise a card as: the card's own, which the space is known
 * to take. Null for a subtask's, which cannot be raised without a parent, or
 * when the card cannot be read.
 */
async function typeToRaise(cfg: jira.JiraConfig, card: string): Promise<string | null> {
  try {
    const issuetype = (await jira.getIssue(cfg, card)).fields['issuetype'] as {
      id?: unknown
      subtask?: unknown
    } | null
    if (typeof issuetype?.id === 'string' && issuetype.subtask !== true) return issuetype.id
    console.error(`report: ${card} is a subtask, so no card is raised for what main fails.`)
  } catch (error) {
    console.error(
      `report: could not read ${card}'s work type, so no card is raised: ${(error as Error).message}`,
    )
  }
  return null
}

/** The oldest card still open in `space` with `label`, or null. */
async function openCard(
  cfg: jira.JiraConfig,
  space: string,
  label: string,
): Promise<string | null> {
  const open = await jira.search(
    cfg,
    `project = "${space}" AND labels = "${label}" AND statusCategory != Done ORDER BY created ASC`,
  )
  return open[0]?.key ?? null
}

/** Marks the part of the pull request body the factory keeps the list in. */
export const MAIN_RED_START = '<!-- enki:main-red -->'
export const MAIN_RED_END = '<!-- /enki:main-red -->'

/**
 * The pull request body with its list of excused failures brought up to date:
 * written in, rewritten, or taken out when there are none. A section of the
 * body, not a comment, because a comment on the pull request starts a turn.
 */
export function withMainRed(body: string, raised: Raised[], base: string | null): string {
  const pattern = new RegExp(`\\n*${escape(MAIN_RED_START)}[\\s\\S]*?${escape(MAIN_RED_END)}\\n*`)
  const without = body.replace(pattern, '\n\n').trimEnd()
  if (raised.length === 0) return `${without}\n`

  const lines = [
    MAIN_RED_START,
    '### Failing on main as well',
    '',
    `These tests failed on this pull request and on main${base === null || base === '' ? '' : ` at ${base.slice(0, 7)}`} as ` +
      'well, so they do not hold it back. Each has a card of its own.',
    '',
    ...raised.map((r) => {
      return `- \`${r.test.replace(/`/g, "'")}\` (${r.workflow}) — ${r.key ?? 'no card yet'}`
    }),
    MAIN_RED_END,
  ]
  // Above the factory block, which stays last in the body.
  const block = without.search(/^<!-- factory[ \t]*$/m)
  if (block === -1) return `${without}\n\n${lines.join('\n')}\n`
  return `${without.slice(0, block).trimEnd()}\n\n${lines.join('\n')}\n\n${without.slice(block)}\n`
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
