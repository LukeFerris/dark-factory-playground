import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { doc, paragraph, text, type AdfDoc } from './adf.ts'
import { ghJson, repoSlug } from './github.ts'
import * as jira from './jira.ts'
import { configPath, jqlStatus } from './statuses.ts'

/**
 * How many pull request previews the repository can hold at once.
 *
 * Some preview hosts have a hard cap. Azure Static Web Apps holds 10 staging
 * environments on the Standard plan and 3 on Free, and a PR opened past the
 * cap builds, then fails at the upload with nothing to show for the turn. So a
 * repository on such a host sets the cap in `enki.json`:
 *
 *   { "previews": { "slots": 10 } }
 *
 * and the poller leaves a card in its Ready column, rather than starting it,
 * while every slot is held. Without `previews`, as in this repository, there
 * is no limit.
 *
 * A slot is held from a card's first turn to the day its PR closes, through
 * every column in between, so the count is of PRs, not of columns. A Jira WIP
 * limit could not do this: it only colours the column, it counts cards in one
 * place rather than PRs wherever they are, and it cannot see the PRs people
 * open by hand, which take slots from the same host.
 */
const ConfigSchema = z
  .object({
    previews: z
      .object({ slots: z.number().int().positive('slots is at least 1') })
      .passthrough()
      .optional(),
  })
  .passthrough()

/** The cap from `file`, or null when it sets none. */
export function readPreviewSlots(file: string = configPath()): number | null {
  if (!existsSync(file)) return null
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) {
    throw new Error(
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  return parsed.data.previews?.slots ?? null
}

/** The card a branch belongs to, from `card/<KEY>-…`, or null for any other branch. */
export function cardOfBranch(branch: string): string | null {
  return /^card\/([A-Z][A-Z0-9_]*-\d+)-/.exec(branch)?.[1] ?? null
}

export interface OpenPr {
  number: number
  headRefName: string
}

/**
 * Everything holding a slot, or about to: one entry per holder.
 *
 * A card's PR and the card itself are one holder, by its key. A PR that is not
 * a card's is one by its number. A card in Designing or Building holds a slot
 * before its PR exists, because the PR opens at the end of its first turn, a
 * quarter of an hour after the card was taken. So does a card this poller run
 * has just moved there, which a Jira search may not show for a second or two.
 */
export function slotHolders(open: OpenPr[], working: string[], started: string[]): string[] {
  const holders = new Set<string>()
  for (const pr of open) holders.add(cardOfBranch(pr.headRefName) ?? `#${pr.number}`)
  for (const key of [...working, ...started]) holders.add(key)
  return [...holders].sort()
}

export interface SlotVerdict {
  start: boolean
  reason: string
}

/**
 * Whether `key` may start, given the cap and who holds a slot.
 *
 * A card that already holds one always may: stopping it frees nothing, and
 * only stalls a card someone is waiting on.
 */
export function decideSlot(key: string, slots: number | null, holders: string[]): SlotVerdict {
  if (slots === null) return { start: true, reason: 'this repository sets no preview limit' }
  if (holders.includes(key)) return { start: true, reason: `${key} already holds a preview slot` }
  const used = holders.length
  if (used < slots) return { start: true, reason: `${used} of ${slots} preview slots in use` }
  return {
    start: false,
    reason: `all ${slots} preview slots are in use (${holders.join(', ')})`,
  }
}

/**
 * The open PRs, all of them.
 *
 * `gh pr list` stops at 30 unless told otherwise, and a cap is only worth
 * having on a repository that can have more open than that.
 */
export function openPullRequests(): OpenPr[] {
  return (
    ghJson<OpenPr[]>([
      'pr',
      'list',
      '--repo',
      repoSlug(),
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,headRefName',
    ]) ?? []
  )
}

/** The cards a turn is working, or about to. */
export async function workingCards(cfg: jira.JiraConfig, projectKey: string): Promise<string[]> {
  const statuses = ['Designing', 'Building'].map(jqlStatus).join(', ')
  const issues = await jira.search(cfg, `project = ${projectKey} AND status in (${statuses})`)
  return issues.map((i) => i.key)
}

/** What a waiting card is told, and how the poller recognises that it already was. */
export const WAITING = 'Waiting for a preview slot'

function waitingComment(slots: number): AdfDoc {
  return doc(
    paragraph(
      text(
        `${WAITING}. This repository can hold ${slots} pull request previews at once, and all ${slots} are in use. ` +
          'The card stays here, and starts by itself when a pull request closes. Nothing needs doing.',
      ),
    ),
  )
}

/**
 * Says so on the card, once.
 *
 * Every poller run asks again, and a comment wakes the poller, so a card that
 * said so every time would keep the poller running. It says it again only after
 * someone else has spoken on the card.
 */
export async function tellWaiting(cfg: jira.JiraConfig, key: string, slots: number): Promise<void> {
  const [newest, me] = await Promise.all([jira.latestComment(cfg, key), jira.myAccountId(cfg)])
  if (newest !== null && newest.authorId === me && newest.body.startsWith(WAITING)) return
  await jira.addComment(cfg, key, waitingComment(slots))
}

export interface SlotQuestion {
  cfg: jira.JiraConfig
  projectKey: string
  key: string
  /** Cards this poller run has already started. */
  started: string[]
  /** The cap; read from enki.json when not given. */
  slots?: number | null
}

/** The poller's question about one card: may it start now? */
export async function previewSlot(q: SlotQuestion): Promise<SlotVerdict> {
  const slots = q.slots === undefined ? readPreviewSlots() : q.slots
  if (slots === null) return decideSlot(q.key, slots, [])
  const holders = slotHolders(
    openPullRequests(),
    await workingCards(q.cfg, q.projectKey),
    q.started,
  )
  const verdict = decideSlot(q.key, slots, holders)
  if (!verdict.start) await tellWaiting(q.cfg, q.key, slots)
  return verdict
}
