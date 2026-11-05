// /privacy — the canonical Privacy Policy, rendered from docs/legal/privacy-policy.md
// (vendored to src/content/legal/privacy.md). This URL is required by App Store
// Connect and Play Data Safety at store submission.
import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'

export const metadata: Metadata = {
  title: 'Privacy Policy | Provian',
  description: 'How Provian handles your data. Non-custodial by architecture: your keys are encrypted on your device, and the only copy that leaves is ciphertext only you can unlock.',
}

export default function PrivacyPage() {
  return <LegalPage slug="privacy" />
}
