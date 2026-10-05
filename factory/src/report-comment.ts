import { runUrl } from './env.ts'
import * as adf from './adf.ts'
import { SLIDES_FILENAME } from './evidence.ts'
import type { Criterion, Question, Result, Stage } from './schema.ts'

/**
 * The comments `report` posts, built and nothing more.
 *
 * Kept apart from `report` itself because everything in here is a pure
 * function of the turn's result: no Jira, no files, no environment beyond the
 * run link. That is what lets every section of the comment be pinned by a test
 * without standing up a card.
 */

export interface Evidence {
  /** The attachment id of the walkthrough video, when one was made. */
  video: string | null
  /**
   * Step numbers whose evidence is **on the card**.
   *
   * Not "was captured": a screenshot the pipeline took and then failed to
   * attach proves nothing to the reviewer reading the comment, and a step
   * marked as evidenced when the card holds no evidence for it is worse than
   * an unmarked one.
   */
  proved: number[]
}

/**
 * Where the comment points, and what evidence the card holds. A link is `null`
 * when there is nothing to point at; evidence defaults to none.
 */
export interface CommentOptions {
  prUrl: string | null
  previewUrl: string | null
  run: string | null
  evidence?: Evidence
}

/**
 * Builds the Jira comment for a finished turn.
 *
 * The shape is Summary / Context / Acceptance criteria / Proving it, then
 * whatever the turn needs a human to know. That is the house ticket template
 * plus a walkthrough, and the point of keeping to it is that a card written by
 * an agent reads the same as a card written by a person — so a reviewer
 * scanning the board does not have to switch modes.
 *
 * Every comment links to the Actions run that produced it — that is an
 * acceptance criterion, and it is what makes a surprising card state
 * diagnosable without going digging.
 */
export function buildComment(stage: Stage, result: Result, options: CommentOptions): adf.AdfDoc {
  const evidence = options.evidence ?? { video: null, proved: [] }
  return adf.doc(
    adf.heading(headline(stage, result.status)),
    ...summarySection(result),
    // Before the criteria, not after. Somebody who answered a question on this
    // card opens the next comment looking for one thing: what was made of their
    // reply. Burying that under the work makes them read the whole comment to
    // find out whether they were heard.
    ...bulletSection('Answers to your questions', result.answers, (a) => [
      adf.strong(a.question),
      adf.text(` — ${a.answer}`),
    ]),
    ...criteriaSection(stage, result.acceptance_criteria, evidence),
    // After the steps rather than before them: it answers the question a
    // reviewer asks once something has not happened, which is the moment they
    // reach it.
    ...bulletSection('Not in this change', result.out_of_scope, (s) => [adf.text(s)]),
    ...bulletSection('Questions', result.questions, questionInline),
    ...bulletSection('Assumptions', result.assumptions, (a) => [adf.text(a)]),
    ...failureSection(result),
    ...nextSection(stage, result),
    ...linksSection(options),
  )
}

/** The comment's first line: which turn, and where it got to. */
function headline(stage: Stage, status: Result['status']): string {
  const headlines: Record<Result['status'], string> = {
    ready_for_review: `${stage} turn finished — ready for review`,
    continue: `${stage} turn finished — more work to do`,
    blocked: `${stage} turn paused — needs an answer`,
    question: `${stage} turn paused — needs an answer`,
    failed: `${stage} turn failed`,
  }
  return headlines[status]
}

/** Summary always; Context only when the agent wrote one. */
function summarySection(result: Result): adf.AdfNode[] {
  const blocks = [adf.heading('Summary', 4), adf.paragraph(adf.text(result.summary.trim()))]
  if (result.context.trim() !== '') {
    blocks.push(adf.heading('Context', 4), adf.paragraph(adf.text(result.context.trim())))
  }
  return blocks
}

/**
 * A level-4 heading over a bullet list, or nothing at all when there is
 * nothing to list — an empty heading reads as a section somebody forgot.
 */
