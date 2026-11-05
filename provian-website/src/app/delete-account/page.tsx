import type { Metadata } from 'next'
import { PublicDocPage } from '@/components/PublicDocPage'

export const metadata: Metadata = {
  title: 'Delete your account | Provian',
  description: 'How to delete your Provian account and data, in the app or by email, and what is kept and why.',
}

export default function DeleteAccountPage() {
  return <PublicDocPage slug="delete-account" badge="Account" />
}
