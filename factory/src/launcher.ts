import { optional } from './env.ts'

/**
 * Wrapping preview links in the always-on loading page.
 *
 * A preview scales to zero, and Container Apps holds the first request while a
 * replica starts rather than answering it — 22 seconds of blank tab on a
 * measured cold start, which reads as a broken link. `preview-up` warms the app
 * so the common case is already hot, and the cooldown is long enough to cover a
 * review session, but neither helps the person who comes back tomorrow. The
 * launcher does: a static page on Azure Storage that renders instantly, says
 * what is happening, and redirects when the app answers. It is provisioned by
 * infra/azure/launcher.tf, which also sets AZURE_PREVIEW_LAUNCHER.
 *
 * The split this module exists to enforce: **links humans click go through the
 * launcher, and the URL the agent is given does not.** The agent's build turn
 * curls PREVIEW_URL to check the site is serving, and the launcher would answer
 * 200 with its own HTML while the app behind it was broken or absent — the same
 * trap the `ghcr` stub already falls into by pointing at a package page. So the
 * factory block keeps the real URL, as the single source of truth, and this
 * wraps it at the point of display.
 */

/** Every Container Apps ingress hostname ends in this. */
export const PREVIEW_HOST_SUFFIX = '.azurecontainerapps.io'

/** Configured launcher origin, without its trailing slash, or '' if there is none. */
export function launcherBase(): string {
  return optional('AZURE_PREVIEW_LAUNCHER', '').trim().replace(/\/+$/, '')
}

/**
 * The URL to show a human for a preview.
 *
 * Returns the input unchanged when there is no launcher configured, when the
 * URL is not a Container App (the `ghcr` stub's package page is already a page
 * that loads), or when it is not a URL at all. A launcher that only sometimes
 * exists must never be the reason a link is missing.
 */
export function launcherFor(url: string, base?: string): string
export function launcherFor(url: string | null, base?: string): string | null
export function launcherFor(url: string | null, base: string = launcherBase()): string | null {
  if (url === null || url === '' || base === '') return url

  let hostname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return url
    hostname = parsed.hostname
  } catch {
    return url
  }
  if (!hostname.endsWith(PREVIEW_HOST_SUFFIX)) return url

  return `${base}/?u=${encodeURIComponent(url)}`
}
