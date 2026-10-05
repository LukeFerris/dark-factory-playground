import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './env.ts'
import { git, identifyAsBot, tryCommit } from './git.ts'
import {
  addLabel,
  createDraftPr,
  findPrForBranch,
  markReady,
  setPrTitle,
  updatePrBody,
  upsertFactoryBlock,
  type PullRequest,
} from './github.ts'
import { readMeta, updateMeta, writeFileEnsuringDir, RESULT_PATH, type Meta } from './meta.ts'
import { ALLOWED_PATHS, ResultSchema, type Result, type Stage } from './schema.ts'
import { failedResult } from './validate.ts'

function readResult(): Result {
  return ResultSchema.parse(JSON.parse(readFileSync(RESULT_PATH, 'utf8')))
}

/** A `### heading` and a bulleted list, or nothing at all when there is nothing to list. */
function listSection(heading: string, items: string[]): string[] {
  return items.length > 0 ? [`### ${heading}`, '', ...items.map((i) => `- ${i}`), ''] : []
}

function criteriaSection(result: Result): string[] {
  if (result.acceptance_criteria.length === 0) return []
  const lines = [
    '### Acceptance criteria',
    '',
    ...result.acceptance_criteria.map((c) => `- ${c.criterion}`),
    '',
    '### Proving it',
    '',
    'With the app open in a browser:',
    '',
  ]
  for (const c of result.acceptance_criteria) {
    lines.push(`**${c.criterion}**`, '', ...c.steps.map((s, i) => `${i + 1}. ${s}`), '')
  }
  return lines
}

function questionsSection(result: Result): string[] {
  if (result.questions.length === 0) return []
  const lines = ['### Open questions', '']
  for (const q of result.questions) {
    lines.push(`- **${q.question}**`)
    if (q.context !== '') lines.push(`  - Context: ${q.context}`)
    if (q.options.length > 0) lines.push(`  - Options: ${q.options.join(' / ')}`)
  }
  lines.push('')
  return lines
}

export function prBody(
  key: string,
  summary: string,
  result: Result,
  previewUrl: string | null,
): string {
  const context = result.context.trim()
  return [
    `### ${key}: ${summary}`,
    '',
    result.summary.trim(),
    '',
    ...(context === '' ? [] : ['### Context', '', context, '']),
    // Above the steps, not below: the reviewer needs the URL before the thing
    // that tells them what to do in it.
    ...(previewUrl === null || previewUrl === '' ? [] : [`**Preview:** ${previewUrl}`, '']),
    ...criteriaSection(result),
    // The same question a code reviewer asks, so it gets the same answer as the
    // card. The steps above are numbered per criterion here rather than straight
    // through: the PR body has no screenshots to line up with.
    ...listSection('Not in this change', result.out_of_scope),
    ...listSection('Assumptions', result.assumptions),
    ...questionsSection(result),
    ...listSection(
      'Files',
      result.artifacts.map((a) => `\`${a}\``),
    ),
    '---',
    '',
    '_Opened by the factory. The `<!-- factory … -->` block below is machine-read — leave it alone._',
    '',
  ].join('\n')
}

export interface PublishOptions {
  stage: Stage
  cardSummary: string
  dryRun?: boolean
}

/**
 * Regenerates the lockfile in case the agent added a dependency. It cannot run
 * npm install itself — that is not in its tool allow-list.
 */
