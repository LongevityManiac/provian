import type { Metadata } from 'next'
import { PublicDocPage } from '@/components/PublicDocPage'

export const metadata: Metadata = {
  title: 'Support | Provian',
  description: 'Get help with the Provian app, purchases, wallet recovery, reporting content, and deleting your account.',
}

export default function SupportPage() {
  return <PublicDocPage slug="support" badge="Support" />
}