function bulletSection<T>(
  title: string,
  items: T[],
  render: (item: T) => adf.AdfNode[],
): adf.AdfNode[] {
  if (items.length === 0) return []
  return [adf.heading(title, 4), adf.bulletList(items.map(render))]
}

function questionInline(q: Question): adf.AdfNode[] {
  const inline: adf.AdfNode[] = [adf.strong(q.question)]
  if (q.context !== '') inline.push(adf.text(` — ${q.context}`))
  if (q.options.length > 0) inline.push(adf.text(` (options: ${q.options.join(' / ')})`))
  return inline
}

/**
 * Two sections, not one. The criteria are what a reviewer argues with; the
 * steps are what they do. Collapsing them into a single numbered list — which
 * is what this used to be — leaves nowhere to state what "done" means except
 * as a sequence of clicks.
 */
function criteriaSection(stage: Stage, criteria: Criterion[], evidence: Evidence): adf.AdfNode[] {
  if (criteria.length === 0) return []
  return [
    adf.heading('Acceptance criteria', 4),
    // A design turn has built nothing, so its criteria are a contract for the
    // build rather than something you can go and check. Saying which it is
    // stops a reviewer opening a preview that does not exist yet.
    ...(stage === 'design' ? [adf.paragraph(adf.text('What the build has to make true:'))] : []),
    adf.bulletList(criteria.map((c) => [adf.text(c.criterion)])),
    adf.heading('Proving it', 4),
    adf.paragraph(
      adf.text(
        stage === 'design'
          ? 'Once the build lands, with the app open in a browser:'
          : 'With the app open in a browser:',
      ),
    ),
    ...evidenceIntro(evidence),
    ...numberedSteps(criteria, evidence),
  ]
}

/** Where the evidence for the marked steps is, when any step has some. */
function evidenceIntro(evidence: Evidence): adf.AdfNode[] {
  if (evidence.proved.length === 0) return []
  return [
    adf.paragraph(
      adf.text(
        evidence.video !== null
          ? 'A walkthrough recorded against this preview is attached to this card as ' +
              `${SLIDES_FILENAME}, with a screenshot per step beside it. Steps marked ` +
              '"(in the walkthrough)" are the ones it shows; the rest are yours to take.'
          : 'Screenshots of the marked steps are attached to this card, numbered to ' +
              'match. The rest are yours to take.',
      ),
    ),
  ]
}

/**
 * Each criterion in bold over its own numbered list of steps.
 *
 * One run of numbers across the whole card, so step 7 in the video is step 7
 * here. `n` is the same counter `flattenSteps` uses, and the screenshots are
 * named from it.
 */
function numberedSteps(criteria: Criterion[], evidence: Evidence): adf.AdfNode[] {
  const marker = evidence.video !== null ? ' (in the walkthrough)' : ' (screenshot attached)'
  const proved = new Set(evidence.proved)
  const blocks: adf.AdfNode[] = []
  let n = 1
  for (const c of criteria) {
    const start = n
    const items = c.steps.map((s, i) =>
      proved.has(start + i) ? [adf.text(s), adf.text(marker)] : [adf.text(s)],
    )
    blocks.push(adf.paragraph(adf.strong(c.criterion)), adf.orderedList(items, start))
    n += c.steps.length
  }
  return blocks
}

function failureSection(result: Result): adf.AdfNode[] {
  if (result.status !== 'failed' || result.reason.trim() === '') return []
  return [adf.heading('Why it failed', 4), adf.codeBlock(result.reason.trim())]
}

/**
 * A heading, like every other section. It first went in as a bold-led
 * paragraph, which is exactly the shape a criterion heading uses — so it read
 * as one more criterion at the bottom of the list.
 */
function nextSection(stage: Stage, result: Result): adf.AdfNode[] {
  const next = whatNext(stage, result)
  if (next === null) return []
  return [adf.heading('What happens next', 4), adf.paragraph(adf.text(next))]
}

