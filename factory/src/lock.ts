import { runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import { gh, ghJson, repoSlug } from './github.ts'
import { claimCard, handBackTarget } from './progress.ts'
import { TRIAGE_PROPERTY, addressedTo } from './triage.ts'

/**
 * The lock: while the factory works a card, nobody else can move it.
 *
 * Jira does the locking, not this file. The Factory workflow carries two
 * permission properties on each of the statuses below —
 * `jira.permission.transition.user` and `jira.permission.assign.user`, both set
 * to the factory's account — so on a card in one of them only the factory can
 * change the status or the assignee. Not a project admin, not a site admin.
 * The board simply will not take the drop. `bootstrap/jira.sh` sets them; see
 * ADR 0007.
 *
 * So holding a card means *being in one of these statuses*, and everything the
 * factory does to a card happens in one of them: the poller and triage move a
 * card in before they dispatch, refresh moves one to Building before handing it
 * to the build agent, and a build turn started from a pull request comment
 * moves its card to Building as its first act.
 *
 * What this file adds is the two ways out that are not the end of a turn:
 *
 *   stop     a person comments "@Enki stop". The run is cancelled and the card
 *            goes back to where it was before the factory took it.
 *   orphans  a run died without reporting — cancelled, timed out, the runner
 *            vanished. Nothing else can move the card now, so the poller
 *            looks for locked cards with no run and puts them back.
 */

/** The statuses Jira locks to the factory. Must match bootstrap/jira.sh. */
export const LOCKED_STATUSES = ['Designing', 'Building'] as const

/**
 * The workflows that work a locked card, one card per run.
 *
 * Each names its run after the card (`run-name: <KEY> …`), which is how a run
 * is found from a key. refresh.yml is not here: its run covers every card in
 * review, its legs take seconds, and a card it hands to the build agent is
 * held by the build-turn run it dispatches.
 */
export const CARD_WORKFLOWS = ['design.yml', 'build-start.yml', 'build-turn.yml'] as const

/**
 * How long a card can sit locked with no run before it counts as abandoned.
 *
 * Covers the gap between the move and the run appearing: a dispatch is
 * accepted at once, but the run can take a minute to be listed.
 */
export const ORPHAN_GRACE_MS = 10 * 60_000

export function isLocked(status: string): boolean {
  return (LOCKED_STATUSES as readonly string[]).includes(status)
}

/**
 * True for a comment that tells the factory to stop.
 *
 * It must mention the factory, and "stop" must be the first word once the
 * mentions are taken out — "@Enki stop", "@Enki, stop please". A comment that
 * merely contains the word ("@Enki don't stop at the header") is not one: a
 * false positive throws away a running turn.
 */
export function isStopCommand(comment: jira.JiraComment, factoryAccountId: string): boolean {
  return (
    comment.mentions.includes(factoryAccountId) &&
    /^[\s\p{P}]*stop\b/iu.test(comment.bodyWithoutMentions)
  )
}

/**
 * Takes a card into a locked status, unless it is in one already.
 *
 * For the one entrance that reaches a turn without the poller or triage having
 * moved the card first: a comment on the pull request. The card is usually in
 * review, assigned to the reviewer, and goes back to them when the turn ends.
 * Already locked means another turn has it and this one is queued behind it in
 * the card's concurrency group, which is fine: it runs when that one is done.
 */
export async function takeCard(cfg: jira.JiraConfig, key: string, status: string): Promise<void> {
  const issue = await jira.getIssue(cfg, key)
  const current = (issue.fields['status'] as { name?: string } | undefined)?.name ?? ''
  if (!isLocked(current)) await jira.transitionTo(cfg, key, status)
  await claimCard(cfg, key)
}

/** When the card was last moved into a locked status, and where it came from. */
export interface Hold {
  /** ISO timestamp of the move. '' if the history has no such move. */
  since: string
  /** The status the card was in before. '' if unknown. */
  from: string
}

/** Reads the hold off the card's history, newest move first. */
export function holdFrom(history: jira.ChangeEntry[]): Hold {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as jira.ChangeEntry
    const move = entry.items.find(
      (item) => item.field === 'status' && isLocked(item.toString ?? ''),
    )
    if (move !== undefined) return { since: entry.created, from: move.fromString ?? '' }
  }
  return { since: '', from: '' }
}

/**
 * Where a card goes when it is let go without a result.
 *
 * Back where it came from. That is a Ready column for a card the poller took,
 * the review column for one taken from a comment there, a Blocked column for an
 * answered question. Only if the history does not say does it fall back to the
 * Ready column for the stage, which is the one place every card starts from.
 */
export function returnStatus(lockedStatus: string, hold: Hold): string {
  if (hold.from !== '' && !isLocked(hold.from)) return hold.from
  return lockedStatus === 'Designing' ? 'Ready for design' : 'Ready for build'
}

