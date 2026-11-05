// /terms — the canonical Terms of Service, rendered from docs/legal/terms-of-service.md
// (vendored to src/content/legal/terms.md). Store submission links this URL.
import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'

export const metadata: Metadata = {
  title: 'Terms of Service | Provian',
  description: 'The terms that govern your use of Provian: a non-custodial wallet, peer-to-peer promises, an agent witness, and a provenance engine.',
}

export default function TermsPage() {
  return <LegalPage slug="terms" />
}
