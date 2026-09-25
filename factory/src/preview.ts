import { spawnSync } from 'node:child_process'
import { REPO_ROOT, optional, required } from './env.ts'
import {
  commentOnPr,
  createDeployment,
  deactivateDeployments,
  gh,
  ghJson,
  packageVersionsPath,
  parseFactoryBlock,
  prBodyAndBranch,
  repoSlug,
  updatePrBody,
  upsertFactoryBlock,
} from './github.ts'
import { updateMeta } from './meta.ts'
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
 * - `azure` builds the image in Azure Container Registry and runs it as an
 *   Azure Container App with external ingress. That is a real, running site on
 *   an HTTPS URL, which is what a preview is supposed to be.
 * - `ghcr` (default) is the stub: it builds the nginx image, pushes it to GHCR
 *   tagged `pr-<N>`, and records a Deployment pointing at the package page.
 *   Nothing serves it. It exists so the factory's plumbing can be exercised end
 *   to end with no cloud account at all.
 *
 * The default stays `ghcr` deliberately: `azure` needs a subscription and a
 * Terraformed estate, so it is opt-in rather than something a clone inherits.
 * See docs/factory/SELF-HOSTING.md.
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

  // Record the preview URL where later turns can find it. The PR body is the
  // only place that survives this runner, so losing it here means the agent
  // and the kickoff comment never learn there is a site to look at — say so
  // rather than skipping in silence, which is how it went unnoticed before.
  const block = parseFactoryBlock(pr.body)
  if (block !== null) {
    updatePrBody(prNumber, upsertFactoryBlock(pr.body, { ...block, preview_url: url }))
  } else {
    console.warn(
      `::warning::PR #${prNumber} has no readable factory block, so ${url} was not recorded on it.`,
    )
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

/** `card/DF-12-let-the-user-type-their-name` -> `DF-12`, and `null` otherwise. */
export function cardKeyFromBranch(branch: string): string | null {
  return /^card\/([A-Z][A-Z0-9]*-\d+)-/.exec(branch)?.[1] ?? null
}

/** Split out from `kickoff` so the wording can be tested without a PR. */
export function kickoffComment(key: string, previewUrl: string | null): string {
  return [
    `<!-- factory-turn kickoff -->`,
    `### ${key} — build started`,
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
}

/**
 * The first comment on a build PR: which card it is, where the preview is, and
 * how the human grants each turn.
 *
 * Auto-continue is off by design — every build turn needs a human comment. This
 * is where that is explained, on the PR, where the person actually is.
 *
 * Everything it needs comes off the pull request itself, which is the only
 * thing this process and the turn that opened the branch have in common. It
 * used to read .agent/in/meta.json — but that file is written by `factory
 * gather` inside build-start.yml, and this runs in build-setup.yml: a different
 * workflow, a different runner, a fresh checkout, and `.agent/` is gitignored.
 * It was therefore never present and the comment was never posted. The factory
 * block in the PR body holds the same two facts and outlives the run that wrote
 * it, which also makes the workflow_dispatch retry path work.
 */
export function kickoff(prNumber: number, dryRun = false): void {
  const pr = prBodyAndBranch(prNumber)

  // The branch is the fallback because the block can be absent — a PR opened by
  // hand, or a body edited to death — and the branch name still carries the key.
  const block = parseFactoryBlock(pr.body)
  const key = block?.key ?? cardKeyFromBranch(pr.headRefName)
  if (key === null || key === '') {
    throw new Error(
      `PR #${prNumber} has no factory block in its body and its branch ` +
        `(${pr.headRefName}) is not a card/<KEY>-<slug> branch, so there is no card ` +
        `to announce. Is this pull request really part of the factory?`,
    )
  }

  const body = kickoffComment(key, block?.preview_url ?? null)

  if (dryRun) {
    console.log(body)
    return
  }
  commentOnPr(prNumber, body)
  console.log(`kickoff: commented on PR #${prNumber}`)
}
