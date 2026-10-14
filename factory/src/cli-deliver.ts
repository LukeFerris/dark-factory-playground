// The commands that take a turn's work to people: the walkthrough video, the
// comments that bookend a turn, the preview and production deployments, and
// the two debugging aids.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { REPO_ROOT } from './env.ts'
import { announce } from './announce.ts'
import { report } from './report.ts'
import { VERIFY_PATH, verify, writeVerdict } from './verify.ts'
import { kickoff, previewDown, previewUp } from './preview.ts'
import { productionUp, ship } from './production.ts'
import { EVIDENCE_DIR, SLIDES_PATH, buildSlides } from './evidence.ts'
import { RESULT_PATH, readMeta, writeFileEnsuringDir } from './meta.ts'
import { ResultSchema, toJsonSchema } from './schema.ts'
import { parseNumber, parseRetry, parseStage } from './cli-shared.ts'

export function registerDeliverCommands(program: Command): void {
  evidenceSlidesCommand(program)
  bookends(program)
  verifyCommand(program)
  previews(program)
  production(program)
  kickoffCommand(program)
  debugging(program)
}

function evidenceSlidesCommand(program: Command): void {
  program
    .command('evidence-slides')
    .description("Build the captioned walkthrough video from a capture run's screenshots.")
    .option('--dir <path>', 'Where the screenshots are', EVIDENCE_DIR)
    .option('--out <path>', 'Where the video goes', SLIDES_PATH)
    .action(evidenceSlides)
}

function evidenceSlides(opts: { dir: string; out: string }): void {
  // Every path out of here is exit 0, deliberately. A card that is finished
  // must reach a human whether or not a video could be made of it, so the
  // worst this command does is say why there isn't one and let `report` go
  // on without it.
  if (!existsSync(RESULT_PATH)) {
    console.log('evidence-slides: skipped — the turn wrote no result')
    return
  }
  const parsed = ResultSchema.safeParse(JSON.parse(readFileSync(RESULT_PATH, 'utf8')))
  if (!parsed.success) {
    console.log('evidence-slides: skipped — the result does not parse')
    return
  }

  const outcome = buildSlides({ result: parsed.data, dir: opts.dir, out: opts.out })
  if (outcome.missing.length > 0) {
    console.log(`evidence-slides: no screenshot for step(s) ${outcome.missing.join(', ')}`)
  }
  if (outcome.orphans.length > 0) {
    console.log(
      `::warning::evidence-slides: dropped screenshot(s) for step(s) ${outcome.orphans.join(', ')}, which the card does not list`,
    )
  }
  console.log(
    outcome.ok
      ? `evidence-slides: ${outcome.slides} slide(s) → ${outcome.video}`
      : `evidence-slides: no video — ${outcome.reason}`,
  )
}

// The bookends of a turn. `announce` says it has started, `report` says what
// it did — and between them the card would otherwise be silent for however
// long the agent takes, because a status change notifies nobody.
function bookends(program: Command): void {
  program
    .command('announce')
    .description('Comment on the card to say this turn has started.')
    .option('--dry-run', 'Print the comment without posting', false)
    .action(async (opts: { dryRun: boolean }) => {
      await announce({ dryRun: opts.dryRun })
    })

  program
    .command('report')
    .description('Post the Jira comment and apply the status transition for this turn.')
    .requiredOption('--stage <stage>', 'design | build')
    .option('--pr-url <url>', 'Pull request URL to link')
    .option(
      '--retry <n>',
      'Which automatic turn this was, after required checks failed',
      parseRetry,
      0,
    )
    .option('--dry-run', 'Print the comment without posting', false)
    .action(async (opts: { stage: string; prUrl?: string; retry: number; dryRun: boolean }) => {
      await report({
        stage: parseStage(opts.stage),
        prUrl: opts.prUrl,
        retry: opts.retry,
        dryRun: opts.dryRun,
      })
    })
}

// The gate between a finished build turn and In review. Waits for the checks
// main requires on the commit the turn pushed, and writes what it found for
// `report` to act on. Red is not an error here: it exits 0 with a verdict.
function verifyCommand(program: Command): void {
  program
    .command('verify')
    .description(
      "Wait for main's required checks on a pull request's commit, and write the verdict.",
    )
    .argument('<pr>', 'Pull request number', parseNumber)
    .requiredOption('--sha <sha>', 'The commit the turn pushed')
    .option('--out <path>', 'Where the verdict goes', VERIFY_PATH)
    .action(async (pr: number, opts: { sha: string; out: string }) => {
      const verdict = await verify({ pr, sha: opts.sha })
      writeVerdict(verdict, opts.out)
      console.log(`verify: ${verdict.outcome} on ${opts.sha}`)
      for (const c of verdict.checks) console.log(`  ${c.state.padEnd(7)} ${c.name}`)
    })
}

function previews(program: Command): void {
  program
    .command('preview-up')
    .description('Build and push the PR image, and record a preview Deployment.')
    .argument('<pr>', 'PR number', parseNumber)
    .option('--dry-run', 'Print what would happen', false)
    .action(async (pr: number, opts: { dryRun: boolean }) => {
      console.log(await previewUp(pr, opts.dryRun))
    })

  program
    .command('preview-down')
    .description('Mark the preview deployment inactive and delete the PR image.')
    .argument('<pr>', 'PR number', parseNumber)
    .option('--dry-run', 'Print what would happen', false)
    .action((pr: number, opts: { dryRun: boolean }) => {
      previewDown(pr, opts.dryRun)
    })
}

// The two halves of shipping, kept apart on purpose. `production-up` proves
// the site is live; `ship` tells Jira. Running them as one command would make
// "the card says Done" and "the deployment answered" a single fallible step,
// and the ordering between them is the whole point.
function production(program: Command): void {
  program
    .command('production-up')
    .description('Build the merge commit, deploy it to production, and wait for it to answer.')
    .argument('<sha>', 'The merge commit on main')
    .option('--dry-run', 'Print what would happen', false)
    .action(async (sha: string, opts: { dryRun: boolean }) => {
      console.log(await productionUp(sha, opts.dryRun))
    })

  program
    .command('ship')
    .description('Move a merged card to Done and record where it went live.')
    .argument('<pr>', 'PR number', parseNumber)
    .requiredOption('--url <url>', 'The production URL now serving this card')
    .option('--dry-run', 'Print the comment without posting or transitioning', false)
    .action(async (pr: number, opts: { url: string; dryRun: boolean }) => {
      await ship({ pr, url: opts.url, dryRun: opts.dryRun })
    })
}

function kickoffCommand(program: Command): void {
  program
    .command('kickoff')
    .description('Post the first-turn comment on a build PR.')
    .argument('<pr>', 'PR number', parseNumber)
    .option('--dry-run', 'Print the comment without posting', false)
    .action((pr: number, opts: { dryRun: boolean }) => {
      kickoff(pr, opts.dryRun)
    })
}

function debugging(program: Command): void {
  program
    .command('emit-schema')
    .description('Regenerate .agent/result.schema.json from factory/src/schema.ts.')
    .action(() => {
      const path = resolve(REPO_ROOT, '.agent/result.schema.json')
      writeFileEnsuringDir(path, `${JSON.stringify(toJsonSchema(), null, 2)}\n`)
      console.log(path)
    })

  program
    .command('meta')
    .description('Print the current turn metadata (debugging aid).')
    .action(() => {
      console.log(JSON.stringify(readMeta(), null, 2))
    })
}
