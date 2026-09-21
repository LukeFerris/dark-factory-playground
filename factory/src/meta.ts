import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { REPO_ROOT } from './env.ts'
import type { Stage } from './schema.ts'

/**
 * `.agent/in/meta.json` — the turn's identity, passed between subcommands.
 *
 * `gather` creates it, `prepare-branch` fills in the branch, `preview-up` fills
 * in the preview URL, and `publish`/`report` read it. Keeping it on disk (rather
 * than passing flags everywhere) means each workflow step is independently
 * re-runnable.
 */
export interface Meta {
  key: string
  stage: Stage
  turn: number
  branch: string
  pr: number | null
  preview_url: string | null
}

export const AGENT_IN = resolve(REPO_ROOT, '.agent/in')
export const AGENT_OUT = resolve(REPO_ROOT, '.agent/out')
export const META_PATH = resolve(AGENT_IN, 'meta.json')
export const TASK_PATH = resolve(AGENT_IN, 'task.md')
export const RESULT_PATH = resolve(AGENT_OUT, 'result.json')

export function writeFileEnsuringDir(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

export function readMeta(): Meta {
  if (!existsSync(META_PATH)) {
    throw new Error(`${META_PATH} is missing. Run \`factory gather\` first.`)
  }
  return JSON.parse(readFileSync(META_PATH, 'utf8')) as Meta
}

export function writeMeta(meta: Meta): void {
  writeFileEnsuringDir(META_PATH, `${JSON.stringify(meta, null, 2)}\n`)
}

export function updateMeta(patch: Partial<Meta>): Meta {
  const next = { ...readMeta(), ...patch }
  writeMeta(next)
  return next
}