function regenerateLockfile(): void {
  const install = spawnSync(
    'npm',
    ['install', '--package-lock-only', '--workspaces', '--include-workspace-root'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  )
  if (install.status !== 0) {
    throw new Error('npm install --package-lock-only failed; the lockfile is out of date.')
  }
}

/** Stages what the stage may write, as the bot, and commits it if there is anything. */
function commitTurn(stage: Stage, key: string, result: Result): void {
  identifyAsBot()

  for (const pattern of ALLOWED_PATHS[stage]) {
    git(['add', '--', pattern], true)
  }

  const staged = git(['diff', '--cached', '--name-only']).trim()
  if (staged === '') {
    console.log("publish: nothing to commit within the stage's allowed paths.")
  } else {
    const subject = (result.summary.split('\n')[0] ?? 'factory turn').slice(0, 72)
    const refusal = tryCommit(['-m', `${key}: ${subject}`])
    if (refusal !== null) refuseTurn(stage, result, refusal)
  }
}

/**
 * Turns a commit the pre-commit gates refused into a failed turn, then stops.
 *
 * Report runs whether or not publish did, and it reads result.json. Left
 * alone, that is the agent's own account of a turn that worked, and the card
 * would move on with nothing pushed. So, as validate does for a turn it
 * rejects, the result is replaced with one that says what happened.
 */
function refuseTurn(stage: Stage, result: Result, refusal: string): never {
  const failed = failedResult(
    `The ${stage} turn's commit was refused by the pre-commit gates, so none of it was pushed.`,
    result,
    [refusal],
  )
  writeFileEnsuringDir(RESULT_PATH, `${JSON.stringify(failed, null, 2)}\n`)
  throw new Error(`publish: the pre-commit gates refused the commit:\n${refusal}`)
}

/** The branch's open pull request, given this title and body — created as a draft if there is none. */
function openOrUpdatePr(branch: string, title: string, body: string): PullRequest {
  const pr = findPrForBranch(branch)
  if (pr === null) return createDraftPr(branch, title, body)
  setPrTitle(pr.number, title)
  updatePrBody(pr.number, body)
  return pr
}

/**
 * The PR body with the machine-read block on the end.
 *
 * No stage in the title. One pull request carries the card from design to
 * merge, so a title naming the stage would be wrong for most of its life — and
 * build-turn.yml reads the Jira key back out of this, which is the one part
 * that has to stay stable.
 */
function prContent(
  meta: Meta,
  options: PublishOptions,
  result: Result,
): { title: string; body: string } {
  const title = `[${meta.key}] ${options.cardSummary}`
  const body = prBody(meta.key, options.cardSummary, result, meta.preview_url)
  const withBlock = upsertFactoryBlock(body, {
    key: meta.key,
    stage: options.stage,
    turn: meta.turn,
    ...(meta.preview_url === null ? {} : { preview_url: meta.preview_url }),
  })
  return { title, body: withBlock }
}

/**
 * Commits whatever the turn produced (within scope), pushes, and creates or
 * updates the draft PR.
 *
 * The commit is authored as the App's bot identity so the history shows plainly
 * that a machine wrote it. For a build turn we run `npm install` first: the
 * agent may have edited app/package.json to add a dependency, and the lockfile
 * has to be regenerated here — CI's `npm ci` is what catches it if it is not.
 */
export function publish(options: PublishOptions): PullRequest | null {
  const meta = readMeta()
  // Gather records the branch, but in a build turn gather runs the card
  // branch's own code from before main was merged in, which may predate that.
  // Whatever is checked out now is the branch the turn worked on.
  const branch = meta.branch !== '' ? meta.branch : git(['branch', '--show-current'], true).trim()
  const result = readResult()

  if (options.stage === 'build') regenerateLockfile()
  commitTurn(options.stage, meta.key, result)

  if (options.dryRun === true) {
    console.log(`publish --dry-run: would push ${branch}`)
    return null
  }

  if (branch === '') throw new Error('No branch to push to: none recorded and HEAD is detached.')
  git(['push', '--set-upstream', 'origin', branch])

  const { title, body } = prContent(meta, options, result)
  const pr = openOrUpdatePr(branch, title, body)

  // Every turn, not only the one that creates the PR. The design stage opens
  // it now, so by the time the build stage publishes there is already a pull
  // request — and factory:active, which build-turn.yml's comment guard keys
  // on, would never be applied at all. Adding a label that is already present
  // is a no-op.
  //
  // It is no longer a *trigger* for anything. It used to start build-setup.yml
  // on `labeled`, which is why it had to be applied with the App token rather
  // than GITHUB_TOKEN; that requirement has gone with ADR 0003, but the App
  // token is what publishes anyway.
  addLabel(pr.number, `factory:${options.stage}`)
  if (options.stage === 'build') addLabel(pr.number, 'factory:active')

  // A finished turn takes the PR out of draft so a human can review it.
  if (result.status === 'ready_for_review' && pr.isDraft) {
    markReady(pr.number)
  }

  updateMeta({ pr: pr.number })
  console.log(`publish: ${pr.url}`)
  return pr
}
