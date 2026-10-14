import { optional, runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import {
  assertCommitSha,
  azureConfig,
  buildProductionImage,
  deployProduction,
  productionAppName,
} from './azure.ts'
import { createDeployment, parseFactoryBlock, prBodyAndBranch, repoSlug } from './github.ts'
import { cardKeyFromBranch, previewBackend, waitUntilAwake } from './preview.ts'
import { LINK_IDS, dropLink, syncLinks } from './progress.ts'
import { findRun, waitForRun, type RunWaitOptions } from './runs.ts'

/**
 * Production — the other half of the loop.
 *
 * Until this existed the factory could design, build, preview and review, and
 * then the code landed on main and ran nowhere. The preview it had been
 * demonstrated on was deliberately destroyed on merge and nothing replaced it.
 *
 * Two steps, in this order and for the same reason the preview job runs before
 * the report: `production-up` puts the merge commit on the internet and proves
 * it answers, and only then does `ship` move the card to Done. A card that
 * says Done before the thing is live is a card that lies, and the whole point
 * of a status a human cannot set is that it means something.
 *
 * Both are driven by .github/workflows/production.yml on a merged pull
 * request. Neither runs an agent, so neither holds an Anthropic key.
 */

/** The status the bot moves a card to once production is serving the merge. */
export const SHIPPED_STATUS = 'Done'

/**
 * A production the repository deploys itself, from `FACTORY_PRODUCTION_URL`
 * and `FACTORY_PRODUCTION_WORKFLOWS`, or null when the factory deploys it.
 *
 * A repository that already ships main on every push has workflows that do
 * it, and a second deployment from the factory would be a rival production.
 * So the factory waits for those workflows to finish on the merge commit,
 * checks the site answers, and only then moves the card.
 *
 * The workflows are a comma-separated list of files. One ending in `?` is
 * waited for only if it ran: a workflow filtered by path, such as one that
 * applies database migrations, has no run for a merge that did not touch them.
 */
export interface ExternalProduction {
  url: string
  workflows: Array<{ file: string; ifRan: boolean }>
}

export function externalProduction(): ExternalProduction | null {
  const url = optional('FACTORY_PRODUCTION_URL').replace(/\/+$/, '')
  if (url === '') return null
  if (!url.startsWith('https://')) {
    throw new Error(`FACTORY_PRODUCTION_URL must be an https:// URL, not "${url}".`)
  }
  const workflows = optional('FACTORY_PRODUCTION_WORKFLOWS')
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '')
    .map((w) => ({ file: w.replace(/\?$/, ''), ifRan: w.endsWith('?') }))
  if (!workflows.some((w) => !w.ifRan)) {
    throw new Error(
      'FACTORY_PRODUCTION_WORKFLOWS must name at least one workflow that always deploys main, ' +
        'or a card could be marked Done on the strength of nothing having run.',
    )
  }
  return { url, workflows }
}

/**
 * Whether there is a production to ship to.
 *
 * Either the repository deploys it (`FACTORY_PRODUCTION_URL`), or the factory
 * does, which needs the Azure backend. The `ghcr` stub pushes an image nobody
 * serves, so there is no URL to prove and nothing a human could visit —
 * "shipped" would be a claim about a package page. Rather than move the card
 * to Done on the strength of that, the workflow skips, the card stays in
 * review, and the log says why.
 */
export function productionSupported(): boolean {
  return externalProduction() !== null || previewBackend() === 'azure'
}

/**
 * Waits for the repository's own deployment of `sha`, and for the site to
 * answer.
 *
 * The workflows are waited for in the order given, the ones that must run
 * first: by the time they have finished, every workflow the push started has
 * a run, so one with none really did not run.
 */
