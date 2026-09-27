import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { REPO_ROOT } from './env.ts'
import { AGENT_IN, AGENT_OUT, META_PATH, RESULT_PATH, TASK_PATH } from './meta.ts'

/**
 * The suite runs inside a checkout that may be mid-turn.
 *
 * A build agent is allowed `npm test`, and it runs in the same working copy as
 * the turn it belongs to. Tests that drive the real `gather` write the real
 * `meta.json`; `publish` then reads a card key out of a fixture and asks Jira
 * for an issue from somebody's test data. DF-7's first build turn failed that
 * way — `publish` and `report` both 404'd on DF-1 — and nothing failed at the
 * moment of corruption, because overwriting a file is not an error.
 *
 * So this is not a test of `meta.ts`. It is a test that the guard in
 * `vitest.setup.ts` is still wired up, which the rest of the suite quietly
 * depends on and which a tidy-up of a config file could remove without
 * anything else going red.
 */
describe('where the suite is allowed to write', () => {
  it('keeps the turn’s scratch directory out of the repository', () => {
    const real = resolve(REPO_ROOT, '.agent')

    for (const path of [AGENT_IN, AGENT_OUT, META_PATH, TASK_PATH, RESULT_PATH]) {
      expect(path.startsWith(real)).toBe(false)
    }
  })

  it('still puts them all under one directory', () => {
    expect(META_PATH).toBe(resolve(AGENT_IN, 'meta.json'))
    expect(TASK_PATH).toBe(resolve(AGENT_IN, 'task.md'))
    expect(RESULT_PATH).toBe(resolve(AGENT_OUT, 'result.json'))
  })
})
