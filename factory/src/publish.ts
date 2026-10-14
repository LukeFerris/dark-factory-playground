import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { REPO_ROOT } from './env.ts'
import { git, identifyAsBot } from './git.ts'
import {
  addLabel,
  createDraftPr,
  findPrForBranch,
  markDraft,
  markReady,
  setPrTitle,
  updatePrBody,
  upsertFactoryBlock,
  type PullRequest,
} from './github.ts'
import { readMeta, updateMeta, RESULT_PATH, type Meta } from './meta.ts'
import { allowedPaths } from './paths.ts'
import { ResultSchema, type Result, type Stage } from './schema.ts'

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
 * The `npm install` that regenerates the lockfile without installing anything.
 *
 * A repository with workspaces, like this one, keeps every workspace's
 * dependencies in the root lockfile, so all of them are resolved. One without
 * has a single package at the root, and `--workspaces` would fail there.
 *
 * It runs in a job that holds tokens, on a package.json the agent may have
 * written, so no script in it runs (ADR 0008).
 */
export function lockfileArgs(root: string = REPO_ROOT): string[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    workspaces?: unknown
  }
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces.length > 0
    : manifest.workspaces != null
  return [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    ...(workspaces ? ['--workspaces', '--include-workspace-root'] : []),
  ]
}

/**
 * Regenerates the lockfile in case the agent added a dependency. It cannot run
 * npm install itself — that is not in its tool allow-list.
 */
function regenerateLockfile(): void {
  const install = spawnSync('npm', lockfileArgs(), { cwd: REPO_ROOT, stdio: 'inherit' })
  if (install.status !== 0) {
    throw new Error('npm install --package-lock-only failed; the lockfile is out of date.')
  }
}

/** Stages what the stage may write, as the bot, and commits it if there is anything. */
function commitTurn(stage: Stage, key: string, result: Result): void {
  identifyAsBot()

  for (const pattern of allowedPaths(stage)) {
    git(['add', '--', pattern], true)
  }

  const staged = git(['diff', '--cached', '--name-only']).trim()
  if (staged === '') {
    console.log("publish: nothing to commit within the stage's allowed paths.")
  } else {
    const subject = (result.summary.split('\n')[0] ?? 'factory turn').slice(0, 72)
    // No hooks: this job holds tokens and runs no card code (ADR 0008). The
    // Commit gates check runs the pre-commit gates on the pull request instead.
    git(['commit', '--no-verify', '-m', `${key}: ${subject}`])
  }
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
 * agent may have edited a package.json to add a dependency, and the lockfile
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

  // A finished design takes the PR out of draft so a human can review it. A
  // build turn puts it back, whatever it ended on: the work is unproven until
  // main's required checks pass on it, and `report` takes it out of draft only
  // once `verify` has seen them do so. Until then nobody can merge it by
  // mistake, and a repository whose expensive checks skip drafts runs them
  // once, when the factory asks, rather than on every push.
  if (options.stage === 'build') {
    if (!pr.isDraft) markDraft(pr.number)
  } else if (result.status === 'ready_for_review' && pr.isDraft) {
    markReady(pr.number)
  }

  updateMeta({ pr: pr.number })
  console.log(`publish: ${pr.url}`)
  return pr
}
