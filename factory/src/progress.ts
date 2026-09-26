import { prUrl } from './env.ts'
import * as jira from './jira.ts'
import { launcherFor } from './launcher.ts'
import type { Meta } from './meta.ts'

/**
 * The two ways a card shows progress without saying anything.
 *
 * `announce` and `report` bracket a turn with comments, which is the loud
 * channel: it notifies watchers, it lands in an email, and every one of them is
 * a line somebody has to scroll past later. Two things do not want that
 * treatment.
 *
 * **Where to look** — the pull request, the preview, the live site — is a fact
 * about the card that *changes*, not an event. As comments those URLs
 * accumulate: a four-turn build leaves four "Preview:" lines and the reader has
 * to work out which one still resolves. As remote links there is one row per
 * thing, updated in place, always current.
 *
 * **Who has it right now** is the assignee field. An avatar on the board is
 * read at a glance from the one view where nobody opens the card at all, and
 * assignment notifies nobody, so it costs the watcher nothing.
 *
 * Everything here is best-effort and warns rather than throws. None of it is
 * the work; all of it is decoration on the work, and decoration that can fail a
 * turn is a bad trade. The one thing that must not happen is a silent failure,
 * hence the warnings.
 */

/**
 * The issue property holding whoever had the card before the factory took it.
 *
 * Invisible on the card, like triage's mark. Without it, "give the card back
 * when the turn ends" has nothing to give it back to, and the factory would
 * quietly strip an assignment a human made — the sort of small theft that is
 * very annoying and very hard to attribute.
 */
export const ASSIGNEE_PROPERTY = 'factory-assignee'

interface HeldBy {
  /** Account id, or '' for "the card was unassigned". */
  previous: string
}

/**
 * Takes the card, remembering who had it.
 *
 * Idempotent across a re-run: if the factory already holds the card the saved
 * value is left alone, because overwriting it would replace the human with the
 * bot and `release` would then hand the card back to the factory forever.
 */
export async function claimCard(cfg: jira.JiraConfig, key: string): Promise<void> {
  try {
    const me = await jira.myAccountId(cfg)
    const current = await jira.assigneeOf(cfg, key)
    if (current === me) return

    await jira.setIssueProperty(cfg, key, ASSIGNEE_PROPERTY, { previous: current } satisfies HeldBy)
    await jira.assign(cfg, key, me)
  } catch (error) {
    warn(`could not assign ${key} to the factory`, error)
  }
}

/**
 * Gives the card back to whoever had it, or leaves it unassigned.
 *
 * Only if the factory is still the assignee. A human who takes a card
 * mid-turn — which is exactly what someone does when they decide to step in —
 * has said something by doing it, and the end of the turn must not undo it.
 */
export async function releaseCard(cfg: jira.JiraConfig, key: string): Promise<void> {
  try {
    const me = await jira.myAccountId(cfg)
    if ((await jira.assigneeOf(cfg, key)) !== me) return

    const held = (await jira.getIssueProperty(cfg, key, ASSIGNEE_PROPERTY)) as HeldBy | null
    await jira.assign(cfg, key, held?.previous ?? '')
  } catch (error) {
    warn(`could not hand ${key} back`, error)
  }
}

/** The identities of the factory's links on a card. One row each, forever. */
export const LINK_IDS = {
  pr: 'factory-pull-request',
  preview: 'factory-preview',
  live: 'factory-live',
} as const

export interface RemoteLink {
  globalId: string
  title: string
  url: string
}

/**
 * The links a turn can offer, given what it knows.
 *
 * Nothing is linked speculatively. Design turn 1 has no branch and no pull
 * request, and a build turn before `preview-up` has no preview — putting a row
 * on the card for either would be a dead link at the moment somebody is most
 * likely to click it.
 *
 * The preview goes through the launcher for the same reason `report` does: the
 * card is read by a person, possibly days later, long after the app has scaled
 * back to zero.
 */
export function turnLinks(meta: Meta): RemoteLink[] {
  const links: RemoteLink[] = []

  const pr = prUrl(meta.pr)
  if (pr !== null) links.push({ globalId: LINK_IDS.pr, title: `Pull request #${meta.pr}`, url: pr })

  const preview = launcherFor(meta.preview_url)
  if (preview !== null && preview !== '') {
    links.push({ globalId: LINK_IDS.preview, title: 'Preview', url: preview })
  }

  return links
}

/** Writes each link, stepping over the ones that fail. */
export async function syncLinks(
  cfg: jira.JiraConfig,
  key: string,
  links: RemoteLink[],
): Promise<void> {
  for (const link of links) {
    try {
      await jira.setRemoteLink(cfg, key, link)
    } catch (error) {
      warn(`could not link ${link.title} on ${key}`, error)
    }
  }
}

/**
 * Removes a link the card should no longer offer.
 *
 * Tolerant of a card that never had it — a 404 here means the row is already
 * absent, which is the state being asked for.
 */
export async function dropLink(
  cfg: jira.JiraConfig,
  key: string,
  globalId: string,
): Promise<void> {
  try {
    await jira.deleteRemoteLink(cfg, key, globalId)
  } catch (error) {
    if (error instanceof jira.JiraNotFoundError) return
    warn(`could not remove the ${globalId} link from ${key}`, error)
  }
}

function warn(what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`::warning::${what}: ${message}`)
}
