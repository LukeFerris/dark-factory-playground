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
 * read at a glance from the one view where nobody opens the card at all. It is
 * also how a person sends a card in: the factory only takes a card in a Ready
 * column that has been assigned to it, and gives it back when the turn ends.
 *
 * Everything here is best-effort and warns rather than throws. None of it is
 * the work; all of it is decoration on the work, and decoration that can fail a
 * turn is a bad trade. The one thing that must not happen is a silent failure,
 * hence the warnings.
 */

/**
 * The issue property holding whoever the card goes back to when the turn ends.
 *
 * Invisible on the card, like triage's mark. It is written when the factory
 * takes the card, because by the end of the turn the history no longer says
 * who sent it: the newest move is the factory's own, out of "Ready for …".
 */
export const ASSIGNEE_PROPERTY = 'factory-assignee'

interface HeldBy {
  /** Account id, or '' for "nobody to hand it back to". */
  previous: string
}

/**
 * Takes the card, remembering who it goes back to.
 *
 * With `handBackTo`, that is who it goes back to, and the record is written
 * even if the factory already holds the card. That is the normal case from the
 * Ready columns, where a person assigned the card to the factory to send it in
 * and the current assignee is therefore the factory itself.
 *
 * Without it, the card goes back to whoever holds it now. That is the path for
 * `announce`, which runs inside a turn that has normally been claimed already
 * and so returns early without touching anything: overwriting the record there
 * would replace the person with the bot, and `release` would then hand the card
 * back to the factory forever.
 */
export async function claimCard(
  cfg: jira.JiraConfig,
  key: string,
  handBackTo?: string,
): Promise<void> {
  try {
    const me = await jira.myAccountId(cfg)
    const current = await jira.assigneeOf(cfg, key)

    if (handBackTo !== undefined) {
      await jira.setIssueProperty(cfg, key, ASSIGNEE_PROPERTY, {
        previous: handBackTo === me ? '' : handBackTo,
      } satisfies HeldBy)
    } else if (current !== me) {
      await jira.setIssueProperty(cfg, key, ASSIGNEE_PROPERTY, {
        previous: current,
      } satisfies HeldBy)
    }

    if (current !== me) await jira.assign(cfg, key, me)
  } catch (error) {
    warn(`could not assign ${key} to the factory`, error)
  }
}

/**
 * Who sent the card into `status`: the person who dragged it there.
 *
 * Falls back to whoever assigned the card to the factory, which covers a card
 * moved by an automation, and then to '' for nobody. The factory's own moves
 * and assignments are skipped, so a card can never be handed back to the bot.
 */
export async function sentInBy(cfg: jira.JiraConfig, key: string, status: string): Promise<string> {
  const me = await jira.myAccountId(cfg)
  const history = [...(await jira.changelog(cfg, key))].reverse()
  const by = (match: (item: jira.ChangeItem) => boolean): string =>
    history.find(
      (entry) => entry.authorId !== '' && entry.authorId !== me && entry.items.some(match),
    )?.authorId ?? ''

  return (
    by((item) => item.field === 'status' && item.toString === status) ||
    by((item) => item.field === 'assignee' && item.to === me)
  )
}

/** Who the card goes back to when the turn ends, or '' for nobody. */
export async function handBackTarget(cfg: jira.JiraConfig, key: string): Promise<string> {
  try {
    const held = (await jira.getIssueProperty(cfg, key, ASSIGNEE_PROPERTY)) as HeldBy | null
    const me = await jira.myAccountId(cfg)
    const previous = held?.previous ?? ''
    return previous === me ? '' : previous
  } catch (error) {
    warn(`could not read who ${key} goes back to`, error)
    return ''
  }
}

/**
 * Gives the card back to whoever sent it, or leaves it unassigned.
 *
 * Only if the factory is still the assignee. A human who takes a card
 * mid-turn — which is exactly what someone does when they decide to step in —
 * has said something by doing it, and the end of the turn must not undo it.
 */
export async function releaseCard(cfg: jira.JiraConfig, key: string): Promise<void> {
  try {
    const me = await jira.myAccountId(cfg)
    if ((await jira.assigneeOf(cfg, key)) !== me) return

    await jira.assign(cfg, key, await handBackTarget(cfg, key))
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
export async function dropLink(cfg: jira.JiraConfig, key: string, globalId: string): Promise<void> {
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
