import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatCost, formatDuration, readSpend } from './spend.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spend-'))
})

function transcript(name: string, body: unknown): void {
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
}

describe('readSpend', () => {
  it("reads the turn's transcript", () => {
    transcript('transcript.json', {
      duration_ms: 1955386,
      duration_api_ms: 656087,
      total_cost_usd: 7.92,
      num_turns: 181,
    })
    expect(readSpend(dir)).toEqual({ workingMs: 1955386, modelMs: 656087, costUsd: 7.92 })
  })

  it('adds the conflict resolver to the turn', () => {
    transcript('transcript.json', { duration_ms: 1000, duration_api_ms: 400, total_cost_usd: 1.5 })
    transcript('merge-transcript.json', {
      duration_ms: 500,
      duration_api_ms: 100,
      total_cost_usd: 0.25,
    })
    expect(readSpend(dir)).toEqual({ workingMs: 1500, modelMs: 500, costUsd: 1.75 })
  })

  it('says nothing when there is no transcript', () => {
    expect(readSpend(dir)).toBeNull()
  })

  it('leaves out a transcript that is not what Claude Code writes', () => {
    transcript('transcript.json', '{"duration_ms": 10')
    transcript('merge-transcript.json', { duration_ms: -1, total_cost_usd: 1 })
    expect(readSpend(dir)).toBeNull()
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45_400, '45s'],
    [1955386, '32m 35s'],
    [3_900_000, '1h 05m'],
  ])('%i ms reads as %s', (ms, shown) => {
    expect(formatDuration(ms)).toBe(shown)
  })
})

describe('formatCost', () => {
  it('rounds to the cent', () => {
    expect(formatCost(7.9184)).toBe('$7.92')
  })

  it('does not call a turn free', () => {
    expect(formatCost(0.001)).toBe('under $0.01')
  })
})
