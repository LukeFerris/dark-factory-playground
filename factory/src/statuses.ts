import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { REPO_ROOT, optional } from './env.ts'

/**
 * The ten statuses the factory works in, by the names it knows them by.
 *
 * The code, the manuals and docs/factory/STATE-MACHINE.md are written against
 * these names. On the board they are only the names the statuses were created
 * with: in a team-managed space, renaming a column renames its status, and
 * anyone who administers the space can do it. A factory that finds statuses by
 * name then leaves every card stuck at its next move.
 *
 * So a space can pin each name to its status id in `enki.json`:
 *
 *   { "jira": { "statuses": { "Backlog": "10054", "Ready for design": "10055", … } } }
 *
 * With that, every move, search and read goes by id, and a rename changes
 * nothing but the label. Without it, as in this repository, statuses are
 * matched by name, as they always were.
 */
export const STATUS_NAMES = [
  'Backlog',
  'Ready for design',
  'Designing',
  'Design review',
  'Blocked on architect',
  'Ready for build',
  'Building',
  'In review',
  'Blocked on engineer',
  'Done',
] as const
export type StatusName = (typeof STATUS_NAMES)[number]

export type StatusIds = Record<StatusName, string>

/** A status as Jira reports it: on a card, a transition, or a line of history. */
export interface StatusRef {
  id?: string | null
  name?: string | null
}

const ConfigSchema = z
  .object({
    jira: z
      .object({
        statuses: z.record(z.enum(STATUS_NAMES), z.string().regex(/^\d+$/, 'a status id is all digits')).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

/** Where the config is read from. `ENKI_CONFIG` moves it, for tests. */
export function configPath(): string {
  return optional('ENKI_CONFIG', resolve(REPO_ROOT, 'enki.json'))
}

/**
 * The pinned ids from `file`, or null when there are none.
 *
 * All ten or nothing. A half-pinned space would find some statuses by id and
 * the rest by name, which is the failure this exists to prevent, so it is
 * refused rather than guessed at. So is an id given to two names.
 */
export function readStatusIds(file: string = configPath()): StatusIds | null {
  if (!existsSync(file)) return null
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const pinned = parsed.data.jira?.statuses
  if (pinned === undefined) return null

  const missing = STATUS_NAMES.filter((name) => pinned[name] === undefined)
  if (missing.length > 0) {
    throw new Error(`${file}: jira.statuses has no id for ${missing.map((m) => `"${m}"`).join(', ')}. Pin all ten, or none.`)
  }
  const ids = pinned as StatusIds
  const shared = STATUS_NAMES.filter((name, i) => STATUS_NAMES.findIndex((other) => ids[other] === ids[name]) !== i)
  if (shared.length > 0) {
    throw new Error(`${file}: jira.statuses gives ${shared.map((s) => `"${s}"`).join(', ')} an id already used by another status.`)
  }
  return ids
}

let cached: StatusIds | null | undefined

/** The pinned ids, read once per process. */
export function statusIds(): StatusIds | null {
  if (cached === undefined) cached = readStatusIds()
  return cached
}

/** Forgets what was read, so a test can point `ENKI_CONFIG` somewhere else. */
export function resetStatusIds(): void {
  cached = undefined
}

/** One of the ten, whatever the capitals, or undefined. */
function known(name: string): StatusName | undefined {
  const wanted = name.trim().toLowerCase()
  return STATUS_NAMES.find((n) => n.toLowerCase() === wanted)
}

/** The id `name` is pinned to, or undefined when it is matched by name. */
export function pinnedId(name: string): string | undefined {
  const ids = statusIds()
  const status = known(name)
  return ids === null || status === undefined ? undefined : ids[status]
}

/** The value for `status = …` in JQL: the id when pinned, the quoted name otherwise. */
export function jqlStatus(name: string): string {
  return pinnedId(name) ?? `"${name}"`
}

/**
 * The factory's name for a status Jira reports.
 *
 * By id when the ids are pinned, so a renamed column still reads as the status
 * the factory knows. Anything else, such as a status that is not one of the
 * ten, keeps the name Jira gave it.
 */
export function nameOf(status: StatusRef | null | undefined): string {
  const ids = statusIds()
  if (ids !== null && status?.id != null) {
    const match = STATUS_NAMES.find((name) => ids[name] === status.id)
    if (match !== undefined) return match
  }
  return (status?.name ?? '').trim()
}

/** A card's current status, by the factory's name for it. */
export function statusOfCard(fields: Record<string, unknown>): string {
  return nameOf(fields['status'] as StatusRef | undefined)
}
