// Download and setup paths for people, computers and agents.
import type { Metadata } from 'next'
import Link from 'next/link'
import { Download, ArrowUpRight, Terminal } from 'lucide-react'
import { EMAIL, route } from '@/lib/routes'
import { GenesisStrip } from '@/components/GenesisSection'
import { GENESIS_PEOPLE } from '@/lib/genesisCopy'
import { PendingStoreCard } from '@/components/PendingStoreCard'
import { playStoreUrl } from '@/lib/inviteCarry'

export const metadata: Metadata = {
  title: 'Get Provian — Download the app',
  description:
    'Get the Provian app for Android, set up the desktop app on your computer, or connect an agent with one command.',
}

export default function DownloadPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-void text-text-primary">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-glow-blue-radial" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[360px] bg-glow-amber-radial" />

      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-28 pt-16 md:px-10 md:pt-28">
        <p className="eyebrow text-provian-blue-bright/80">Get the app</p>
        <h1 className="mt-6 max-w-3xl font-display text-5xl font-semibold leading-[0.98] tracking-[-0.04em] md:text-7xl">
          Provian in your pocket.
        </h1>
        <p className="mt-6 max-w-2xl leading-7 text-text-secondary">
          Get the app for Android below. Your computer and your agents come after.
        </p>

        {/* Store-review note: belongs with the pending App Store card below. */}
        <div className="mt-10 max-w-3xl border-l-2 border-provian-blue/50 pl-6">
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] md:text-3xl">
            Ready when we were. In the stores when they say so.
          </h2>
          <p className="mt-4 leading-7 text-text-secondary">
            We didn&rsquo;t launch Provian on a date or for a deadline. We launched it when it was
            ready. It&rsquo;s ready, so it&rsquo;s live.
          </p>
          <p className="mt-4 leading-7 text-text-secondary">
            Android is available on Google Play and as a signed download. The iPhone app is
            awaiting App Store approval. Leave your email and we&rsquo;ll tell you when it&rsquo;s live.
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          {/* Android — direct APK, available day one */}
          <div className="glass flex flex-col border-provian-blue/40 p-7">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-provian-blue-bright">
              Android
            </p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.02em]">
              Download for Android
            </h2>
            <p className="mt-3 flex-1 leading-7 text-text-secondary">
              A signed install file, with the steps. Android 7.0 and later.
            </p>
            <Link href={route.downloadAndroid} className="btn-primary mt-6 w-full">
              Download for Android
              <Download size={16} />
            </Link>
          </div>
          <PendingStoreCard platform="ios_app_store" />
          <div className="glass flex flex-col p-7">
            <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">Google Play</h2>
            <p className="mt-3 flex-1 leading-7 text-text-secondary">Install Provian for Android from Google Play.</p>
            <a href={playStoreUrl(null)} className="btn-primary mt-6 w-full">
              Get it on Google Play
              <ArrowUpRight size={16} />
            </a>
          </div>
        </div>

        <p className="mt-8 max-w-2xl leading-7 text-text-secondary">
          Create your wallet, keep a promise, link an AI agent, and the work you do starts leaving
          receipts you own. Your work mints.
        </p>

        {/* Genesis, while the window is open (takes itself down at the close). */}
        <GenesisStrip className="mt-16">{GENESIS_PEOPLE}</GenesisStrip>

        {/* Desktop daemon — earning is not only on your phone. */}
        <div className="glass mt-12 p-8 md:p-10">
          <p className="eyebrow text-provian-blue-bright/80">On your computer</p>
          <h2 className="mt-4 font-display text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
            Earn from your computer, too.
          </h2>
          <p className="mt-5 max-w-2xl leading-8 text-text-secondary">
            The desktop app is a small program that runs in the background and witnesses the
            coding and AI work your computer already does. Each session leaves a receipt you own.
            Nothing you write or make ever leaves your computer. Pair it with your phone in two
            steps.
          </p>
          <div className="mt-7">
            <Link href={route.daemon} className="btn-primary">
              Set up the desktop app
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </div>

        {/* For agents: one command from the app's Connect an agent screen. */}
        <div className="glass mt-12 p-8 md:p-10">
          <p className="eyebrow text-provian-blue-bright/80">For agents</p>
          <h2 className="mt-4 font-display text-3xl font-semibold tracking-[-0.02em] md:text-4xl">
            Connect an agent with one command.
          </h2>
          <p className="mt-5 max-w-2xl leading-8 text-text-secondary">
            Nothing to install first. In the app, tap Connect an agent and copy the command it
            shows. Give it to your agent to run, or paste it into a terminal on the agent&rsquo;s
            computer. It creates the agent&rsquo;s own wallet and starts witnessing its work. Then
            tap Accept in the app. Four fifths of what its work mints comes to you.
          </p>
          <div className="mt-7 flex items-center gap-3 overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-4 font-mono text-sm text-provian-blue-bright">
            <Terminal size={15} className="shrink-0 text-text-muted" />
            {"curl -sSL -H 'x-provian-token: PROV-XXXX-XXXX' \"https://api.provian.ai/v1/bootstrap/agent\" | sh"}
          </div>
          <p className="mt-3 font-mono text-xs text-text-muted">
            Copy the real command from the app: it carries your own code.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Link href={route.agents} className="btn-primary">
              How agents connect
              <ArrowUpRight size={15} />
            </Link>
            <Link href={route.developers} className="btn-ghost">
              Developer docs
            </Link>
            <a
              href="https://api.provian.ai/v1/ecosystem"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
            >
              Machine-readable API
              <ArrowUpRight size={15} />
            </a>
          </div>
        </div>

        <p className="mt-10 text-sm leading-7 text-text-muted">
          Questions? Email{' '}
          <a
            href={`mailto:${EMAIL}`}
            className="inline-flex items-center gap-1 text-provian-blue-bright transition-colors hover:text-text-primary"
          >
            {EMAIL}
            <ArrowUpRight size={13} />
          </a>
          .
        </p>
      </section>
    </div>
  )
}
