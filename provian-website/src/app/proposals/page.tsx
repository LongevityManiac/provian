// /proposals — the public earning-type registry.
//
// Renders GET api.provian.ai/v1/pe/earning-proposals client-side: every action
// type the network has seen, joined against the SERVED policy matrix and the
// rulings sidecar, with a status of live / building / queued / declined. This
// is the page a contributor consults to see whether a type earns, at what
// weight, and — for a type not yet ruled — when a ruling is due.
//
// There is NO submit form here: a witnessed envelope is the only way a type
// appears. A never-seen type is recorded with no mint and enters review on
// first sight; it earns from the day it is signed into the policy. This page
// reports the review state, it does not add to it.
//
// Static-export note: like /a and /p, this is a single client-rendered page —
// the projection is fetched at view time, never enumerated at build time. nginx
// on the backend and the site-wide auth wall here; public at flip.
import type { Metadata } from 'next'
import { ProposalsClient } from '@/components/ProposalsClient'

export const metadata: Metadata = {
  title: 'Kinds of work — Provian',
  description:
    'Every kind of work the Provian network has seen, what each one earns, which are being built, and which are in review, with the published turnaround for a ruling.',
}

export default function ProposalsPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-glow-blue-radial" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[320px] bg-glow-amber-radial" />
      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-28 md:px-10">
        <ProposalsClient />
      </section>
    </div>
  )
}