export interface CardRun {
  id: number
  url: string
  status: string
}

interface ListedRun {
  databaseId: number
  displayTitle: string
  status: string
  url: string
}

/** Every unfinished card run, by the key at the front of its name. */
export function activeRuns(): Map<string, CardRun[]> {
  const byKey = new Map<string, CardRun[]>()
  for (const workflow of CARD_WORKFLOWS) {
    const runs = ghJson<ListedRun[]>([
      'run',
      'list',
      '--repo',
      repoSlug(),
      '--workflow',
      workflow,
      '--limit',
      '50',
      '--json',
      'databaseId,displayTitle,status,url',
    ])
    for (const run of runs) {
      if (run.status === 'completed') continue
      const key = run.displayTitle.split(' ')[0] ?? ''
      if (key === '') continue
      byKey.set(key, [...(byKey.get(key) ?? []), { id: run.databaseId, url: run.url, status: run.status }])
    }
  }
  return byKey
}

/**
 * Lets go of a locked card: hands it over, moves it out, says why.
 *
 * Assign first, move second. In a locked status only the factory can do
 * either, so the order is free — and the other order would put the card in a
 * Ready column still assigned to the factory, which is precisely what starts a
 * new turn.
 */
async function letGo(
  cfg: jira.JiraConfig,
  key: string,
  to: string,
  handTo: string,
  body: adf.AdfDoc,
): Promise<void> {
  await jira.assign(cfg, key, handTo)
  await jira.transitionTo(cfg, key, to)
  await jira.addComment(cfg, key, body).catch((error: Error) => {
    console.error(`::warning::let go of ${key} but could not say why: ${error.message}`)
  })
}

function backWith(handTo: string): adf.AdfNode[] {
  return handTo === '' ? [adf.text('Nobody is assigned.')] : [adf.text('It is with '), adf.mention(handTo), adf.text('.')]
}

export function stoppedComment(
  to: string,
  handTo: string,
  runs: CardRun[],
  stillLocked: boolean,
): adf.AdfDoc {
  const cancelled =
    runs.length === 0
      ? adf.text('Nothing was running by the time I looked. ')
      : adf.text(`I cancelled the run${runs.length === 1 ? '' : 's'} working on it. `)
  const where = stillLocked
    ? [adf.text(`The card is back in ${to}. `), ...backWith(handTo)]
    : [adf.text('The turn had already finished and moved the card itself, so I have left it where it is.')]

  const blocks: adf.AdfNode[] = [
    adf.paragraph(adf.strong('Stopped, as asked.'), adf.text(' '), cancelled, ...where),
    adf.paragraph(
      adf.text(
        'Anything the turn pushed before it stopped is still on the branch. To start again, ' +
          'send the card in the usual way.',
      ),
    ),
  ]
  const links = runs.map((run, i) => adf.link(runs.length === 1 ? 'Cancelled run' : `Cancelled run ${i + 1}`, run.url))
  if (links.length > 0) blocks.push(adf.paragraph(...links.flatMap((l, i) => (i === 0 ? [l] : [adf.text('  ·  '), l]))))
  return adf.doc(...blocks)
}

export function orphanComment(status: string, to: string, handTo: string): adf.AdfDoc {
  const blocks: adf.AdfNode[] = [
    adf.paragraph(
      adf.strong('Let go of this card.'),
      adf.text(
        ` It was in ${status}, which only the factory can move a card out of, but no run was ` +
          `working on it: the last one ended without finishing — cancelled, timed out, or lost ` +
          `with its runner. The card is back in ${to}. `,
      ),
      ...backWith(handTo),
    ),
    adf.paragraph(adf.text('The Actions tab has the run that died. To try again, send the card in the usual way.')),
  ]
  const run = runUrl()
  if (run !== null) blocks.push(adf.paragraph(adf.link('This check', run)))
  return adf.doc(...blocks)
}

