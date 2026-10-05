import { describe, expect, it } from 'vitest'
import {
  BUILD,
  DESIGN,
  FACTORY,
  HUMAN,
  NONE,
  always,
  run,
  stub,
  type Board,
} from './triage.stub.ts'
import { useFakes } from './jira.stub.ts'

useFakes()

function review(comments: Board['cards'][string]['comments']): Board {
  return { cards: { 'DF-3': { status: 'In review', comments } } }
}
const question = { id: '1', authorId: FACTORY, body: 'Ready for review.' }

/**
 * A card in review is the reviewer's, and comments on it are mostly between
 * people. Only a comment that @mentions the factory is for it.
 */
describe('comments on a card in review', () => {
  it('leaves a comment that does not mention the factory to the people', async () => {
    const seen = stub(review([question, { id: '2', authorId: HUMAN, body: 'Looks good to me' }]))
    const classify = always(BUILD)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
    expect(seen.transitions).toEqual([])
    expect(seen.marks).toEqual([])
  })

  it('takes the card back when a comment mentions the factory, for whoever wrote it', async () => {
    const seen = stub(
      review([
        question,
        { id: '2', authorId: HUMAN, body: ' the button is the wrong colour', mentions: [FACTORY] },
      ]),
    )

    const [outcome] = await run(always(BUILD))

    expect(outcome).toMatchObject({
      key: 'DF-3',
      status: 'In review',
      action: 'build',
      acted: true,
    })
    expect(seen.transitions).toEqual([{ key: 'DF-3', to: 'Building' }])
    expect(seen.assignments).toEqual([{ key: 'DF-3', accountId: FACTORY }])
    expect(seen.handBacks).toEqual([{ key: 'DF-3', previous: HUMAN }])
    expect(seen.marks.map((m) => m.value['commentId'])).toEqual(['2'])
  })
})

describe('comments on a card in review: which mention counts', () => {
  // A colleague's "+1" underneath must not hide the request above it.
  it('finds the mention under a later reply from someone else', async () => {
    const seen = stub(
      review([
        question,
        { id: '2', authorId: HUMAN, body: ' please centre the title', mentions: [FACTORY] },
        { id: '3', authorId: '557058:colleague', body: '+1' },
      ]),
    )

    const [outcome] = await run(always(DESIGN))

    expect(outcome).toMatchObject({ action: 'design', acted: true })
    expect(seen.handBacks).toEqual([{ key: 'DF-3', previous: HUMAN }])
    expect(seen.marks.map((m) => m.value['commentId'])).toEqual(['2'])
  })

  // That mention was answered by the turn that wrote the factory's comment.
  it('ignores a mention from before the factory last spoke', async () => {
    stub(
      review([
        { id: '1', authorId: HUMAN, body: ' please centre the title', mentions: [FACTORY] },
        { id: '2', authorId: FACTORY, body: 'Centred. Ready for review.' },
        { id: '3', authorId: HUMAN, body: 'thanks' },
      ]),
    )
    const classify = always(DESIGN)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
  })

  it('reads a mention once, however many replies follow it', async () => {
    const board = review([
      question,
      { id: '2', authorId: HUMAN, body: ' thanks!', mentions: [FACTORY] },
      { id: '3', authorId: '557058:colleague', body: 'agreed' },
    ])
    board.cards['DF-3']!.mark = '2'
    stub(board)
    const classify = always(NONE)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
  })

  it('ignores a mention of someone else', async () => {
    stub(
      review([
        question,
        { id: '2', authorId: HUMAN, body: ' can you check this', mentions: [HUMAN] },
      ]),
    )
    const classify = always(BUILD)

    expect(await run(classify)).toEqual([])
    expect(classify.calls).toBe(0)
  })
})
