import { runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import { dispatchWorkflow } from './github.ts'
import { claimCard } from './progress.ts'
import {
  askClaude,
  type Classifier,
  type TriageAction,
  type TriageContext,
  type TriageDecision,
} from './triage-classifier.ts'

/**
 * Comment triage.
 *
 * The poller's other two sources are unambiguous: a human dragged a card into
 * "Ready for design" or "Ready for build" and assigned it to the factory, and
 * that *is* the instruction. Comments are not like that. A card the factory
 * stopped on collects answers and requests, but also asides, thanks and notes
 * between people, and only some of them mean "go and do something". So each
 * new one gets read — by a small model, once — and turned into one of three
 * answers: wake the design agent, wake the build agent, or do nothing.
 *
 * Three things keep this from being expensive or noisy:
 *
 *   - Only cards in the four statuses below are looked at, and in the two
 *     review statuses only comments that @mention the factory. A card in
 *     "Designing" or "Building" already has an agent running on its branch,
 *     and a card in "Backlog" or "Done" is not the factory's problem.
 *   - Only cards whose newest comment is not the factory's own get read at
 *     all, which in the steady state is almost none of them.
 *   - Every comment considered is recorded on the card as a hidden property,
 *     so a comment judged "no action" is judged once and never again. Without
 *     that mark it would stay the newest comment forever and be re-read on
 *     every pass.
 */

/** The hidden issue property holding the high-water mark. */
export const TRIAGE_PROPERTY = 'factory-triage'

/**
 * Where the factory stopped to ask a question.
 *
 * The card has been handed back to a person, who answers by commenting, so any
 * comment from a person is read.
 */
export const QUESTION_STATUSES = ['Blocked on architect', 'Blocked on engineer'] as const

/**
 * Where the factory thinks it is done and a person is reviewing.
 *
 * A comment here is as likely to be for a colleague as for the factory, so
 * only one that @mentions the factory is read. That is how a reviewer asks for
 * more without leaving the card; dragging it to a "Ready for …" column and
 * assigning it to the factory works too, and is polled, not triaged.
 */
export const REVIEW_STATUSES = ['Design review', 'In review'] as const

/** Every status triage looks at. The "Ready for …" columns are polled instead. */
export const TRIAGE_STATUSES = [...QUESTION_STATUSES, ...REVIEW_STATUSES] as const

/**
 * How far back a review card is read for a mention of the factory.
 *
 * The mention has to be newer than the factory's own last comment, and the
 * Automation flow starts a pass within seconds of it, so it is near the top.
 */
const REVIEW_LOOKBACK = 20

/** What each actionable decision does to the card. */
export const TRIAGE_ROUTES = {
  design: { agent: 'design', status: 'Designing', workflow: 'design.yml' },
  build: { agent: 'build', status: 'Building', workflow: 'build-turn.yml' },
} as const

export interface TriageOutcome {
  key: string
  status: string
  action: TriageAction
  reason: string
  /** False when the decision was made but acting on it failed partway. */
  acted: boolean
}

export interface TriageOptions {
  cfg: jira.JiraConfig
  projectKey: string
  /** Swapped out in tests so nothing reaches the network. */
  classify?: Classifier
  /** Decide and print, but change nothing and start nothing. */
  dryRun?: boolean
}

/** The mark left by the last triage pass, or '' if this card has never had one. */
function consideredCommentId(issue: jira.JiraIssue): string {
  const mark = issue.properties?.[TRIAGE_PROPERTY] as { commentId?: string } | undefined
  return mark?.commentId ?? ''
}

/**
 * Says on the card why it just moved.
 *
 * Only actionable decisions get a comment. A "no action" decision is recorded
 * silently in the issue property: a card that collects a line of factory
 * commentary every time somebody says "nice one" is worse than one that says
 * nothing, and the reasoning is in the poller's log either way.
 */
export function triageComment(
  decision: TriageDecision,
  route: (typeof TRIAGE_ROUTES)[keyof typeof TRIAGE_ROUTES],
  comment: jira.JiraComment,
  run: string | null,
): adf.AdfDoc {
  const blocks: adf.AdfNode[] = [
    adf.paragraph(
      adf.strong('Picked up from a comment.'),
      adf.text(
        ` ${comment.author}'s comment above reads as work for the ${route.agent} agent, so this ` +
          `card is going to ${route.status} and a ${route.agent} turn is starting.`,
      ),
    ),
    adf.paragraph(adf.text(decision.reason.trim())),
  ]
  if (run !== null) blocks.push(adf.paragraph(adf.link('Actions run', run)))
  return adf.doc(...blocks)
}

/**
 * One pass over every card a comment could wake up.
 *
 * Per-card failures are warned about and stepped over rather than thrown: one
 * card with an unreachable transition must not stop the other nine being
 * looked at, and the poller runs again in thirty seconds anyway.
 */
export async function triagePass(options: TriageOptions): Promise<TriageOutcome[]> {
  const { cfg, projectKey } = options

  const statuses = TRIAGE_STATUSES.map((status) => `"${status}"`).join(', ')
  const cards = await jira.search(
    cfg,
    `project = ${projectKey} AND status IN (${statuses}) ORDER BY created ASC`,
    ['status', 'summary'],
    [TRIAGE_PROPERTY],
  )
  if (cards.length === 0) return []

  const me = await jira.myAccountId(cfg)
  const outcomes: TriageOutcome[] = []

  for (const card of cards) {
    const outcome = await triageCard(options, card, me)
    if (outcome !== null) outcomes.push(outcome)
  }

  return outcomes
}

/** Reads, decides and acts on one card. Null when there was nothing to decide. */
async function triageCard(
  options: TriageOptions,
  card: jira.JiraIssue,
  me: string,
): Promise<TriageOutcome | null> {
  const { cfg } = options
  const status = ((card.fields['status'] as { name?: string } | undefined)?.name ?? '').trim()
  const summary = (card.fields['summary'] as string) ?? card.key

  const comment = await commentToTriage(cfg, card, status, me)
  if (comment === null) return null

  const decision = await decide(options, { key: card.key, summary, status, comment }, me)
  if (decision === null) return null

  return {
    key: card.key,
    status,
    action: decision.action,
    reason: decision.reason,
    acted: options.dryRun === true ? false : await act(options, card.key, comment, decision),
  }
}

/**
 * The comment on this card that is waiting to be read, or null.
 *
 * Null when the factory spoke last, when a card in review has no comment
 * addressed to the factory since, or when the comment is the one the last pass
 * already considered.
 */
async function commentToTriage(
  cfg: jira.JiraConfig,
  card: jira.JiraIssue,
  status: string,
  me: string,
): Promise<jira.JiraComment | null> {
  const newest = await jira.latestComment(cfg, card.key)
  if (!jira.isAnswered(newest, me)) return null
  const comment = isReview(status)
    ? addressedTo(await jira.recentComments(cfg, card.key, REVIEW_LOOKBACK), me)
    : newest
  if (comment === null) return null
  if (comment.id !== '' && comment.id === consideredCommentId(card)) return null
  return comment
}

/** Asks the classifier about one comment. Null, with a warning, if it could not answer. */
async function decide(
  options: TriageOptions,
  card: Omit<TriageContext, 'lastFactoryComment'>,
  me: string,
): Promise<TriageDecision | null> {
  const classify = options.classify ?? askClaude
  try {
    return await classify({
      key: card.key,
      summary: card.summary,
      status: card.status,
      lastFactoryComment: await lastFactoryComment(options.cfg, card.key, me),
      comment: card.comment,
    })
  } catch (error) {
    // No mark is written, so the same comment is reconsidered next pass. A
    // classifier that is down should delay triage, not silently skip it.
    console.error(`::warning::could not triage ${card.key}: ${(error as Error).message}`)
    return null
  }
}

function isReview(status: string): boolean {
  return (REVIEW_STATUSES as readonly string[]).includes(status)
}

/**
 * The newest comment since the factory last spoke that @mentions it, or null.
 *
 * Takes the thread newest first. A colleague replying underneath a request to
 * the factory does not hide the request; a comment from before the factory's
 * own last word has been dealt with, by that turn.
 */
export function addressedTo(
  newestFirst: jira.JiraComment[],
  factoryAccountId: string,
): jira.JiraComment | null {
  for (const comment of newestFirst) {
    if (comment.authorId === factoryAccountId) return null
    if (comment.mentions.includes(factoryAccountId)) return comment
  }
  return null
}

/** The factory's own most recent comment, for context. '' if it has never spoken. */
async function lastFactoryComment(cfg: jira.JiraConfig, key: string, me: string): Promise<string> {
  const thread = await jira.getComments(cfg, key)
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const comment = thread[i] as jira.JiraComment
    if (comment.authorId === me) return comment.body
  }
  return ''
}

