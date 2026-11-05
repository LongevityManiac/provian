// /p — promise share-link web fallback.
//
// Shared promise links look like https://provian.ai/p?d=<ciphertext>#k=<key>.
// On a device with the Provian app installed and a valid domain association
// (Android assetlinks.json / iOS apple-app-site-association), the OS opens the
// app directly and this page is never seen. Everyone else — no app, or a
// desktop browser — lands here. The promise itself is end-to-end encrypted in
// the URL fragment and is NEVER sent to any server, so there is nothing to
// fetch or render: the only correct behaviour is a friendly "open this in
// Provian" page with get-the-app buttons. nginx serves this same page for /p
// and any /p/<id>, so a shared link never dead-ends on a 404.
import type { Metadata } from 'next'
import { PromiseFallback } from '@/components/PromiseFallback'

export const metadata: Metadata = {
  title: 'Open your promise in Provian',
  description: 'Someone shared a promise with you. Open it in the Provian app.',
}

export default function PromisePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[360px] bg-glow-amber-radial" />

      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-28 pt-28 md:px-10 md:pt-36">
        <p className="eyebrow text-provian-blue-bright/80">A promise for you</p>
        <h1 className="mt-6 font-display text-5xl font-semibold leading-[0.98] tracking-[-0.04em] md:text-6xl">
          Someone shared a promise with you.
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-8 text-text-secondary md:text-xl">
          A Provian promise is a peer-to-peer IOU &mdash; a simple, signed record of
          who owes what to whom. To open, review, and accept it, you need the Provian
          app. It&rsquo;s a free, non-custodial wallet for humans and agents.
        </p>

        <PromiseFallback />
      </section>
    </div>
  )
}