/** The pull request, the preview and the run, in that order, on one line. */
function linksSection(options: CommentOptions): adf.AdfNode[] {
  const { prUrl, previewUrl, run } = options
  const links: adf.AdfNode[] = []
  if (isSet(prUrl)) links.push(adf.link('Pull request', prUrl))
  if (isSet(previewUrl)) links.push(adf.link('Preview', previewUrl))
  // Null alone means no run, as it always has: `runUrl()` never returns ''.
  if (run !== null) links.push(adf.link('Actions run', run))
  if (links.length === 0) return []
  return [adf.paragraph(...links.flatMap((l, i) => (i === 0 ? [l] : [adf.text('  ·  '), l])))]
}

function isSet(url: string | null): url is string {
  return url !== null && url !== ''
}

/**
 * The one sentence telling the reader what to do with the card now.
 *
 * Generated rather than written by the agent, because it is the same sentence
 * every time and an agent asked to retype boilerplate eventually retypes it
 * differently — and the one place a reviewer must not have to interpret is the
 * instruction for handing the card on.
 *
 * It describes *this* board, which is why it does not read like the template it
 * came from: there is no "move it to Ready for deploy" column here. A build is
 * accepted by merging the pull request, and *Done* is set by the factory once
 * the change actually answers in production — so telling a reviewer to drag the
 * card would be telling them to do something the board will refuse.
 *
 * `null` where there is genuinely nothing for the reader to do: a `continue`
 * design turn leaves the card in a status the comment poller does not watch, so
 * inviting a reply there would invite one into a void.
 */
export function whatNext(stage: Stage, result: Result): string | null {
  const reply =
    'Reply on this card with the answer — a comment here is read on the next poll and ' +
    'starts the next turn from it.'

  switch (result.status) {
    case 'ready_for_review':
      return stage === 'design'
        ? 'If the design looks right, move this card to "Ready for build". If anything is ' +
            'wrong, reply here with what you would change instead — a comment is read on the ' +
            'next poll and starts another design turn.'
        : 'If it all checks out, approve and merge the pull request; the card moves to "Done" ' +
            'by itself once the change is live. If anything looks off, reply here with what ' +
            'you saw and at which step, and the next turn starts from your comment.'
    case 'blocked':
    case 'question':
      return reply
    case 'failed':
      return reply
    case 'continue':
      return stage === 'build'
        ? 'The card stays where it is. Comment on the pull request to grant the next turn.'
        : null
  }
}

/**
 * What goes on the card when Jira will not take the real comment.
 *
 * Text nodes in paragraphs and nothing else — no headings, no lists, no marks,
 * no media. Every richer feature is a thing the API can reject, and this one
 * runs precisely when something already has.
 *
 * It does not try to reproduce the comment. It says where the turn got to and
 * where to read the rest, so the reviewer has a thread to pull rather than a
 * card that went quiet.
 */
export function fallbackComment(stage: Stage, result: Result, pr: string | null): adf.AdfDoc {
  const lines = [
    `The ${stage} turn finished with status "${result.status}", and Jira would not accept the ` +
      'full comment for this card. This is the short version; nothing about the work itself ' +
      'has changed.',
    result.summary,
  ]
  if (pr !== null) lines.push(`Pull request: ${pr}`)
  const run = runUrl()
  if (run !== null) lines.push(`The run, whose log says why the comment was refused: ${run}`)
  lines.push(
    'Evidence for this turn is in the Attachments panel on this card, whatever is in this comment.',
  )
  return adf.doc(...lines.map((line) => adf.paragraph(adf.text(line))))
}

/**
 * Puts the person the card is going back to at the top of the comment.
 *
 * The hand-back is the moment the card becomes theirs again, and the mention is
 * what makes Jira tell them so even when they are not watching the card. With
 * nobody to hand it back to, the comment is left as it is.
 */
export function addressedTo(comment: adf.AdfDoc, accountId: string): adf.AdfDoc {
  if (accountId === '') return comment
  return adf.doc(
    adf.paragraph(adf.mention(accountId), adf.text(' — this card is back with you.')),
    ...comment.content,
  )
}
