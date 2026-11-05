import type { ReactNode } from 'react'
import { NotifyForm } from '@/components/NotifyForm'

export function PendingStoreCard({
  platform,
  className = 'glass flex flex-col p-7',
  children,
}: {
  platform: 'ios_app_store' | 'google_play'
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={className}>
      <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
        {children ?? (platform === 'ios_app_store' ? 'iPhone · App Store' : 'Google Play')}
      </h2>
      <p className="mt-3 text-sm text-text-secondary">Submitted · Pending review</p>
      <NotifyForm
        platform={platform}
        cta="Email me when it's live"
        doneText="You're on the list. We'll email you when it's live."
      />
    </div>
  )
}
