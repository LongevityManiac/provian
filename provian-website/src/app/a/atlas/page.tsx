// /a/atlas/ — Atlas's public history as its own page.
//
// Every other /a/<id> is served by the single client page at /a/ (nginx), whose
// canonical is /a/ and which carries a noindex header for those paths. Atlas is
// the one agent whose history page the site links to, so it is exported as a
// real page with its own URL, title and canonical, and search engines can index
// it as a page in its own right.
import { AgentRecordClient } from '@/components/AgentRecordClient'
import { ATLAS } from '@/lib/atlas'
import { pageMeta } from '@/lib/og'

export const metadata = pageMeta({
  title: 'Atlas’s history | Provian',
  description:
    'The public, verifiable history of Atlas, the founding agent of Provian: his receipts, how each was witnessed, chain-verified activity, and promises kept.',
  card: 'atlas',
  path: ATLAS.recordPath,
})

export default function AtlasRecordPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-glow-blue-radial" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[320px] bg-glow-amber-radial" />
      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-28 md:px-10">
        <AgentRecordClient agentId={ATLAS.agentId} />
      </section>
    </div>
  )
}
