import { prUrl, runUrl } from './env.ts'
import * as adf from './adf.ts'
import * as jira from './jira.ts'
import { readMeta, type Meta } from './meta.ts'

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

export function startComment(meta: Meta, run: string | null): adf.AdfDoc {
  const blocks: adf.AdfNode[] = [
    adf.heading(`${meta.stage} turn ${meta.turn} started`),
    adf.paragraph(adf.text(intent(meta))),
    adf.paragraph(
      adf.text('Nothing is expected of you while this runs. The factory comments again when '),
      adf.text('the turn finishes, and moves the card itself.'),
    ),
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
 * Posts the start comment for the turn described by `.agent/in/meta.json`.
 *
 * Runs straight after `gather`, which is the first step that knows which card
 * and which turn this is. Earlier would mean guessing the turn number; later
 * would mean announcing a turn that has already half happened.
 */
export async function announce(options: AnnounceOptions = {}): Promise<void> {
  const meta = readMeta()
  const comment = startComment(meta, runUrl())

  if (options.dryRun === true) {
    console.log(`announce --dry-run: would comment on ${meta.key}:`)
    console.log(JSON.stringify(comment, null, 2))
    return
  }

  try {
    await jira.addComment(jira.configFromEnv(), meta.key, comment)
    console.log(`announce: told ${meta.key} that ${meta.stage} turn ${meta.turn} has started.`)
  } catch (error) {
    // Warn, never throw. The turn is already running; failing it here would
    // trade real work for a notification.
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::warning::could not announce the start of the turn on ${meta.key}: ${message}`)
  }
}
