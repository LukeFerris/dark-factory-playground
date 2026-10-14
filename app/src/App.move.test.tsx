import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PipelineBoardProps } from './components/PipelineBoard'
import { App } from './App'

// The real board only offers moves for deals it is showing, so a move for an
// id the app no longer holds cannot be made through it. A stand-in board that
// asks for exactly that move covers the case.
vi.mock('./components/PipelineBoard', () => ({
  PipelineBoard: ({ onMove }: PipelineBoardProps) => (
    <button type="button" onClick={() => onMove('gone', 'Closed')}>
      Move a missing deal
    </button>
  ),
}))

describe('App moving a deal it no longer holds', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('announces nothing and leaves the pipeline as it was', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Move a missing deal' }))
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(screen.getByText('4 active deals · £210m in pipeline')).toBeInTheDocument()
  })
})
