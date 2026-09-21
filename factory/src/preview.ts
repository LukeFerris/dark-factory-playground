import { spawnSync } from 'node:child_process'
import { REPO_ROOT, optional, required } from './env.ts'
import {
  commentOnPr,
  createDeployment,
  deactivateDeployments,
  findPrForBranch,
  gh,
  ghJson,
  parseFactoryBlock,
  repoSlug,
  updatePrBody,
  upsertFactoryBlock,
} from './github.ts'
import { readMeta, updateMeta } from './meta.ts'

/**
 * Preview environments — STUB.
 *
 * This builds the nginx image and pushes it to GHCR tagged `pr-<N>`, then
 * records a GitHub Deployment whose environment_url points at the package page.
 * That is not a running site: it is a real, inspectable artifact per PR, which
 * is enough to exercise the factory's plumbing end to end.
 *
 * The real thing is Azure Static Web Apps, which has native per-PR preview
 * environments. See docs/factory/SELF-HOSTING.md for the swap.
 */

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
  }
}

function imageRef(prNumber: number): string {
  const [owner, repo] = repoSlug().split('/')
  return `ghcr.io/${(owner ?? '').toLowerCase()}/${(repo ?? '').toLowerCase()}:pr-${prNumber}`
}

function packageUrl(): string {
  const [owner, repo] = repoSlug().split('/')
  return `https://github.com/${owner}/${repo}/pkgs/container/${repo}`
}

export function previewUp(prNumber: number, dryRun = false): string {
  const image = imageRef(prNumber)
  const url = packageUrl()

  if (dryRun) {
    console.log(`preview-up --dry-run: would build and push ${image}`)
    return url
  }

  run('docker', ['build', '-f', 'app/Dockerfile', '-t', image, '.'])

  // GHCR login uses whatever token the workflow put in GH_TOKEN; the job needs
  // `packages: write`.
  const token = required('GH_TOKEN')
  const login = spawnSync(
    'docker',
    ['login', 'ghcr.io', '-u', optional('GITHUB_ACTOR', 'factory'), '--password-stdin'],
    { input: token, stdio: ['pipe', 'inherit', 'inherit'] },
  )
  if (login.status !== 0) throw new Error('docker login ghcr.io failed')

  run('docker', ['push', image])

  const pr = ghJson<{ headRefOid: string; body: string }>([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repoSlug(),
    '--json',
    'headRefOid,body',
  ])

  createDeployment(pr.headRefOid, 'preview', url)

  // Record the preview URL where later turns can find it.
  const block = parseFactoryBlock(pr.body)
  if (block !== null) {
    updatePrBody(prNumber, upsertFactoryBlock(pr.body, { ...block, preview_url: url }))
  }
  try {
    updateMeta({ preview_url: url })
  } catch {
    // meta.json only exists inside a turn; preview-up also runs on its own.
  }

  console.log(`preview-up: ${image} -> ${url}`)
  return url
}

export function previewDown(prNumber: number, dryRun = false): void {
  const [, repo] = repoSlug().split('/')
  const owner = repoSlug().split('/')[0] ?? ''

  if (dryRun) {
    console.log(`preview-down --dry-run: would delete the pr-${prNumber} package version`)
    return
  }

  deactivateDeployments('preview')

  // Find the GHCR version tagged pr-<N> and delete just that one.
  try {
    const versions = ghJson<
      Array<{ id: number; metadata?: { container?: { tags?: string[] } } }>
    >(['api', `users/${owner}/packages/container/${repo}/versions`])

    const match = (versions ?? []).find((v) =>
      (v.metadata?.container?.tags ?? []).includes(`pr-${prNumber}`),
    )
    if (match !== undefined) {
      gh(['api', '-X', 'DELETE', `users/${owner}/packages/container/${repo}/versions/${match.id}`])
      console.log(`preview-down: deleted package version ${match.id} (pr-${prNumber})`)
    } else {
      console.log(`preview-down: no package version tagged pr-${prNumber}; nothing to delete.`)
    }
  } catch (error) {
    console.error(`preview-down: could not clean up the package: ${(error as Error).message}`)
  }
}

/**
 * The first comment on a build PR: what the card asks for, where the preview is,
 * and how the human grants each turn.
 *
 * Auto-continue is off by design — every build turn needs a human comment. This
 * is where that is explained, on the PR, where the person actually is.
 */
export function kickoff(prNumber: number, dryRun = false): void {
  const meta = readMeta()
  const pr = findPrForBranch(meta.branch)
  const previewUrl = meta.preview_url

  const body = [
    `<!-- factory-turn kickoff -->`,
    `### ${meta.key} — build started`,
    '',
    'The design for this card is merged and the build branch is open.',
    ...(previewUrl === null ? [] : ['', `**Preview:** ${previewUrl}`]),
    '',
    '**Each build turn needs your go-ahead.** Comment on this PR to grant one —',
    '`go` to continue as planned, or any instruction you want the agent to follow',
    'on the next turn. Nothing happens until you do; auto-continue is off.',
    '',
    'The agent may only write under `app/src`, `app/public`, `app/index.html`,',
    '`app/package.json` and the build log. Anything else is rejected before it',
    'reaches the branch.',
  ].join('\n')

  if (dryRun) {
    console.log(body)
    return
  }
  commentOnPr(pr?.number ?? prNumber, body)
  console.log(`kickoff: commented on PR #${pr?.number ?? prNumber}`)
}
