import { spawnSync } from 'node:child_process'
import { REPO_ROOT, optional, required } from './env.ts'
import {
  commentOnPr,
  createDeployment,
  deactivateDeployments,
  findPrForBranch,
  gh,
  ghJson,
  packageVersionsPath,
  parseFactoryBlock,
  repoSlug,
  updatePrBody,
  upsertFactoryBlock,
} from './github.ts'
import { readMeta, updateMeta } from './meta.ts'
import {
  azureConfig,
  buildImage,
  deletePreviewApp,
  deletePreviewImage,
  deployPreview,
} from './azure.ts'

/**
 * Preview environments — one per pull request.
 *
 * Two backends, chosen by `FACTORY_PREVIEW_BACKEND`:
 *
 * - `azure` (UNVERIFIED) builds the image in Azure Container Registry and runs
 *   it as an Azure Container App with external ingress. That is a real, running
 *   site on an HTTPS URL, which is what a preview is supposed to be.
 * - `ghcr` (default) is the stub: it builds the nginx image, pushes it to GHCR
 *   tagged `pr-<N>`, and records a Deployment pointing at the package page.
 *   Nothing serves it. It exists so the factory's plumbing can be exercised end
 *   to end with no cloud account at all.
 *
 * The default stays `ghcr` deliberately: the Azure path has never run against a
 * live subscription, so it is opt-in until someone has watched it work. See
 * docs/factory/SELF-HOSTING.md.
 */

export type PreviewBackend = 'ghcr' | 'azure'

export function previewBackend(): PreviewBackend {
  const value = optional('FACTORY_PREVIEW_BACKEND', 'ghcr').toLowerCase()
  if (value !== 'ghcr' && value !== 'azure') {
    throw new Error(
      `FACTORY_PREVIEW_BACKEND must be "ghcr" or "azure", not "${value}".`,
    )
  }
  return value
}

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

/** Builds and publishes the image, and returns the URL a human should open. */
function raise(prNumber: number): string {
  if (previewBackend() === 'azure') {
    const config = azureConfig()
    const prefix = optional('AZURE_PREVIEW_PREFIX', 'df')
    buildImage(config, prNumber)
    return deployPreview(config, prNumber, prefix)
  }

  const image = imageRef(prNumber)
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
  return packageUrl()
}

/**
 * Raises (or re-raises) the preview and records the URL in the three places
 * that need it: the Deployment, the PR's factory block, and meta.json.
 *
 * Safe to call repeatedly for the same PR. That matters now the workflow runs
 * on `synchronize` as well as `labeled` — every build turn pushes, so every
 * build turn re-enters here and the preview follows the branch instead of
 * showing turn 1 forever.
 */
export function previewUp(prNumber: number, dryRun = false): string {
  const backend = previewBackend()

  if (dryRun) {
    console.log(`preview-up --dry-run: would raise the ${backend} preview for PR #${prNumber}`)
    return backend === 'azure' ? 'https://<container-app>.azurecontainerapps.io' : packageUrl()
  }

  const url = raise(prNumber)

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

  console.log(`preview-up (${backend}): ${url}`)
  return url
}

export function previewDown(prNumber: number, dryRun = false): void {
  const backend = previewBackend()

  if (dryRun) {
    console.log(`preview-down --dry-run: would tear down the ${backend} preview for PR #${prNumber}`)
    return
  }

  deactivateDeployments('preview')

  if (backend === 'azure') {
    const config = azureConfig()
    const prefix = optional('AZURE_PREVIEW_PREFIX', 'df')

    // Two independent attempts, not one block. A Container App that outlives
    // its PR bills by the hour; an image tag that outlives its PR only bills
    // for storage. Losing the first is much worse than losing the second, so
    // neither failure is allowed to skip the other.
    try {
      deletePreviewApp(config, prNumber, prefix)
      console.log(`preview-down: deleted the Container App for PR #${prNumber}`)
    } catch (error) {
      console.error(`preview-down: could not delete the Container App: ${(error as Error).message}`)
    }
    try {
      deletePreviewImage(config, prNumber)
      console.log(`preview-down: deleted the pr-${prNumber} image tag`)
    } catch (error) {
      console.error(`preview-down: could not delete the image tag: ${(error as Error).message}`)
    }
    return
  }

  // Find the GHCR version tagged pr-<N> and delete just that one.
  try {
    const versionsPath = packageVersionsPath()
    const versions = ghJson<
      Array<{ id: number; metadata?: { container?: { tags?: string[] } } }>
    >(['api', versionsPath])

    const match = (versions ?? []).find((v) =>
      (v.metadata?.container?.tags ?? []).includes(`pr-${prNumber}`),
    )
    if (match !== undefined) {
      gh(['api', '-X', 'DELETE', `${versionsPath}/${match.id}`])
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
