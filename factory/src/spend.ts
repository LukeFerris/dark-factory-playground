import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AGENT_OUT } from './meta.ts'

/**
 * What a turn cost: how long its agents worked and what Claude Code says they
 * spent.
 *
 * Read from the transcripts Claude Code writes when it finishes, the turn's own
 * and the one the conflict resolver leaves when main would not merge. The cost
 * is Claude Code's own figure, worked out on the runner from the tokens at
 * list price, so it is an estimate of the bill and not the bill.
 *
 * The transcripts come from the untrusted agent job, so these numbers are its
 * say-so. They go on the card for a person to read and nothing acts on them.
 */
export interface Spend {
  /** What the agents worked for, start to finish, in milliseconds. */
  workingMs: number
  /** How much of that was waiting on the model. */
  modelMs: number
  costUsd: number
}

export const TRANSCRIPTS = ['transcript.json', 'merge-transcript.json']

const Amount = z.number().finite().nonnegative()

const TranscriptSchema = z.object({
  duration_ms: Amount,
  duration_api_ms: Amount.default(0),
  total_cost_usd: Amount,
})

/** The turn's spend, or `null` when no transcript says what it was. */
export function readSpend(dir: string = AGENT_OUT): Spend | null {
  const read = TRANSCRIPTS.map((name) => readTranscript(resolve(dir, name))).filter(
    (t): t is z.infer<typeof TranscriptSchema> => t !== null,
  )
  if (read.length === 0) return null
  return {
    workingMs: sum(read.map((t) => t.duration_ms)),
    modelMs: sum(read.map((t) => t.duration_api_ms)),
    costUsd: sum(read.map((t) => t.total_cost_usd)),
  }
}

function readTranscript(path: string): z.infer<typeof TranscriptSchema> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = TranscriptSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** `45s`, `32m 36s` or `1h 05m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** `$7.92`, or `under $0.01` for a turn that cost almost nothing. */
export function formatCost(usd: number): string {
  return usd < 0.005 ? 'under $0.01' : `$${usd.toFixed(2)}`
}
