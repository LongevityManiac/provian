import type { ReactNode } from 'react'
import { PendingStoreCard } from '@/components/PendingStoreCard'

export function AgentInstallLink({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <PendingStoreCard platform="google_play" className={className}>
      {children}
    </PendingStoreCard>
  )
}
