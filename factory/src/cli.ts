import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { loadDotEnv } from './env.ts'
import * as jira from './jira.ts'
import { EXIT } from './cli-shared.ts'
import { registerCardCommands } from './cli-card.ts'
import { registerTurnCommands } from './cli-turn.ts'
import { registerDeliverCommands } from './cli-deliver.ts'

/**
 * The whole command tree, built fresh on each call. Commander keeps parsed
 * option values on the command itself, so a test that parses twice needs two
 * programs. The order of registration is the order `--help` lists them in.
 */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('factory')
    .description('The Dark Factory pipeline. Each subcommand is one workflow step.')
    .showHelpAfterError()
  registerCardCommands(program)
  registerTurnCommands(program)
  registerDeliverCommands(program)
  return program
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv)
  } catch (error) {
    if (error instanceof jira.JiraAuthError) {
      console.error(error.message)
      process.exit(EXIT.AUTH)
    }
    if (error instanceof jira.JiraTransitionError) {
      console.error(error.message)
      process.exit(EXIT.TRANSITION)
    }
    console.error((error as Error).message)
    process.exit(EXIT.ERROR)
  }
}

/**
 * Whether this file is the one Node was asked to run. Both `bin/factory.js`
 * and `npm run factory` hand it to tsx by path, so it is; a test importing it
 * for `buildProgram` is not, and must not have the CLI parse vitest's argv.
 * Real paths on both sides, so a symlinked checkout still counts.
 */
export function isEntryPoint(
  argv1: string | undefined = process.argv[1],
  self: string = fileURLToPath(import.meta.url),
): boolean {
  if (argv1 === undefined) return false
  try {
    return realpathSync(argv1) === realpathSync(self)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  loadDotEnv()
  await main()
}