export async function waitForExternalProduction(
  sha: string,
  production: ExternalProduction,
  options: RunWaitOptions & { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const ordered = [
    ...production.workflows.filter((w) => !w.ifRan),
    ...production.workflows.filter((w) => w.ifRan),
  ]
  for (const { file, ifRan } of ordered) {
    if (ifRan && findRun(file, sha, 'push') === null) {
      console.log(`production-up: ${file} did not run for ${sha.slice(0, 7)}; nothing to wait for.`)
      continue
    }
    const run = await waitForRun(file, () => findRun(file, sha, 'push'), 1, options)
    console.log(`production-up: ${file} deployed ${sha.slice(0, 7)} (${run.html_url})`)
  }

  const elapsed = await waitUntilAwake(
    production.url,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  )
  console.log(`production-up: ${production.url} answered after ${(elapsed / 1000).toFixed(1)}s.`)
  return production.url
}

/**
 * Builds the merge commit, deploys it, and waits for it to answer.
 *
 * `sha` is the merge commit on main, not the PR head: production serves what
 * is on the default branch, and on a squash merge the head commit is not on
 * the default branch at all.
 *
 * Deliberately fatal if it never answers. The caller is about to tell a human
 * the card is Done, and the last two things to go wrong here — a container
 * that builds but will not serve, and an ingress whose DNS has not caught up —
 * both look exactly like success from the deployment's point of view.
 */
export async function productionUp(sha: string, dryRun = false): Promise<string> {
  if (!productionSupported()) {
    throw new Error(
      `production-up needs FACTORY_PRODUCTION_URL or FACTORY_PREVIEW_BACKEND=azure; the ghcr ` +
        `stub serves nothing, so there would be no production site to point anyone at.`,
    )
  }

  assertCommitSha(sha)

  // The repository deploys production itself. No Deployment is recorded here:
  // the workflows that deployed it record their own.
  const external = externalProduction()
  if (external !== null) {
    if (dryRun) {
      const files = external.workflows
        .map((w) => `${w.file}${w.ifRan ? ' (if it ran)' : ''}`)
        .join(', ')
      console.log(
        `production-up --dry-run: would wait for ${files} on ${sha}, then for ${external.url}`,
      )
      return external.url
    }
    return waitForExternalProduction(sha, external)
  }

  const prefix = optional('AZURE_PREVIEW_PREFIX', 'df')

  // Before azureConfig(), so a dry run works on a laptop that has none of the
  // Azure variables set — the point of it is to check the wiring, not the
  // subscription.
  if (dryRun) {
    const name = productionAppName(prefix)
    console.log(`production-up --dry-run: would build main-${sha} and deploy it to ${name}`)
    return `https://<${name}>.azurecontainerapps.io`
  }

  const config = azureConfig()
  buildProductionImage(config, sha)
  const url = deployProduction(config, sha, prefix)

  const elapsed = await waitUntilAwake(url)
  console.log(`production-up: ${url} answered after ${(elapsed / 1000).toFixed(1)}s.`)

  // Not transient, and flagged as the production environment: this one is not
  // going to be torn down, and it is the deployment the repository's front
  // page should show.
  createDeployment(sha, 'production', url, { transient: false, production: true })

  console.log(`production-up: ${url}`)
  return url
}

/** The Jira comment that closes a card out. */
export function shippedComment(
  key: string,
  url: string,
  prLink: string | null,
  run: string | null,
): adf.AdfDoc {
  const blocks: adf.AdfNode[] = [
    adf.heading(`${key} — shipped`),
    adf.paragraph(
      adf.text('The pull request for this card is merged and production is serving it. '),
      adf.text('This card was moved to '),
      adf.strong(SHIPPED_STATUS),
      adf.text(' by the factory, after the deployment answered.'),
    ),
    adf.paragraph(adf.strong('Live: '), adf.link(url, url)),
  ]

  // No launcher in front of this link. Production does not sleep, so there is
  // no cold start to hide and nothing to forward through — the launcher exists
  // for previews and would only add a redirect.
  if (prLink !== null) blocks.push(adf.paragraph(adf.link('Pull request', prLink)))
  if (run !== null) blocks.push(adf.paragraph(adf.link('Actions run', run)))
  return adf.doc(...blocks)
}

export interface ShipOptions {
  pr: number
  url: string
  dryRun?: boolean
}

/**
 * Moves the card to Done, and says on the card why.
 *
 * The card key comes off the pull request the same way `kickoff` finds it: the
 * factory block first, the `card/<KEY>-` branch name as the fallback. A merged
 * PR keeps both even after its branch is deleted.
 *
 * Comment before transition. If the transition fails — which is exactly what a
 * misconfigured "only the bot may close this" condition looks like — the card
 * is left where it is with an explanation already on it, rather than silently
 * stuck. The workflow then fails loudly and a human can finish the move.
 */
export async function ship(options: ShipOptions): Promise<string> {
  const { pr, url } = options
  const prInfo = prBodyAndBranch(pr)
  const key = parseFactoryBlock(prInfo.body)?.key ?? cardKeyFromBranch(prInfo.headRefName)

  if (key === null || key === '') {
    throw new Error(
      `PR #${pr} has no factory block in its body and its branch (${prInfo.headRefName}) is ` +
        `not a card/<KEY>-<slug> branch, so there is no card to close.`,
    )
  }

  const prLink = `https://github.com/${repoSlug()}/pull/${pr}`
  const comment = shippedComment(key, url, prLink, runUrl())

  if (options.dryRun === true) {
    console.log(`ship --dry-run: would move ${key} to ${SHIPPED_STATUS} and comment:`)
    console.log(JSON.stringify(comment, null, 2))
    return key
  }

  const cfg = jira.configFromEnv()
  await jira.addComment(cfg, key, comment).catch((error: Error) => {
    console.error(`::warning::could not comment on ${key}: ${error.message}`)
  })

  // A shipped card gets two rows: where the software is, and how it got there.
  // The preview row is removed rather than left — build-teardown.yml deletes
  // that container on the same merge, so within a minute it is a link to
  // nothing, and a dead link on a card nobody is watching any more is worse
  // than no link. `Live` replaces it in the same panel.
  await syncLinks(cfg, key, [
    { globalId: LINK_IDS.pr, title: `Pull request #${pr}`, url: prLink },
    { globalId: LINK_IDS.live, title: 'Live', url },
  ])
  await dropLink(cfg, key, LINK_IDS.preview)

  await jira.transitionTo(cfg, key, SHIPPED_STATUS)

  console.log(`ship: ${key} -> ${SHIPPED_STATUS} (${url})`)
  return key
}
