'use client'

import { useState, type FormEvent } from 'react'
import { Bell, Check } from 'lucide-react'

// Compact email capture for a platform card on /download.
// Posts to the relay's public POST /v1/notify (routes/notify.ts), which stores
// the signup and sends an internal notification. One per platform card.
const NOTIFY_URL = 'https://api.provian.ai/v1/notify'

export function NotifyForm({
  platform,
  cta = "Notify me when it's ready",
  doneText = "You're on the list. We'll email you when it's ready.",
}: {
  platform: string
  cta?: string
  doneText?: string
}) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (state === 'submitting') return
    setState('submitting')
    setError(null)
    try {
      const res = await fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, platform }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Something went wrong. Please try again.')
      }
      setState('done')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
  }

  if (state === 'done') {
    return (
      <div className="mt-6 flex items-center gap-2 rounded-full border border-provian-blue/30 bg-provian-blue/5 px-4 py-3 text-sm text-provian-blue-bright">
        <Check size={15} className="shrink-0" />
        {doneText}
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-2">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        aria-label="Email address"
        className="w-full rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-provian-blue focus:outline-none"
      />
      <button
        type="submit"
        disabled={state === 'submitting'}
        className="btn-primary w-full justify-center disabled:opacity-60"
      >
        {state === 'submitting' ? 'Submitting…' : cta}
        {state !== 'submitting' && <Bell size={15} />}
      </button>
      {error && <p className="text-xs leading-5 text-provian-gold-bright">{error}</p>}
    </form>
  )
}
