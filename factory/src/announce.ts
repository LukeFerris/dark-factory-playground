import { prUrl, runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import { readMeta, type Meta } from './meta.ts'
import { claimCard, syncLinks, turnLinks } from './progress.ts'

/**
 * The comment that says a turn has started.
 *
 * `report` is the other end of this. Between the two, the card used to go
 * quiet: the poller moved it to *Designing* or *Building* and then nothing
 * happened on the ticket for as long as the turn took — which is minutes, and
 * looks exactly like nothing happening at all. A status change is silent. It
 * does not notify a watcher, it does not appear in the comment stream a person
 * is actually reading, and on a board it is a card that moved one column while
 * nobody was looking.
 *
 * So every turn now brackets itself: one comment when it picks the card up,
 * one when it puts it down. The first is deliberately thin — the turn has done
 * no work yet, so it has nothing to say beyond *this is running, here is where
 * to watch it*. Anything more would be a guess.
 *
 * Never fatal. A progress ping that can fail a turn is worse than no progress
 * ping, and the turn's actual output goes to Jira through `report`, which is
 * the call that has to succeed.
 */

/**
 * What a start comment's first line looks like, for the code that has to tell
 * these apart from the factory's real output.
 *
 * `gather` counts a design card's rounds by counting the factory's own
 * comments on it — no counter is stored anywhere, which is what stops a card
 * disagreeing with itself. A second factory comment per turn would have made
 * every design turn count as two. So start comments are marked, excluded from
 * that count, and kept out of the agent's task file: they are addressed to a
 * human waiting on the card, and feeding "nothing is expected of you" back to
 * the agent that caused it is worse than noise.
 */
const START_HEADING = /^(design|build) turn \d+ started$/

/** True if `body` is the flattened text of a start comment. */
export function isStartComment(body: string): boolean {
  return START_HEADING.test((body.trim().split('\n')[0] ?? '').trim())
}

/** What the turn is about to do, in one sentence a non-engineer can read. */
function intent(meta: Meta): string {
  const first = meta.turn <= 1
  if (meta.stage === 'design') {
    return first
      ? 'Reading this card and the codebase, then writing the design document for it.'
      : 'Picking up the answers left on this card and revising the design.'
  }
  return first
    ? 'Implementing the approved design, on a branch of its own.'
    : 'Picking up the latest review comments and doing another pass on the branch.'
}

/**
 * The lock, said where the person who just tried to drag the card will look.
 *
 * Jira refuses the drop without saying why (ADR 0007), so this is the
 * explanation, and the way out. Without the factory's account id — a dry run —
 * the stop instruction is written out rather than mentioned.
 */
function lockParagraph(factoryAccountId: string | undefined): adf.AdfNode {
  const who = factoryAccountId === undefined ? adf.text('@the factory') : adf.mention(factoryAccountId)
  return adf.paragraph(
    adf.text('Until then the card is locked: only the factory can move or reassign it. To stop the turn, '),
    adf.text('comment '),
    who,
    adf.text(' stop'),
    adf.text(' and the card comes back to you where it was.'),
  )
}

export function startComment(meta: Meta, run: string | null, factoryAccountId?: string): adf.AdfDoc {
  const blocks: adf.AdfNode[] = [
    adf.heading(`${meta.stage} turn ${meta.turn} started`),
    adf.paragraph(adf.text(intent(meta))),
    adf.paragraph(
      adf.text('Nothing is expected of you while this runs. The factory comments again when '),
      adf.text('the turn finishes, and moves the card itself.'),
    ),
    lockParagraph(factoryAccountId),
  ]

  // Turn 1 of a design has no pull request yet — the branch does not exist
  // until `prepare-branch`, and the PR not until `publish`. Linking the run is
  // the most that can honestly be offered at this point.
  const links: adf.AdfNode[] = []
  const pr = prUrl(meta.pr)
  if (pr !== null) links.push(adf.link('Pull request', pr))
  if (run !== null) {
    if (links.length > 0) links.push(adf.text('  ·  '))
    links.push(adf.link('Actions run', run))
  }
  if (links.length > 0) blocks.push(adf.paragraph(...links))

  return adf.doc(...blocks)
}

export interface AnnounceOptions {
  dryRun?: boolean
}

/**
 * Opens the turn described by `.agent/in/meta.json` on the card: comment,
 * assignee, links.
 *
 * Runs straight after `gather`, which is the first step that knows which card
 * and which turn this is. Earlier would mean guessing the turn number; later
 * would mean announcing a turn that has already half happened.
 *
 * Three channels, because they are read in three different places: the comment
 * by whoever is watching the ticket, the assignee by whoever is looking at the
 * board, and the links by whoever has opened the card and wants the preview.
 * `report` closes all three at the other end.
 */
export async function announce(options: AnnounceOptions = {}): Promise<void> {
  const meta = readMeta()
  const links = turnLinks(meta)

  if (options.dryRun === true) {
    console.log(`announce --dry-run: would comment on ${meta.key}:`)
    console.log(JSON.stringify(startComment(meta, runUrl()), null, 2))
    console.log(`announce --dry-run: would take ${meta.key} and link ${links.length} thing(s).`)
    return
  }

  const cfg = jira.configFromEnv()

  try {
    const me = await jira.myAccountId(cfg)
    await jira.addComment(cfg, meta.key, startComment(meta, runUrl(), me))
    console.log(`announce: told ${meta.key} that ${meta.stage} turn ${meta.turn} has started.`)
  } catch (error) {
    // Warn, never throw. The turn is already running; failing it here would
    // trade real work for a notification.
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::warning::could not announce the start of the turn on ${meta.key}: ${message}`)
  }

  await claimCard(cfg, meta.key)
  await syncLinks(cfg, meta.key, links)
}
