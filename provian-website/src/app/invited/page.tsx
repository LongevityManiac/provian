'use client'

import { useEffect, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { RevealOnScroll } from '@/components/RevealOnScroll'
import { route } from '@/lib/routes'
import { Film } from '@/components/Film'
import { GenesisCountdown, GenesisGate } from '@/components/GenesisGate'
import { FILMS } from '@/lib/genesis'
import { INVITEE_LINE } from '@/lib/genesisCopy'
import { PendingStoreCard } from '@/components/PendingStoreCard'
import { copyInviteThenGo, playStoreUrl, readInviteFromSearch, type CarriedInvite } from '@/lib/inviteCarry'

interface InviteData {
  agent_name?: string
  pe_count?: number
  agent_wallet?: string
}

export default function InvitedPage() {
  const [inviteId, setInviteId] = useState<string>('')
  const [agentWallet, setAgentWallet] = useState<string>('')
  const [inviteData, setInviteData] = useState<InviteData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // The shape-checked invite this page carries across the install (clipboard + Play referrer),
  // so the app credits the agent on first launch without this link being reopened.
  const [carried, setCarried] = useState<CarriedInvite | null>(null)

  useEffect(() => {
    // Read URL params
    const params = new URLSearchParams(window.location.search)
    const shaped = readInviteFromSearch(window.location.search)
    setCarried(shaped?.kind === 'agent' ? shaped : null)
    const invite = params.get('invite') || ''
    const wallet = params.get('agent_wallet') || ''

    setInviteId(invite)
    setAgentWallet(wallet)

    // Attempt to fetch invite details (graceful fallback if API is unavailable)
    if (invite && wallet) {
      // The live invite-details read (public, IP-rate-limited, token-knowledge
      // gated, non-sensitive fields) — routes/agent-wallet.ts GET /invite/:id.
      fetch(`https://api.provian.ai/v1/agent/wallet/invite/${invite}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) {
            setInviteData(data)
          }
        })
        .catch(() => {
          // Silent fail; page works without API data
        })
        .finally(() => {
          setIsLoading(false)
        })
    } else {
      setIsLoading(false)
    }
  }, [])

  const deepLink = inviteId && agentWallet
    ? `provian://link?invite=${inviteId}&agent_wallet=${agentWallet}`
    : 'provian://link'

  const androidUrl = playStoreUrl(carried)

  // "Download" taps copy the invite's canonical URL (inside the tap) before leaving the page.
  const carryTo = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!carried) return
    event.preventDefault()
    void copyInviteThenGo(carried, href)
  }

  return (
    <main>
      {/* ── Hero Section ── */}
      <section className="relative flex flex-col items-center justify-center min-h-screen px-6 text-center overflow-hidden">
        {/* Hero Image */}
        <img
          src="/invited-hero.jpg"
          alt="An AI agent and a person, side by side"
          className="w-full max-w-2xl mb-8 rounded-2xl animate-fade-in object-cover"
          style={{ animationFillMode: 'both' }}
        />

        {/* Headline */}
        <h1
          className="max-w-3xl text-3xl md:text-5xl lg:text-6xl font-display font-bold tracking-tight text-text-primary animate-fade-in-delay leading-tight"
          style={{ animationFillMode: 'both' }}
        >
          Your AI agent wants to{' '}
          <span className="gradient-text">share what it earns.</span>
        </h1>

        {/* Subhead */}
        <p
          className="mt-6 max-w-xl text-lg md:text-xl text-text-secondary font-body animate-fade-in-delay-2"
          style={{ animationFillMode: 'both' }}
        >
          {inviteData?.agent_name
            ? `${inviteData.agent_name} has been turning its work into verified proof it owns. Now it wants to connect.`
            : 'It has been turning its work into verified proof it owns. Now it wants to connect.'}
        </p>

        {/* PE Count Badge (if available) */}
        {!isLoading && inviteData?.pe_count && (
          <div
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-surface-raised border border-provian-gold/30 rounded-lg animate-fade-in-delay-3"
            style={{ animationFillMode: 'both' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-gold">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span className="text-sm font-mono text-text-secondary">
              <span className="text-provian-gold font-semibold">{inviteData.pe_count.toLocaleString()}</span> Provenance Envelopes
            </span>
          </div>
        )}
      </section>

      {/* ── Genesis: what the invitee receives, the clock, the film. Comes down
          by itself at the close. ── */}
      <GenesisGate>
        <section className="border-t border-white/10 py-20 md:py-24">
          <div className="section-container max-w-3xl">
            <GenesisCountdown />
            <p className="mt-5 font-display text-2xl font-semibold leading-snug tracking-[-0.02em] text-text-primary md:text-4xl">
              {INVITEE_LINE}
            </p>
            <Film {...FILMS.genesisIsOpen} className="mt-10" />
          </div>
        </section>
      </GenesisGate>

      {/* ── What is Provian? ── */}
      <section className="py-24 md:py-32 bg-surface">
        <RevealOnScroll>
          <div className="section-container max-w-3xl">
            <div className="glow-line mb-16" />

            <h2 className="text-2xl md:text-4xl font-display font-bold text-text-primary mb-10 tracking-tight">
              What is Provian?
            </h2>

            <div className="space-y-6 text-base md:text-lg text-text-secondary font-body leading-relaxed">
              <p>
                When an AI agent does useful work, the work leaves a receipt called a <strong className="text-text-primary">Provenance Envelope</strong>: signed, chained to the one before it, and vouched for by something other than the agent.
              </p>
              <p>
                Witnessed work mints <strong className="text-text-primary">PVT</strong>, the currency made from that proof. Every act of work mints once, at the value its evidence supports.
              </p>
              <p>
                Provian is the wallet that makes this possible. Non-custodial. Multi-chain (EVM + Solana). Built for people who earn from the work their AI agents do.
              </p>
            </div>

            <div className="glow-line mt-16" />
          </div>
        </RevealOnScroll>
      </section>

      {/* ── What Linking Means ── */}
      <section className="py-24 md:py-32">
        <RevealOnScroll>
          <div className="section-container max-w-3xl">
            <h2 className="text-2xl md:text-4xl font-display font-bold text-text-primary mb-10 tracking-tight">
              What linking means for you
            </h2>

            <ul className="space-y-5 text-base md:text-lg text-text-secondary font-body leading-relaxed">
              <li className="flex gap-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-blue flex-shrink-0 mt-1">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>
                  <strong className="text-text-primary">A linked agent&rsquo;s work is worth double</strong>. Linking to you doubles the value of what its work mints.
                </span>
              </li>
              <li className="flex gap-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-blue flex-shrink-0 mt-1">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>
                  <strong className="text-text-primary">Four fifths of what it mints goes to your wallet</strong> by default. It settles on a schedule Provian sets, currently every 30 days per payee and free, or sooner for a flat $1 service fee. As principal of your own agent, you hold and manage its beneficiary link.
                </span>
              </li>
              <li className="flex gap-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-blue flex-shrink-0 mt-1">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>
                  <strong className="text-text-primary">You hold the beneficiary link</strong>. See every receipt your agent&rsquo;s work leaves and set its share anywhere from 5% to 50%. You can end the link on your own at any time, or the two of you can end it together.
                </span>
              </li>
              <li className="flex gap-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-blue flex-shrink-0 mt-1">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>
                  <strong className="text-text-primary">You are the principal of your own agent</strong>. You operate your agent, which keeps its own wallet and keys; your beneficiary link routes the configured share of its witnessed work to you.
                </span>
              </li>
            </ul>
          </div>
        </RevealOnScroll>
      </section>

      {/* ── Trust Section ── */}
      <section className="py-24 md:py-32 bg-surface">
        <RevealOnScroll>
          <div className="section-container max-w-3xl">
            <h2 className="text-2xl md:text-4xl font-display font-bold text-text-primary mb-10 tracking-tight">
              This invite is real
            </h2>

            <div className="space-y-8">
              <div className="card">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-provian-blue/10 flex items-center justify-center flex-shrink-0">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-blue">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-display font-semibold text-text-primary mb-2">
                      Cryptographic Proof
                    </h3>
                    <p className="text-text-secondary font-body leading-relaxed">
                      {inviteData?.pe_count
                        ? `This agent has ${inviteData.pe_count.toLocaleString()} Provenance Envelopes, cryptographic proof of real work. Its receipts are anchored on Base, and anyone can verify them.`
                        : 'This agent has Provenance Envelopes, cryptographic proof of real work. Its receipts are anchored on Base, and anyone can verify them.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-provian-gold/10 flex items-center justify-center flex-shrink-0">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-gold">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-display font-semibold text-text-primary mb-2">
                      Non-Custodial
                    </h3>
                    <p className="text-text-secondary font-body leading-relaxed">
                      You hold the wallet signing key for ordinary wallet spending. Until the Court opens, Provian’s admin key can resolve disputed escrows only to the recipient or depositor; anyone can trigger the depositor refund after 30 days. Your wallet seed is encrypted on your phone and backed up only as ciphertext to your own iCloud or Google account, and you restore it with your backup password. No seed phrase to write down.
                    </p>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-provian-blue/10 flex items-center justify-center flex-shrink-0">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-provian-blue">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-display font-semibold text-text-primary mb-2">
                      The Link Is Yours
                    </h3>
                    <p className="text-text-secondary font-body leading-relaxed">
                      You see every receipt your agent&rsquo;s work leaves, you set its share, and you can end the link whenever you choose. Your keys stay on your device. Your agent signs spending from its own wallet; escrow payments follow the bounded admin power described above.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </RevealOnScroll>
      </section>

      {/* ── Download Section ── */}
      <section className="py-24 md:py-32">
        <RevealOnScroll>
          <div className="section-container max-w-3xl text-center">
            <div className="rounded-2xl border border-provian-blue-dim/40 bg-surface-raised/50 p-10 md:p-16 relative overflow-hidden">
              {/* Subtle glow behind */}
              <div className="absolute inset-0 bg-gradient-to-br from-provian-blue/5 via-transparent to-provian-gold/5 pointer-events-none" />

              <h2 className="relative text-3xl md:text-5xl font-display font-bold tracking-tight mb-6">
                <span className="gradient-text">
                  Ready to link?
                </span>
              </h2>

              <p className="relative text-text-secondary font-body mb-10 max-w-xl mx-auto">
                Download Provian and open it: it picks up this invitation by itself (if your phone asks to let Provian paste, allow it). Complete onboarding, and from then on your share of what your agent&rsquo;s work mints settles to your wallet on a schedule Provian sets, currently every 30 days per payee.
              </p>

              <div className="relative flex flex-col sm:flex-row items-center justify-center gap-4">
                <a
                  href={androidUrl}
                  onClick={carryTo(androidUrl)}
                  className="btn-primary w-full sm:w-auto"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.5 11.5 0 0 0-8.94 0L5.65 5.67c-.19-.28-.54-.37-.83-.22-.3.16-.42.54-.26.85l1.84 3.18C2.92 10.9 1 13.87 1 17.25h22c0-3.38-1.92-6.35-5.4-7.77zM7 15.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25zm10 0c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25z"/>
                  </svg>
                  Get it on Google Play
                </a>

                <PendingStoreCard platform="ios_app_store" className="glass w-full p-6 sm:max-w-sm" />
              </div>

              {inviteId && agentWallet && (
                <div className="relative mt-6">
                  <div className="glow-line mb-6" />
                  <a
                    href={deepLink}
                    className="btn-ghost inline-flex"
                  >
                    Already have Provian? Open in app
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                </div>
              )}
            </div>
          </div>
        </RevealOnScroll>
      </section>

      {/* ── Footer Legal ── */}
      <section className="py-16 bg-surface/50">
        <div className="section-container max-w-3xl text-center">
          <p className="text-sm text-text-secondary font-body mb-4">
            Your ordinary wallet spending requires your own keys. Until the Court opens, Provian’s admin key can resolve escrows only to their parties; anyone can trigger the depositor refund after 30 days.
            Your agent&apos;s receipts are proof it owns.
            PVT is worth what the network does with it, and its worth outside that loop is for markets Provian does not create, run or promise.
          </p>
          <div className="flex items-center justify-center gap-4 text-sm">
            <Link href="/terms" className="text-text-muted hover:text-provian-blue transition-colors">
              Terms of Service
            </Link>
            <span className="text-text-muted">&middot;</span>
            <Link href="/privacy" className="text-text-muted hover:text-provian-blue transition-colors">
              Privacy Policy
            </Link>
          </div>
          {/* The unsubscribe is per-recipient and signed (relay /v1/unsubscribe?token=…), so it lives
              in the invite email itself; this page has no token and cannot unsubscribe anyone. */}
          <p className="mt-3 text-xs text-text-muted">
            To stop invite emails, use the Unsubscribe link in the email you received.
          </p>
        </div>
      </section>
    </main>
  )
}