/**
 * Carries out a decision.
 *
 * The order is move, claim, explain, mark, dispatch, and each step is placed so
 * that failing at it leaves the least bad state:
 *
 *   move      first, because it is the step that can legitimately fail — a
 *             status the workflow will not allow. Nothing has happened yet, no
 *             mark is written, and the next pass tries the whole thing again.
 *   claim     straight after the move, because the status and the avatar are
 *             the same statement and a card wearing neither looks unclaimed.
 *             The card goes back to whoever wrote the comment when the turn
 *             ends: they answered the question, so the result is theirs.
 *             Not before it, or a card the move rejected would be left
 *             assigned to a factory that does not have it. Warns rather than
 *             throws, like everything else in progress.ts.
 *   explain   not fatal. The card has already moved and the agent will comment
 *             when its turn ends, so a failed comment costs an explanation,
 *             not the work.
 *   mark      after the move, by which point the card has left the statuses
 *             triage watches and cannot be reconsidered regardless.
 *   dispatch  last. A failure here leaves the card claimed with nothing
 *             running — loud in the log, visible on the board, and the same
 *             thing that happens when the poller's own dispatch fails.
 */
async function act(
  options: TriageOptions,
  key: string,
  comment: jira.JiraComment,
  decision: TriageDecision,
): Promise<boolean> {
  const { cfg } = options
  if (decision.action === 'none') {
    await mark(cfg, key, comment, decision).catch((error: Error) => {
      // Not marking it means reading it again next pass: wasteful, not wrong.
      console.error(`::warning::could not mark ${key} as triaged: ${error.message}`)
    })
    return true
  }

  const route = TRIAGE_ROUTES[decision.action]

  try {
    await jira.transitionTo(cfg, key, route.status)
  } catch (error) {
    console.error(
      `::warning::could not move ${key} to ${route.status}: ${(error as Error).message}`,
    )
    return false
  }

  await claimCard(cfg, key, comment.authorId)

  await jira
    .addComment(cfg, key, triageComment(decision, route, comment, runUrl()))
    .catch((error: Error) => {
      console.error(`::warning::moved ${key} but could not say why: ${error.message}`)
    })

  await mark(cfg, key, comment, decision).catch((error: Error) => {
    console.error(`::warning::could not mark ${key} as triaged: ${error.message}`)
  })

  try {
    dispatchWorkflow(route.workflow, { key })
  } catch (error) {
    console.error(
      `::error::${key} was moved to ${route.status} but ${route.workflow} could not be ` +
        `dispatched (${(error as Error).message}); re-run it by hand`,
    )
    return false
  }

  return true
}

function mark(
  cfg: jira.JiraConfig,
  key: string,
  comment: jira.JiraComment,
  decision: TriageDecision,
): Promise<void> {
  return jira.setIssueProperty(cfg, key, TRIAGE_PROPERTY, {
    commentId: comment.id,
    action: decision.action,
    at: new Date().toISOString(),
  })
}
