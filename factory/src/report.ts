import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prUrl, runUrl } from './env.ts'
import * as adf from './adf.ts'
import { EVIDENCE_DIR, SLIDES_FILENAME, SLIDES_PATH, capturedSteps } from './evidence.ts'
import * as jira from './jira.ts'
import { launcherFor } from './launcher.ts'
import { readMeta } from './meta.ts'
import { RESULT_PATH } from './meta.ts'
import { handBackTarget, releaseCard, syncLinks, turnLinks } from './progress.ts'
import { ResultSchema, STATUS_TRANSITIONS, type Result, type Stage } from './schema.ts'

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
export function buildComment(
  stage: Stage,
  result: Result,
  prUrl: string | null,
  previewUrl: string | null,
  run: string | null,
  evidence: Evidence = { video: null, proved: [] },
): adf.AdfDoc {
  const blocks: adf.AdfNode[] = []

  const headline: Record<Result['status'], string> = {
    ready_for_review: `${stage} turn finished — ready for review`,
    continue: `${stage} turn finished — more work to do`,
    blocked: `${stage} turn paused — needs an answer`,
    question: `${stage} turn paused — needs an answer`,
    failed: `${stage} turn failed`,
  }
  blocks.push(adf.heading(headline[result.status]))

  blocks.push(adf.heading('Summary', 4))
  blocks.push(adf.paragraph(adf.text(result.summary.trim())))

  if (result.context.trim() !== '') {
    blocks.push(adf.heading('Context', 4))
    blocks.push(adf.paragraph(adf.text(result.context.trim())))
  }

  // Before the criteria, not after. Somebody who answered a question on this
  // card opens the next comment looking for one thing: what was made of their
  // reply. Burying that under the work makes them read the whole comment to
  // find out whether they were heard.
  if (result.answers.length > 0) {
    blocks.push(adf.heading('Answers to your questions', 4))
    blocks.push(
      adf.bulletList(
        result.answers.map((a) => [adf.strong(a.question), adf.text(` — ${a.answer}`)]),
      ),
    )
  }

  if (result.acceptance_criteria.length > 0) {
    // Two sections, not one. The criteria are what a reviewer argues with; the
    // steps are what they do. Collapsing them into a single numbered list —
    // which is what this used to be — leaves nowhere to state what "done"
    // means except as a sequence of clicks.
    blocks.push(adf.heading('Acceptance criteria', 4))
    // A design turn has built nothing, so its criteria are a contract for the
    // build rather than something you can go and check. Saying which it is
    // stops a reviewer opening a preview that does not exist yet.
    if (stage === 'design') {
      blocks.push(adf.paragraph(adf.text('What the build has to make true:')))
    }
    blocks.push(adf.bulletList(result.acceptance_criteria.map((c) => [adf.text(c.criterion)])))

    blocks.push(adf.heading('Proving it', 4))
    blocks.push(
      adf.paragraph(
        adf.text(
          stage === 'design'
            ? 'Once the build lands, with the app open in a browser:'
            : 'With the app open in a browser:',
        ),
      ),
    )
    const marker =
      evidence.video !== null ? ' (in the walkthrough)' : ' (screenshot attached)'
    if (evidence.proved.length > 0) {
      blocks.push(
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
      )
    }

    // One run of numbers across the whole card, so step 7 in the video is step
    // 7 here. `n` is the same counter `flattenSteps` uses, and the screenshots
    // are named from it.
    const proved = new Set(evidence.proved)
    let n = 1
    for (const c of result.acceptance_criteria) {
      blocks.push(adf.paragraph(adf.strong(c.criterion)))
      const start = n
      blocks.push(
        adf.orderedList(
          c.steps.map((s) => {
            const inline = [adf.text(s)]
            if (proved.has(n)) inline.push(adf.text(marker))
            n += 1
            return inline
          }),
          start,
        ),
      )
    }
  }

  // After the steps rather than before them: it answers the question a reviewer
  // asks once something has not happened, which is the moment they reach it.
  if (result.out_of_scope.length > 0) {
    blocks.push(adf.heading('Not in this change', 4))
    blocks.push(adf.bulletList(result.out_of_scope.map((s) => [adf.text(s)])))
  }

  if (result.questions.length > 0) {
    blocks.push(adf.heading('Questions', 4))
    blocks.push(
      adf.bulletList(
        result.questions.map((q) => {
          const inline: adf.AdfNode[] = [adf.strong(q.question)]
          if (q.context !== '') inline.push(adf.text(` — ${q.context}`))
          if (q.options.length > 0) inline.push(adf.text(` (options: ${q.options.join(' / ')})`))
          return inline
        }),
      ),
    )
  }

  if (result.assumptions.length > 0) {
    blocks.push(adf.heading('Assumptions', 4))
    blocks.push(adf.bulletList(result.assumptions.map((a) => [adf.text(a)])))
  }

  if (result.status === 'failed' && result.reason.trim() !== '') {
    blocks.push(adf.heading('Why it failed', 4))
    blocks.push(adf.codeBlock(result.reason.trim()))
  }

  // A heading, like every other section. It first went in as a bold-led
  // paragraph, which is exactly the shape a criterion heading uses — so it read
  // as one more criterion at the bottom of the list.
  const next = whatNext(stage, result)
  if (next !== null) {
    blocks.push(adf.heading('What happens next', 4))
    blocks.push(adf.paragraph(adf.text(next)))
  }

  const links: adf.AdfNode[] = []
  if (prUrl !== null && prUrl !== '') links.push(adf.link('Pull request', prUrl))
  if (previewUrl !== null && previewUrl !== '') {
    if (links.length > 0) links.push(adf.text('  ·  '))
    links.push(adf.link('Preview', previewUrl))
  }
  if (run !== null) {
    if (links.length > 0) links.push(adf.text('  ·  '))
    links.push(adf.link('Actions run', run))
  }
  if (links.length > 0) blocks.push(adf.paragraph(...links))

  return adf.doc(...blocks)
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

export interface ReportOptions {
  stage: Stage
  prUrl?: string | undefined
  dryRun?: boolean
}

/**
 * Puts whatever the capture run left onto the card: a screenshot per step it
 * could drive, and the walkthrough video built from them.
 *
 * Both, rather than one or the other. The video is the thing a reviewer
 * watches; the screenshots are the thing they can open, zoom and link to when
 * something in it looks wrong — and the one that still works in a Jira that
 * will not play the video.
 *
 * Nothing in here throws. A card that is finished has to reach a reviewer
 * whether or not its evidence went up: losing the evidence costs them a few
 * minutes in the preview, losing the comment costs them the hand-off.
 */
async function attachEvidence(
  cfg: jira.JiraConfig,
  key: string,
  dryRun: boolean,
): Promise<{ evidence: Evidence; evidenceNote: string }> {
  const captured = capturedSteps(EVIDENCE_DIR)
  const video = existsSync(SLIDES_PATH)

  if (captured.length === 0) {
    return { evidence: { video: null, proved: [] }, evidenceNote: 'nothing was captured' }
  }
  if (dryRun) {
    return {
      evidence: { video: video ? 'dry-run' : null, proved: captured },
      evidenceNote: `would attach ${captured.length} screenshot(s)${video ? ' and the walkthrough' : ''}`,
    }
  }

  const proved: number[] = []
  for (const n of captured) {
    const shot = resolve(EVIDENCE_DIR, `step-${String(n).padStart(2, '0')}.png`)
    try {
      await jira.addAttachment(cfg, key, shot, 'image/png')
      proved.push(n)
    } catch (error) {
      console.error(`report: could not attach step ${n}: ${(error as Error).message}`)
    }
  }

  let id: string | null = null
  if (video) {
    try {
      id = (await jira.addAttachment(cfg, key, SLIDES_PATH, 'video/mp4')).id
    } catch (error) {
      console.error(`report: could not attach the walkthrough: ${(error as Error).message}`)
    }
  }

  return {
    evidence: { video: id, proved },
    evidenceNote: `attached ${proved.length}/${captured.length} screenshot(s)${id === null ? '' : ' and the walkthrough'}`,
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

/** Posts the card comment and applies the status transition for this result. */
export async function report(options: ReportOptions): Promise<void> {
  const meta = readMeta()
  const result = ResultSchema.parse(JSON.parse(readFileSync(RESULT_PATH, 'utf8')))
  const cfg = jira.configFromEnv()

  // `--pr-url` wins if given, but nothing passes it: the number is in meta.json
  // the moment `publish` creates or finds the PR, and for a build turn it is
  // there from turn one. Falling back to meta means a rejected turn — where
  // `publish` never ran — still links the PR a human needs to go and look at.
  const pr = options.prUrl ?? prUrl(meta.pr)

  const { evidence, evidenceNote } = await attachEvidence(
    cfg,
    meta.key,
    options.dryRun === true,
  )

  // Through the launcher: the Jira comment is read by a person, who may open
  // it days later, long after the app has scaled back to zero. meta.preview_url
  // itself stays raw — that is the agent's copy.
  const comment = addressedTo(
    buildComment(options.stage, result, pr, launcherFor(meta.preview_url), runUrl(), evidence),
    await handBackTarget(cfg, meta.key),
  )

  if (options.dryRun === true) {
    console.log(JSON.stringify(comment, null, 2))
    console.log(`report --dry-run: ${evidenceNote}`)
    console.log(`report --dry-run: would move ${meta.key} to ${targetStatus(options.stage, result)}`)
    return
  }

  // The comment is the best thing the reviewer gets, and it is not worth the
  // card for. A turn that has done its work, opened its PR and attached its
  // evidence has to end up in a column somebody is looking at — and until
  // DF-9 a comment Jira would not take threw here, skipping the hand-back and
  // the transition both, and left the card in "Building" with the factory
  // still holding it. Nobody was waiting on that column, so it simply stopped.
  //
  // The fallback says less, in the plainest shape the API accepts, and points
  // at the run whose log has the rest.
  try {
    await jira.addComment(cfg, meta.key, comment)
  } catch (error) {
    console.error(`report: ${meta.key} would not take the comment: ${(error as Error).message}`)
    process.exitCode = 3
    try {
      await jira.addComment(cfg, meta.key, fallbackComment(options.stage, result, pr))
      console.error('report: posted the plain-text fallback instead.')
    } catch (second) {
      console.error(`report: the fallback failed too: ${(second as Error).message}`)
    }
  }
  console.log(`report: evidence — ${evidenceNote}`)

  // The other end of what `announce` opened. Done before the transition so the
  // card arrives in its new column already handed back and already pointing at
  // the right preview — and done on every path below, including the one where
  // the card does not move at all, because the turn is over either way and the
  // factory is no longer the one holding it.
  //
  // `meta.preview_url` is set by now on a build turn; at `announce` time it was
  // usually still null, so this is the call that actually puts the preview on
  // the card. Posting the same globalId twice updates the row.
  await syncLinks(cfg, meta.key, turnLinks(meta))
  await releaseCard(cfg, meta.key)

  const target = targetStatus(options.stage, result)
  if (target === null) {
    console.log(`report: ${meta.key} stays where it is (status "${result.status}").`)
    return
  }

  try {
    await jira.transitionTo(cfg, meta.key, target)
    console.log(`report: ${meta.key} -> ${target}`)
  } catch (error) {
    if (error instanceof jira.JiraTransitionError) {
      // The comment is already posted, so the card is not silent. Surface the
      // problem loudly but do not fail the run into a state where a re-run
      // would double-comment.
      console.error(`report: could not move ${meta.key} to ${target}: ${error.message}`)
      process.exitCode = 3
      return
    }
    throw error
  }
}

export function targetStatus(stage: Stage, result: Result): string | null {
  return STATUS_TRANSITIONS[stage][result.status]
}
