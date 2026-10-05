import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prUrl, runUrl } from './env.ts'
import type * as adf from './adf.ts'
import { EVIDENCE_DIR, SLIDES_PATH, capturedSteps } from './evidence.ts'
import * as jira from './jira.ts'
import { launcherFor } from './launcher.ts'
import { readMeta } from './meta.ts'
import { RESULT_PATH } from './meta.ts'
import { handBackTarget, releaseCard, syncLinks, turnLinks } from './progress.ts'
import { addressedTo, buildComment, fallbackComment, type Evidence } from './report-comment.ts'
import { ResultSchema, STATUS_TRANSITIONS, type Result, type Stage } from './schema.ts'

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

  const { evidence, evidenceNote } = await attachEvidence(cfg, meta.key, options.dryRun === true)

  // Through the launcher: the Jira comment is read by a person, who may open
  // it days later, long after the app has scaled back to zero. meta.preview_url
  // itself stays raw — that is the agent's copy.
  const comment = addressedTo(
    buildComment(options.stage, result, {
      prUrl: pr,
      previewUrl: launcherFor(meta.preview_url),
      run: runUrl(),
      evidence,
    }),
    await handBackTarget(cfg, meta.key),
  )
  const target = targetStatus(options.stage, result)

  if (options.dryRun === true) {
    console.log(JSON.stringify(comment, null, 2))
    console.log(`report --dry-run: ${evidenceNote}`)
    console.log(`report --dry-run: would move ${meta.key} to ${target}`)
    return
  }

  await postComment(cfg, meta.key, comment, () => fallbackComment(options.stage, result, pr))
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

  if (target === null) {
    console.log(`report: ${meta.key} stays where it is (status "${result.status}").`)
    return
  }
  await moveCard(cfg, meta.key, target)
}

/**
 * Posts the comment, or the plain fallback if Jira will not take it.
 *
 * The comment is the best thing the reviewer gets, and it is not worth the
 * card for. A turn that has done its work, opened its PR and attached its
 * evidence has to end up in a column somebody is looking at — and until
 * DF-9 a comment Jira would not take threw here, skipping the hand-back and
 * the transition both, and left the card in "Building" with the factory
 * still holding it. Nobody was waiting on that column, so it simply stopped.
 *
 * The fallback says less, in the plainest shape the API accepts, and points
 * at the run whose log has the rest.
 */
async function postComment(
  cfg: jira.JiraConfig,
  key: string,
  comment: adf.AdfDoc,
  fallback: () => adf.AdfDoc,
): Promise<void> {
  try {
    await jira.addComment(cfg, key, comment)
  } catch (error) {
    console.error(`report: ${key} would not take the comment: ${(error as Error).message}`)
    process.exitCode = 3
    try {
      await jira.addComment(cfg, key, fallback())
      console.error('report: posted the plain-text fallback instead.')
    } catch (second) {
      console.error(`report: the fallback failed too: ${(second as Error).message}`)
    }
  }
}

/** Moves the card to `target`, failing loudly but not fatally if Jira has no such move. */
async function moveCard(cfg: jira.JiraConfig, key: string, target: string): Promise<void> {
  try {
    await jira.transitionTo(cfg, key, target)
    console.log(`report: ${key} -> ${target}`)
  } catch (error) {
    if (error instanceof jira.JiraTransitionError) {
      // The comment is already posted, so the card is not silent. Surface the
      // problem loudly but do not fail the run into a state where a re-run
      // would double-comment.
      console.error(`report: could not move ${key} to ${target}: ${error.message}`)
      process.exitCode = 3
      return
    }
    throw error
  }
}

export function targetStatus(stage: Stage, result: Result): string | null {
  return STATUS_TRANSITIONS[stage][result.status]
}
