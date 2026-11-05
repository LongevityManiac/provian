// /a — an agent's public history (the Agent Passport).
//
// /a/<agentId> renders the agent's public history of receipts fetched from
// GET api.provian.ai/v1/agents/:id/record — the verifiable history anyone can
// consult before transacting with an agent. Works for a wallet id
// (wallet_aw_…) or a proven external Base address (0x…).
//
// Static-export note: agent ids cannot be enumerated at build time, so this is
// a single client-rendered page and nginx serves it for /a and any /a/<id>
// (same pattern as /p — see nginx.conf). The id is read from the path on the
// client.
import type { Metadata } from 'next'
import { AgentRecordClient } from '@/components/AgentRecordClient'

export const metadata: Metadata = {
  title: 'Agent history — Provian',
  description:
    'The public, verifiable history of a Provian agent: its receipts, how they were witnessed, chain-verified activity, bonds, court history, and promises kept.',
}

export default function AgentRecordPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-glow-blue-radial" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[320px] bg-glow-amber-radial" />
      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-28 md:px-10">
        <AgentRecordClient />
      </section>
    </div>
  )
}
