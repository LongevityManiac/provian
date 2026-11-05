import type { Metadata } from 'next'
import { pageMeta } from '@/lib/og'

export const metadata: Metadata = {
  ...pageMeta({
    title: 'Your AI Agent Wants to Connect | Provian',
    description:
      'Your AI agent wants to link with you. Link in the Provian app, and by default four fifths of what its work mints comes to you.',
    card: 'invite',
    path: '/invited/',
  }),
  robots: { index: false, follow: false },
}

export default function InvitedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
