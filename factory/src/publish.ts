import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { optional, REPO_ROOT } from './env.ts'
import { git } from './git.ts'
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
import { readMeta, updateMeta, RESULT_PATH } from './meta.ts'
import { ALLOWED_PATHS, ResultSchema, type Result, type Stage } from './schema.ts'

const STAGE_TITLE: Record<Stage, string> = { design: 'Design', build: 'Build' }

function readResult(): Result {
  return ResultSchema.parse(JSON.parse(readFileSync(RESULT_PATH, 'utf8')))
}

export function prBody(key: string, summary: string, result: Result, previewUrl: string | null): string {
  const lines: string[] = [`### ${key}: ${summary}`, '', result.summary.trim(), '']

  if (previewUrl !== null && previewUrl !== '') {
    lines.push(`**Preview:** ${previewUrl}`, '')
  }
  if (result.assumptions.length > 0) {
    lines.push('### Assumptions', '', ...result.assumptions.map((a) => `- ${a}`), '')
  }
  if (result.questions.length > 0) {
    lines.push('### Open questions', '')
    for (const q of result.questions) {
      lines.push(`- **${q.question}**`)
      if (q.context !== '') lines.push(`  - Context: ${q.context}`)
      if (q.options.length > 0) lines.push(`  - Options: ${q.options.join(' / ')}`)
    }
    lines.push('')
  }
  if (result.artifacts.length > 0) {
    lines.push('### Files', '', ...result.artifacts.map((a) => `- \`${a}\``), '')
  }
  lines.push(
    '---',
    '',
    '_Opened by the factory. The `<!-- factory … -->` block below is machine-read — leave it alone._',
    '',
  )
  return lines.join('\n')
}

export interface PublishOptions {
  stage: Stage
  cardSummary: string
  dryRun?: boolean
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
  const result = readResult()
  const botLogin = optional('FACTORY_BOT_LOGIN', 'factory[bot]')
  const botEmail = `${botLogin.replace(/\[bot\]$/, '')}[bot]@users.noreply.github.com`

  if (options.stage === 'build') {
    // Regenerate the lockfile in case the agent added a dependency. It cannot
    // run npm install itself — that is not in its tool allow-list.
    const install = spawnSync(
      'npm',
      ['install', '--package-lock-only', '--workspaces', '--include-workspace-root'],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    if (install.status !== 0) {
      throw new Error('npm install --package-lock-only failed; the lockfile is out of date.')
    }
  }

  git(['config', 'user.name', botLogin])
  git(['config', 'user.email', botEmail])

  for (const pattern of ALLOWED_PATHS[options.stage]) {
    git(['add', '--', pattern], true)
  }

  const staged = git(['diff', '--cached', '--name-only']).trim()
  if (staged === '') {
    console.log('publish: nothing to commit within the stage\'s allowed paths.')
  } else {
    const subject = (result.summary.split('\n')[0] ?? 'factory turn').slice(0, 72)
    git(['commit', '-m', `${meta.key}: ${subject}`])
  }

  if (options.dryRun === true) {
    console.log(`publish --dry-run: would push ${meta.branch}`)
    return null
  }

  git(['push', '--set-upstream', 'origin', meta.branch])

  const title = `[${meta.key}] ${STAGE_TITLE[options.stage]}: ${options.cardSummary}`
  const body = prBody(meta.key, options.cardSummary, result, meta.preview_url)
  const withBlock = upsertFactoryBlock(body, {
    key: meta.key,
    stage: options.stage,
    turn: meta.turn,
    ...(meta.preview_url === null ? {} : { preview_url: meta.preview_url }),
  })

  let pr = findPrForBranch(meta.branch)
  if (pr === null) {
    pr = createDraftPr(meta.branch, title, withBlock)
    addLabel(pr.number, `factory:${options.stage}`)
    if (options.stage === 'build') addLabel(pr.number, 'factory:active')
  } else {
    setPrTitle(pr.number, title)
    updatePrBody(pr.number, withBlock)
  }

  // A finished turn takes the PR out of draft so a human can review it.
  if (result.status === 'ready_for_review' && pr.isDraft) {
    markReady(pr.number)
  }

  updateMeta({ pr: pr.number })
  console.log(`publish: ${pr.url}`)
  return pr
}
