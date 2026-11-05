'use client'

import { useState } from 'react'
import { RevealOnScroll } from '@/components/RevealOnScroll'

export default function OrganizationsPage() {
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    const form = new FormData(event.currentTarget)
    const payload = {
      name: String(form.get('name') || ''),
      email: String(form.get('email') || ''),
      company: String(form.get('company') || ''),
      role: String(form.get('role') || ''),
      agentCount: String(form.get('agentCount') || ''),
    }

    try {
      const response = await fetch('https://api.provian.ai/v1/enterprise/pilot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Failed to submit inquiry')
      }

      setSubmitted(true)
      event.currentTarget.reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit inquiry')
      setSubmitted(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-void text-text-primary">
      <section id="pilot" className="py-24 md:py-32 bg-surface">
        <div className="section-container max-w-2xl">
          <RevealOnScroll>
            <div className="text-center mb-12">
              <p className="text-xs font-mono uppercase tracking-[0.25em] text-provian-blue mb-4">
                Deployment program
              </p>
              <h1 className="text-2xl md:text-4xl font-display font-bold text-text-primary tracking-tight mb-4">
                Put a provenance layer under your AI work.
              </h1>
              <p className="text-text-secondary text-base md:text-lg leading-relaxed">
                If you are working out how to make AI systems accountable as they
                take on more real work, we would love to talk. Every act of AI work can
                leave a receipt: signed, chained to the one before it, graded by what
                witnessed it, and carrying fingerprints of what was produced, never the
                private content. Receipts for consequential action, not surveillance.
              </p>
            </div>
          </RevealOnScroll>

          <RevealOnScroll delay={100}>
            <form onSubmit={handleSubmit} className="card space-y-5">
              <div className="grid gap-5 md:grid-cols-2">
                <label className="block">
                  <span className="block text-sm text-text-secondary mb-2">Name</span>
                  <input
                    name="name"
                    type="text"
                    required
                    className="w-full rounded-lg border border-surface-highlight bg-void px-4 py-3 text-text-primary placeholder:text-text-muted focus:border-provian-blue focus:outline-none"
                    placeholder="Jane Smith"
                  />
                </label>

                <label className="block">
                  <span className="block text-sm text-text-secondary mb-2">Email</span>
                  <input
                    name="email"
                    type="email"
                    required
                    className="w-full rounded-lg border border-surface-highlight bg-void px-4 py-3 text-text-primary placeholder:text-text-muted focus:border-provian-blue focus:outline-none"
                    placeholder="jane@company.com"
                  />
                </label>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <label className="block">
                  <span className="block text-sm text-text-secondary mb-2">Organization</span>
                  <input
                    name="company"
                    type="text"
                    required
                    className="w-full rounded-lg border border-surface-highlight bg-void px-4 py-3 text-text-primary placeholder:text-text-muted focus:border-provian-blue focus:outline-none"
                    placeholder="Acme"
                  />
                </label>

                <label className="block">
                  <span className="block text-sm text-text-secondary mb-2">Role</span>
                  <input
                    name="role"
                    type="text"
                    required
                    className="w-full rounded-lg border border-surface-highlight bg-void px-4 py-3 text-text-primary placeholder:text-text-muted focus:border-provian-blue focus:outline-none"
                    placeholder="Head of AI"
                  />
                </label>
              </div>

              <label className="block">
                <span className="block text-sm text-text-secondary mb-2">
                  Where do you want provenance for AI work? <span className="text-text-muted">(optional)</span>
                </span>
                <input
                  name="agentCount"
                  type="text"
                  className="w-full rounded-lg border border-surface-highlight bg-void px-4 py-3 text-text-primary placeholder:text-text-muted focus:border-provian-blue focus:outline-none"
                  placeholder="e.g. coding agents, data pipelines, customer workflows"
                />
              </label>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-2">
                <button type="submit" disabled={submitting} className="btn-primary justify-center sm:justify-start disabled:opacity-60 disabled:cursor-not-allowed">
                  {submitting ? 'Submitting…' : 'Start the conversation'}
                </button>
                {submitted && (
                  <p className="text-sm text-provian-blue">
                    Thanks. We captured your inquiry and notified the Provian team.
                  </p>
                )}
                {error && (
                  <p className="text-sm text-red-400">
                    {error}
                  </p>
                )}
              </div>
            </form>
          </RevealOnScroll>
        </div>
      </section>
    </div>
  )
}
