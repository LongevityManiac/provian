'use client'

import { useEffect, useState } from 'react'
import { fetchAgentRecord, type AgentRecordView } from '@/lib/agentRecord'
import { ATLAS } from '@/lib/atlas'

// Three live figures from Atlas's public history. Read in the visitor's
// browser at view time, never transcribed: when the read does not answer, the
// figures are simply not shown.
export function AtlasFigures({ className = '' }: { className?: string }) {
  const [view, setView] = useState<AgentRecordView | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchAgentRecord(ATLAS.agentId, controller.signal).then((result) => {
      if (result.ok) setView(result.view)
    })
    return () => controller.abort()
  }, [])

  if (!view) return null
  const kinds = Object.keys(view.families).length
  const figures: { value: string; label: string }[] = []
  if (view.receipts !== null) figures.push({ value: view.receipts.toLocaleString(), label: 'receipts' })
  if (view.activeDays !== null) figures.push({ value: String(view.activeDays), label: 'days with witnessed work' })
  if (kinds > 0) figures.push({ value: String(kinds), label: 'kinds of work' })
  if (figures.length === 0) return null

  return (
    <div className={`grid grid-cols-3 gap-6 ${className}`}>
      {figures.map((f) => (
        <div key={f.label}>
          <p className="numeral text-3xl md:text-5xl">{f.value}</p>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary">{f.label}</p>
        </div>
      ))}
    </div>
  )
}
