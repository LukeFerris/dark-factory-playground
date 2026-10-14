import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The repository the factory works on: this file's own, unless
 * `FACTORY_REPO_ROOT` names another.
 *
 * The override is how a job that holds a token works on a card without running
 * the card's code. It checks out main and runs the factory from there, checks
 * the card branch out beside it, and points this at the card. Without it the
 * factory would have to run from the card's checkout, whose code a build agent
 * has been free to write and run. See ADR 0008.
 */
export const REPO_ROOT =
  process.env['FACTORY_REPO_ROOT'] !== undefined && process.env['FACTORY_REPO_ROOT'] !== ''
    ? resolve(process.env['FACTORY_REPO_ROOT'])
    : resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Reads .env if present, WITHOUT overriding anything already in the process
 * environment. In Actions the values arrive as real env vars and there is no
 * .env file; locally the file is the source. Same code path either way.
 */
export function loadDotEnv(root: string = REPO_ROOT): void {
  const file = resolve(root, '.env')
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in .env (local) or as a workflow secret/variable (CI).`,
    )
  }
  return value
}

export function optional(name: string, fallback = ''): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** The Actions run that is executing right now, for "where did this come from" links. */
export function runUrl(): string | null {
  const server = optional('GITHUB_SERVER_URL', 'https://github.com')
  const repo = optional('GITHUB_REPOSITORY')
  const id = optional('GITHUB_RUN_ID')
  if (repo === '' || id === '') return null
  return `${server}/${repo}/actions/runs/${id}`
}

/**
 * The URL of a pull request by number, in the repository this is running in.
 *
 * Built from the environment rather than passed down a chain of workflow step
 * outputs: `meta.json` already knows the number, and a step output only exists
 * if the step that would have produced it ran. `report` runs on `always()`,
 * precisely when `publish` may not have.
 */
export function prUrl(number: number | null): string | null {
  if (number === null) return null
  const server = optional('GITHUB_SERVER_URL', 'https://github.com')
  const repo = optional('GITHUB_REPOSITORY')
  if (repo === '') return null
  return `${server}/${repo}/pull/${number}`
}
