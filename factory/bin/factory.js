#!/usr/bin/env node
// Thin launcher so `npx factory …` works from anywhere in the repo.
// The CLI itself is TypeScript, run through tsx.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, '../src/cli.ts')
const tsx = resolve(here, '../../node_modules/.bin/tsx')

const result = spawnSync(tsx, [cli, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