export interface StopOptions {
  cfg: jira.JiraConfig
  key: string
  dryRun?: boolean
  /** How long to wait for a cancelled run to finish. Tests shorten it. */
  waitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type StopOutcome = 'not-locked' | 'not-a-stop' | 'already-handled' | 'stopped'

/**
 * Acts on "@Enki stop".
 *
 * Started by a Jira Automation flow on any comment that mentions the factory on
 * a locked card, so it checks everything again: the card is still locked, the
 * newest comment addressed to the factory is a stop, and it has not been acted
 * on. The mark is triage's, so triage never reads the same comment later.
 *
 * The cancelled run usually cannot move the card itself — a build run's last
 * job is skipped on cancellation, and design.yml's report step does not run on
 * it either — so this does. If the run won the race and reported anyway, the
 * card has left the locked statuses and is left alone.
 */
export async function stop(options: StopOptions): Promise<StopOutcome> {
  const { cfg, key } = options
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))

  const issue = await jira.getIssue(cfg, key)
  const status = (issue.fields['status'] as { name?: string } | undefined)?.name ?? ''
  if (!isLocked(status)) return 'not-locked'

  const me = await jira.myAccountId(cfg)
  const comment = addressedTo(await jira.recentComments(cfg, key, 20), me)
  if (comment === null || !isStopCommand(comment, me)) return 'not-a-stop'

  const mark = (await jira.getIssueProperty(cfg, key, TRIAGE_PROPERTY)) as { commentId?: string } | null
  if (mark?.commentId === comment.id) return 'already-handled'

  const runs = activeRuns().get(key) ?? []
  if (options.dryRun === true) {
    console.log(`stop --dry-run: would cancel ${runs.length} run(s) and let go of ${key}`)
    return 'stopped'
  }

  await jira.setIssueProperty(cfg, key, TRIAGE_PROPERTY, {
    commentId: comment.id,
    action: 'stop',
    at: new Date().toISOString(),
  })

  for (const run of runs) gh(['run', 'cancel', String(run.id), '--repo', repoSlug()])
  await waitForRuns(runs, options.waitMs ?? 180_000, options.pollMs ?? 5_000, sleep)

  const now = await jira.getIssue(cfg, key)
  const statusNow = (now.fields['status'] as { name?: string } | undefined)?.name ?? ''
  const stillLocked = isLocked(statusNow)
  const to = returnStatus(statusNow, holdFrom(await jira.changelog(cfg, key)))
  const body = stoppedComment(to, comment.authorId, runs, stillLocked)

  // The person who said stop gets the card: they have just taken it back.
  if (stillLocked) await letGo(cfg, key, to, comment.authorId, body)
  else await jira.addComment(cfg, key, body)
  return 'stopped'
}

/**
 * Waits for each run to finish cancelling, and forces any that will not.
 *
 * A cancel is a request: the runner gets a signal and steps with `always()`
 * still run. Letting go of the card while the run is alive would let it push
 * and report onto a card somebody else now holds.
 */
async function waitForRuns(
  runs: CardRun[],
  waitMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let pending = [...runs]
  let forced = false
  for (let waited = 0; pending.length > 0; waited += pollMs) {
    pending = pending.filter(
      (run) =>
        ghJson<{ status: string }>(['run', 'view', String(run.id), '--repo', repoSlug(), '--json', 'status']).status !==
        'completed',
    )
    if (pending.length === 0) return
    if (waited >= waitMs) {
      if (forced) {
        console.error(`::warning::${pending.length} run(s) still not finished; letting go of the card anyway`)
        return
      }
      for (const run of pending) {
        gh(['api', '-X', 'POST', `repos/${repoSlug()}/actions/runs/${run.id}/force-cancel`])
      }
      forced = true
      waited = 0
    }
    await sleep(pollMs)
  }
}

export interface OrphanOptions {
  cfg: jira.JiraConfig
  projectKey: string
  now?: number
  dryRun?: boolean
}

/**
 * Lets go of every locked card that no run is working on.
 *
 * Runs on every poller pass, and the sweep flow starts the poller every half
 * hour while any card is locked, so an abandoned card is let go within about
 * forty minutes at worst. A card is only counted after `ORPHAN_GRACE_MS` in
 * its status, so a turn that has been dispatched but not yet listed is safe.
 */
export async function releaseOrphans(options: OrphanOptions): Promise<string[]> {
  const { cfg, projectKey } = options
  const now = options.now ?? Date.now()
  const statuses = LOCKED_STATUSES.map((s) => `"${s}"`).join(', ')
  const cards = await jira.search(cfg, `project = ${projectKey} AND status IN (${statuses})`, ['status'])
  if (cards.length === 0) return []

  const runs = activeRuns()
  const released: string[] = []

  for (const card of cards) {
    if ((runs.get(card.key) ?? []).length > 0) continue
    const status = (card.fields['status'] as { name?: string } | undefined)?.name ?? ''
    try {
      const hold = holdFrom(await jira.changelog(cfg, card.key))
      const since = Date.parse(hold.since)
      if (Number.isNaN(since) || now - since < ORPHAN_GRACE_MS) continue

      const to = returnStatus(status, hold)
      const handTo = await handBackTarget(cfg, card.key)
      if (options.dryRun === true) {
        console.log(`release-orphans --dry-run: would let go of ${card.key} into ${to}`)
        continue
      }
      await letGo(cfg, card.key, to, handTo, orphanComment(status, to, handTo))
      released.push(card.key)
    } catch (error) {
      console.error(`::warning::could not let go of ${card.key}: ${(error as Error).message}`)
    }
  }
  return released
}
