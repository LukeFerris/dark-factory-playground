import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from './env.ts'
import { ResultSchema } from './schema.ts'
import { AGENT_IN, AGENT_OUT, writeFileEnsuringDir } from './meta.ts'
import {
  MERGE_RESULT_PATH,
  MERGE_STATE_PATH,
  MERGE_TASK_PATH,
  conflictBrief,
  finishMerge,
  mergeQuestionResult,
  readMergeResult,
  type MergeResult,
  type MergeState,
} from './merge.ts'

/**
 * The parts of the merge that do not touch git.
 *
 * `attemptMerge` and the committing half of `finishMerge` drive a real
 * repository and are not tested here — they are covered by running the thing.
 * What is tested is everything that decides what a human ends up reading: the
 * brief the resolving agent is given, how a missing or malformed answer from it
 * is interpreted, and the card comment that comes out the other end.
 */

const state = (over: Partial<MergeState> = {}): MergeState => ({
  branch: 'card/DF-5-add-a-greeting',
  state: 'conflicted',
  behind: 3,
  conflicts: ['app/src/index.css'],
  denied: [],
  before: '1111111111111111111111111111111111111111',
  main: '2222222222222222222222222222222222222222',
  incoming: ['abc1234 DF-7: paint it blue'],
  ...over,
})

afterEach(() => {
  rmSync(MERGE_RESULT_PATH, { force: true })
})

describe('the brief the resolving agent is given', () => {
  it('names the card, the files and the two sides to compare', () => {
    const brief = conflictBrief(state(), 'DF-5', 'Add a greeting')

    expect(brief).toContain('card/DF-5-add-a-greeting')
    expect(brief).toContain('DF-5 — Add a greeting')
    expect(brief).toContain('Behind main by 3 commit(s).')
    expect(brief).toContain('abc1234 DF-7: paint it blue')
    expect(brief).toContain('`app/src/index.css`')
    // Short shas, because the agent has to type them into `git show`.
    expect(brief).toContain('git show 111111111111:<path>')
    expect(brief).toContain('git show 222222222222:<path>')
  })

  it('says so rather than showing an empty list when main only brought merges', () => {
    expect(conflictBrief(state({ incoming: [] }), 'DF-5', 'Add a greeting')).toContain(
      '_(merges only)_',
    )
  })

  it('tells the agent the rest of the tree is not its business', () => {
    expect(conflictBrief(state(), 'DF-5', 'Add a greeting')).toContain(
      'Nothing else in the tree is yours to change.',
    )
  })
})

describe('reading what the agent wrote back', () => {
  const write = (body: string): void => writeFileEnsuringDir(MERGE_RESULT_PATH, body)

  it('takes a well-formed answer at face value', () => {
    write(
      JSON.stringify({
        status: 'resolved',
        summary: 'Kept main’s blue and re-applied the greeting on top.',
        notes: ['index.css: took main’s background, kept this branch’s heading rule'],
      }),
    )

    const result = readMergeResult()
    expect(result.status).toBe('resolved')
    expect(result.notes).toHaveLength(1)
    // Absent optional fields default rather than throwing.
    expect(result.questions).toEqual([])
  })

  // The three ways of not answering. All of them mean the same thing, and
  // reading any of them as "resolved" would commit a tree with markers in it.
  it('treats a missing file as unresolved', () => {
    const result = readMergeResult()
    expect(result.status).toBe('unresolved')
    expect(result.summary).toContain('did not write')
  })

  it('treats unparseable JSON as unresolved, and says what was wrong with it', () => {
    write('{ this is not json')
    const result = readMergeResult()
    expect(result.status).toBe('unresolved')
    expect(result.summary).toContain('not valid JSON')
  })

  it('treats a shape that misses the contract as unresolved, naming the field', () => {
    write(JSON.stringify({ status: 'sort of', summary: 'I had a go' }))
    const result = readMergeResult()
    expect(result.status).toBe('unresolved')
    expect(result.summary).toContain('does not match the contract')
    expect(result.summary).toContain('status')
  })
})

