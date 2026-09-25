import { readFileSync } from 'node:fs'
import { prUrl, runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import { launcherFor } from './launcher.ts'
import { readMeta } from './meta.ts'
import { RESULT_PATH } from './meta.ts'
import { ResultSchema, STATUS_TRANSITIONS, type Result, type Stage } from './schema.ts'

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
    for (const c of result.acceptance_criteria) {
      blocks.push(adf.paragraph(adf.strong(c.criterion)))
      blocks.push(adf.orderedList(c.steps.map((s) => [adf.text(s)])))
    }
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

export interface ReportOptions {
  stage: Stage
  prUrl?: string | undefined
  dryRun?: boolean
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

  // Through the launcher: the Jira comment is read by a person, who may open
  // it days later, long after the app has scaled back to zero. meta.preview_url
  // itself stays raw — that is the agent's copy.
  const comment = buildComment(
    options.stage,
    result,
    pr,
    launcherFor(meta.preview_url),
    runUrl(),
  )

  if (options.dryRun === true) {
    console.log(JSON.stringify(comment, null, 2))
    console.log(`report --dry-run: would move ${meta.key} to ${targetStatus(options.stage, result)}`)
    return
  }

  await jira.addComment(cfg, meta.key, comment)

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
