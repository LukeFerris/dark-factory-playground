import { formatSize, isActive, type Deal } from '../crm/types'

export interface PipelineSummaryProps {
  deals: Deal[]
}

/** "<n> active deals · £<total>m in pipeline", where active means not Closed and not Passed. */
export function PipelineSummary({ deals }: PipelineSummaryProps) {
  const active = deals.filter(isActive)
  const total = active.reduce((sum, deal) => sum + (deal.size ?? 0), 0)
  return (
    <p className="summary">
      {active.length} active {active.length === 1 ? 'deal' : 'deals'} · {formatSize(total)} in
      pipeline
    </p>
  )
}