describe('finishing a merge the agent gave up on', () => {
  const gaveUp = (summary: string): MergeResult => ({
    status: 'unresolved',
    summary,
    notes: [],
    questions: [],
  })

  it('does not commit, and carries the agent’s reason through', () => {
    const outcome = finishMerge(state(), gaveUp('Main sets the background blue; this branch pink.'))

    expect(outcome.ok).toBe(false)
    expect(outcome.sha).toBeNull()
    expect(outcome.problems).toEqual(['Main sets the background blue; this branch pink.'])
  })

  it('still has something to say when the agent gave no reason', () => {
    const outcome = finishMerge(state(), gaveUp('   '))

    expect(outcome.ok).toBe(false)
    expect(outcome.problems[0]).toContain('could not decide')
  })
})

describe('the card comment a stuck merge turns into', () => {
  it('is a result the rest of the pipeline can already handle', () => {
    const result = mergeQuestionResult(state(), ['the agent could not decide'], null)

    // `report --stage build` reads this file and maps `question` to Blocked on
    // engineer. If it stopped parsing, the merge flow would fail silently at the
    // one step whose entire job is not to.
    expect(() => ResultSchema.parse(result)).not.toThrow()
    expect(result.status).toBe('question')
  })

  it('asks about the specific conflict when the agent did not ask anything', () => {
    const result = mergeQuestionResult(state(), ['it could not decide'], null)

    expect(result.questions).toHaveLength(1)
    expect(result.questions[0]?.question).toContain('app/src/index.css')
    expect(result.questions[0]?.context).toBe('it could not decide')
  })

  it('prefers the agent’s own questions, which are about the actual choice', () => {
    const result = mergeQuestionResult(state(), ['it could not decide'], {
      status: 'unresolved',
      summary: 'Two different backgrounds.',
      notes: ['both sides rewrote the same rule'],
      questions: [
        {
          question: 'Should the background stay blue, as main has it, or become pink?',
          context: 'DF-7 shipped blue; this card asks for pink.',
          options: ['Keep blue', 'Change to pink'],
        },
      ],
    })

    expect(result.questions).toHaveLength(1)
    expect(result.questions[0]?.options).toEqual(['Keep blue', 'Change to pink'])
    // Whatever the agent did work out still reaches the card.
    expect(result.assumptions).toEqual(['both sides rewrote the same rule'])
  })

  it('reassures the reader that nothing was left half-merged', () => {
    const result = mergeQuestionResult(state(), ['it could not decide'], null)

    expect(result.context).toContain('the branch is exactly as it was')
    expect(result.context).toContain('3 commit(s) ahead')
  })

  // A conflict in factory/ never reaches an agent, so the comment must not
  // imply one tried and failed — it asks for a person on the branch instead.
  it('says plainly that a machinery conflict needs a person', () => {
    const result = mergeQuestionResult(
      state({ state: 'refused', conflicts: ['factory/src/validate.ts'], denied: ['factory/src/validate.ts'] }),
      ['The conflict is in factory/src/validate.ts.'],
      null,
    )

    expect(result.summary).toContain('factory/src/validate.ts')
    expect(result.summary).toContain('no agent may edit')
    expect(result.summary).toContain('needs a person on the branch')
  })
})

describe('the scratch files the merge writes', () => {
  // Belt and braces with meta.test.ts. The resolving agent runs in a real
  // checkout, and .gitignore covers `.agent/in/` and `.agent/out/` but not a
  // stray `.agent/merge.json` — so a path that drifted out of those two
  // directories would start getting committed with nothing going red.
  it('all sit under the turn’s scratch directory, not in the repository', () => {
    const scratch = resolve(REPO_ROOT, '.agent')

    for (const path of [MERGE_STATE_PATH, MERGE_TASK_PATH, MERGE_RESULT_PATH]) {
      expect(path.startsWith(scratch)).toBe(false)
      expect(path.startsWith(AGENT_IN) || path.startsWith(AGENT_OUT)).toBe(true)
    }
  })
})
