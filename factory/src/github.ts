import { spawnSync } from 'node:child_process'

/**
 * Every GitHub call shells out to `gh api`.
 *
 * That is deliberate: it keeps the credential question in the workflow YAML
 * (whatever is in GH_TOKEN) instead of in this code, so no step needs to know
 * how to mint or hold an App token.
 */
export type Runner = (args: string[], input?: string) => { status: number; stdout: string; stderr: string }

export const ghRunner: Runner = (args, input) => {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

let runner: Runner = ghRunner
/** Test seam — swap in a stub so unit tests never shell out. */
export function setRunner(next: Runner): void {
  runner = next
}
export function getRunner(): Runner {
  return runner
}

export function gh(args: string[], input?: string): string {
  const result = runner(args, input)
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

export function ghJson<T>(args: string[], input?: string): T {
  const out = gh(args, input).trim()
  return (out === '' ? null : JSON.parse(out)) as T
}

export function repoSlug(): string {
  const fromEnv = process.env['GITHUB_REPOSITORY']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const owner = process.env['GH_OWNER']
  const repo = process.env['GH_REPO']
  if (owner === undefined || repo === undefined || owner === '' || repo === '') {
    throw new Error('Cannot determine repository: set GITHUB_REPOSITORY, or GH_OWNER and GH_REPO.')
  }
  return `${owner}/${repo}`
}

export interface PullRequest {
  number: number
  url: string
  body: string
  isDraft: boolean
  headRefOid: string
}

export function findPrForBranch(branch: string): PullRequest | null {
  const out = ghJson<PullRequest[]>([
    'pr',
    'list',
    '--repo',
    repoSlug(),
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,url,body,isDraft,headRefOid',
  ])
  return out !== null && out.length > 0 ? (out[0] as PullRequest) : null
}

/**
 * The open pull request for a card, found by its branch.
 *
 * Matched on the `card/<KEY>-` prefix rather than by asking Jira for the
 * summary and rebuilding the branch name: the summary can be edited on the
 * card after the branch was cut, and then the name no longer round-trips. The
 * trailing hyphen is load-bearing — without it `DF-3` would also match
 * `card/DF-30-…`.
 */
export function findPrForCard(key: string): PullRequest | null {
  const out = ghJson<Array<PullRequest & { headRefName: string }>>([
    'pr',
    'list',
    '--repo',
    repoSlug(),
    '--state',
    'open',
    '--json',
    'number,url,body,isDraft,headRefOid,headRefName',
  ])
  const prefix = `card/${key}-`
  return (out ?? []).find((pr) => pr.headRefName.startsWith(prefix)) ?? null
}

/**
 * Starts a workflow by `workflow_dispatch`.
 *
 * Whether this actually starts a run depends entirely on the token in the
 * environment: a dispatch made with GITHUB_TOKEN is accepted and then quietly
 * does nothing, which is why every caller runs under the App token.
 */
export function dispatchWorkflow(workflow: string, inputs: Record<string, string>): void {
  gh([
    'workflow',
    'run',
    workflow,
    '--repo',
    repoSlug(),
    ...Object.entries(inputs).flatMap(([name, value]) => ['-f', `${name}=${value}`]),
  ])
}

export function createDraftPr(branch: string, title: string, body: string): PullRequest {
  gh([
    'pr',
    'create',
    '--repo',
    repoSlug(),
    '--head',
    branch,
    '--base',
    'main',
    '--title',
    title,
    '--body-file',
    '-',
    '--draft',
  ], body)
  const pr = findPrForBranch(branch)
  if (pr === null) throw new Error(`Created a PR for ${branch} but could not read it back.`)
  return pr
}

export function updatePrBody(number: number, body: string): void {
  gh(['pr', 'edit', String(number), '--repo', repoSlug(), '--body-file', '-'], body)
}

export function setPrTitle(number: number, title: string): void {
  gh(['pr', 'edit', String(number), '--repo', repoSlug(), '--title', title])
}

export function addLabel(number: number, label: string): void {
  gh(['pr', 'edit', String(number), '--repo', repoSlug(), '--add-label', label])
}

export function markReady(number: number): void {
  gh(['pr', 'ready', String(number), '--repo', repoSlug()])
}

export function commentOnPr(number: number, body: string): void {
  gh(['pr', 'comment', String(number), '--repo', repoSlug(), '--body-file', '-'], body)
}

export interface PrComment {
  author: string
  createdAt: string
  body: string
}

export function prComments(number: number): PrComment[] {
  const out = ghJson<{ comments?: Array<{ author?: { login?: string }; createdAt?: string; body?: string }> }>([
    'pr',
    'view',
    String(number),
    '--repo',
    repoSlug(),
    '--json',
    'comments',
  ])
  return (out?.comments ?? []).map((c) => ({
    author: c.author?.login ?? 'unknown',
    createdAt: c.createdAt ?? '',
    body: c.body ?? '',
  }))
}

/**
 * The machine-readable block the factory keeps at the bottom of every PR body.
 *
 * It is how a later turn recovers state (which card, which turn, where the
 * preview is) without having to re-derive it. Humans edit the prose above it;
 * the factory only ever rewrites what is between the markers.
 */
export const FACTORY_BLOCK_START = '<!-- factory'
export const FACTORY_BLOCK_END = 'factory -->'

export interface FactoryBlock {
  key: string
  stage: string
  turn: number
  preview_url?: string
}

export function renderFactoryBlock(block: FactoryBlock): string {
  return `${FACTORY_BLOCK_START}\n${JSON.stringify(block, null, 2)}\n${FACTORY_BLOCK_END}`
}

/**
 * Finds the block, which is not the same as finding `<!-- factory` in the body.
 *
 * The prose the factory writes above the block *mentions* the marker — "the
 * `<!-- factory … -->` block below is machine-read" — and a reviewer quoting
 * it in the description would do the same. Searching for the bare marker finds
 * that sentence first, and then everything downstream is wrong in a way that
 * looks like nothing happening: `parseFactoryBlock` returns null because the
 * prose is not JSON, so `preview-up` quietly declines to record the preview
 * URL, and `upsertFactoryBlock` rewrites from the middle of the sentence and
 * eats the paragraph.
 *
 * So both markers only count on a line of their own, and the last such pair
 * wins — the real block is at the bottom of the body.
 */
const FACTORY_BLOCK_RE = /^<!-- factory[ \t]*\r?\n([\s\S]*?)\r?\n^factory -->[ \t]*$/gm

function locateFactoryBlock(
  body: string,
): { start: number; end: number; json: string } | null {
  let found: { start: number; end: number; json: string } | null = null
  for (const match of body.matchAll(FACTORY_BLOCK_RE)) {
    found = {
      start: match.index,
      end: match.index + match[0].length,
      json: match[1] ?? '',
    }
  }
  return found
}

export function parseFactoryBlock(body: string): FactoryBlock | null {
  const found = locateFactoryBlock(body)
  if (found === null) return null
  try {
    return JSON.parse(found.json) as FactoryBlock
  } catch {
    return null
  }
}

/** Replaces the factory block in a body, or appends one if there is none. */
export function upsertFactoryBlock(body: string, block: FactoryBlock): string {
  const rendered = renderFactoryBlock(block)
  const found = locateFactoryBlock(body)
  if (found === null) return `${body.trimEnd()}\n\n${rendered}\n`
  return body.slice(0, found.start) + rendered + body.slice(found.end)
}

/**
 * A pull request's body and head branch: everything a run that did not open it
 * needs to work out which card it belongs to and where its preview is.
 */
export function prBodyAndBranch(number: number): { body: string; headRefName: string } {
  return ghJson<{ body: string; headRefName: string }>([
    'pr',
    'view',
    String(number),
    '--repo',
    repoSlug(),
    '--json',
    'body,headRefName',
  ])
}

/**
 * The GHCR container-versions collection for this repo's owner.
 *
 * GitHub scopes package routes by owner KIND, and the two are different
 * endpoints: `/users/{owner}/packages/...` and `/orgs/{org}/packages/...`.
 * Asking an organisation for the user route is a 404, not a redirect, so the
 * owner kind has to be resolved rather than assumed — GH_OWNER is documented as
 * "a GitHub user or org".
 *
 * Deliberately NOT `/user/packages/...`: that route means "the authenticated
 * user", and `preview-down` runs under GITHUB_TOKEN, an installation token with
 * no user behind it at all.
 */
export function packageVersionsPath(): string {
  const slug = repoSlug()
  const [owner, repo] = slug.split('/')
  const { owner: repoOwner } = ghJson<{ owner: { type: string } }>(['api', `repos/${slug}`])
  const scope = repoOwner.type === 'Organization' ? 'orgs' : 'users'
  return `${scope}/${owner}/packages/container/${repo}/versions`
}

/**
 * `transient` is what tells GitHub the environment is going to be destroyed,
 * which is how the UI knows to stop showing a preview once its PR is gone.
 * Production is the opposite of transient and says so, otherwise the one
 * deployment anybody actually cares about would be the one GitHub hides.
 */
export interface DeploymentOptions {
  transient?: boolean
  production?: boolean
}

export function createDeployment(
  sha: string,
  environment: string,
  environmentUrl: string,
  options: DeploymentOptions = {},
): void {
  const transient = options.transient ?? true
  const production = options.production ?? false

  const deployment = ghJson<{ id: number }>([
    'api',
    `repos/${repoSlug()}/deployments`,
    '-X',
    'POST',
    '-f',
    `ref=${sha}`,
    '-f',
    `environment=${environment}`,
    '-F',
    'auto_merge=false',
    '-F',
    `transient_environment=${transient}`,
    '-F',
    `production_environment=${production}`,
    '-f',
    'required_contexts[]',
  ])
  gh([
    'api',
    `repos/${repoSlug()}/deployments/${deployment.id}/statuses`,
    '-X',
    'POST',
    '-f',
    'state=success',
    '-f',
    `environment_url=${environmentUrl}`,
  ])
}

export function deactivateDeployments(environment: string): void {
  const deployments = ghJson<Array<{ id: number }>>([
    'api',
    `repos/${repoSlug()}/deployments?environment=${encodeURIComponent(environment)}`,
  ])
  for (const d of deployments ?? []) {
    try {
      gh([
        'api',
        `repos/${repoSlug()}/deployments/${d.id}/statuses`,
        '-X',
        'POST',
        '-f',
        'state=inactive',
      ])
    } catch {
      // A deployment we cannot mark inactive is not worth failing teardown over.
    }
  }
}
