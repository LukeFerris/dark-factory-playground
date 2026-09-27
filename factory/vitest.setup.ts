import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point the turn's scratch directory somewhere disposable, before anything
 * imports `meta.ts` and resolves it.
 *
 * A build agent may run `npm test` inside the very checkout its turn is using.
 * Any test that calls the real `gather` then writes the real
 * `.agent/in/meta.json`, and the `publish` step afterwards reads a card key out
 * of a test fixture — which is how a DF-7 turn came to ask Jira for DF-1 and
 * get a 404. Individual tests tidying up after themselves is not enough: it
 * relies on every future test remembering, and it still leaves a window while
 * the suite is mid-run.
 *
 * This runs before each test file's imports, so `AGENT_IN`/`AGENT_OUT` are
 * resolved to the temp directory and the repository's own `.agent` is simply
 * unreachable from the suite.
 */
const dir = mkdtempSync(join(tmpdir(), 'factory-agent-'))
process.env['FACTORY_AGENT_DIR'] = dir

// Per worker, not per file — vitest reuses a worker across files, and the
// teardown is only about not filling /tmp up.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
