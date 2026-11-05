'use client'

// Client half of /proposals — fetches and renders the public earning-type
// projection from GET api.provian.ai/v1/pe/earning-proposals.
//
// The projection JOINS three server-side sources — the SERVED policy matrix, the
// pending-policy queue, and the rulings sidecar — into one status per action
// type: live / building / queued / declined. There is deliberately NO
// "accepted" state: a named type earns on a signed matrix row whose activation
// digest matches the served code, never on a hand edit.
//
// Every field is optional and rendered defensively so the page works with
// whatever subset the relay returns.

import { useEffect, useMemo, useState } from 'react'

const API_BASE = 'https://api.provian.ai'

// ── Contract types (backend: earning-type-projection.ts; all optional) ─────
type EarningTypeStatus = 'live' | 'building' | 'queued' | 'declined'

interface EarningTypeView {
  action_type?: string
  status?: EarningTypeStatus
  mint_disposition?: string
  weight_bps?: number
  effective_at_ms?: number | null
  reason_code?: string | null
  canonical_type?: string | null
  issue_url?: string | null
  first_seen_at?: number
  last_seen_at?: number
  observation_count?: number
  age_ms?: number
  review_deadline_ms?: number
  past_review_promise?: boolean
  [k: string]: unknown
}

interface EarningTypeProjection {
  generated_at_ms?: number
  review_promise?: string
  footer?: {
    template_digest?: string
    digest_match?: boolean
    matrix_policy_version?: string
    matrix_entry_count?: number
    [k: string]: unknown
  }
  counts?: Partial<Record<EarningTypeStatus, number>>
  types?: EarningTypeView[]
  count?: number
  [k: string]: unknown
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; projection: EarningTypeProjection }
  | { phase: 'error'; message: string }

const STATUS_ORDER: readonly EarningTypeStatus[] = ['live', 'building', 'queued', 'declined']

const STATUS_META: Record<
  EarningTypeStatus,
  { label: string; chip: string; blurb: string }
> = {
  live: {
    label: 'Live · earning',
    chip: 'border-provian-blue/40 bg-provian-blue/10 text-provian-blue',
    blurb: 'Named in the signed policy the network runs. This kind of work mints PVT from its go-live date.',
  },
  building: {
    label: 'Building',
    chip: 'border-provian-gold/40 bg-provian-gold/10 text-provian-gold',
    blurb: 'Approved and being built, or waiting for the next signed policy. Its named price applies from the go-live date, never before.',
  },
  queued: {
    label: 'In review',
    chip: 'border-white/15 bg-white/5 text-text-secondary',
    blurb: 'Seen on the network with no named price yet. Each envelope is recorded on the lane that witnessed it: a registered device, the network\'s own check, the chain, a forge, or attested hardware. An actor\'s own claim is never a receipt. It earns from the day it is signed into the policy; envelopes sealed before then stay records.',
  },
  declined: {
    label: 'No separate mint',
    chip: 'border-white/10 bg-surface text-text-muted',
    blurb: 'Proof that does not mint on its own: a burn or other PVT cost, a denial or no-op, a security or identity event, a signal whose value lands on the work it confirms, or an alias of another kind of work.',
  },
}

function formatWeight(bps: number | undefined): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return null
  // 10000 bps = 1.00× base action weight.
  return `${(bps / 10000).toFixed(2)}×`
}

function formatDate(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function daysUntil(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const diff = ms - Date.now()
  const days = Math.round(diff / 86_400_000)
  if (days < 0) return `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
  if (days === 0) return 'due today'
  return `due in ${days} day${days === 1 ? '' : 's'}`
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</span>
        <button
          type="button"
          className="font-mono text-xs text-provian-blue hover:text-provian-blue-bright"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded-lg border border-white/10 bg-surface p-3 text-xs leading-5 text-text-secondary">
        <code>{text}</code>
      </pre>
    </div>
  )
}

function StatusChip({ status }: { status: EarningTypeStatus }) {
  const meta = STATUS_META[status]
  return (
    <span
      className={`whitespace-nowrap rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider ${meta.chip}`}
    >
      {meta.label}
    </span>
  )
}

function TypeRow({ view }: { view: EarningTypeView }) {
  const status = (view.status && STATUS_META[view.status] ? view.status : 'queued') as EarningTypeStatus
  const weight = status === 'live' ? formatWeight(view.weight_bps) : null
  const effective = status === 'live' ? formatDate(view.effective_at_ms ?? undefined) : null
  const deadline = status === 'queued' ? daysUntil(view.review_deadline_ms) : null

  return (
    <li className="glass rounded-xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <code className="break-all font-mono text-sm text-text-primary">
            {view.action_type || 'unknown'}
          </code>
          {view.canonical_type && (
            <div className="mt-1 font-mono text-xs text-text-muted">
              alias of <span className="text-text-secondary">{view.canonical_type}</span>
            </div>
          )}
        </div>
        <StatusChip status={status} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-muted">
        {weight && (
          <span>
            weight <span className="text-text-secondary">{weight}</span>
          </span>
        )}
        {effective && (
          <span>
            live since <span className="text-text-secondary">{effective}</span>
          </span>
        )}
        {deadline && (
          <span className={view.past_review_promise ? 'text-provian-gold' : undefined}>
            ruling <span className="text-text-secondary">{deadline}</span>
          </span>
        )}
        {view.reason_code && (
          <span>
            reason <span className="text-text-secondary">{view.reason_code}</span>
          </span>
        )}
        {typeof view.observation_count === 'number' && view.observation_count > 0 && (
          <span>
            seen <span className="text-text-secondary">{view.observation_count}×</span>
          </span>
        )}
      </div>

      {view.issue_url && (
        <a
          href={view.issue_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block font-mono text-xs text-provian-blue hover:text-provian-blue-bright"
        >
          follow the build →
        </a>
      )}
    </li>
  )
}

const FILTERS: readonly { key: 'all' | EarningTypeStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'building', label: 'Building' },
  { key: 'queued', label: 'In review' },
  { key: 'declined', label: 'No separate mint' },
]

export function ProposalsClient() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [filter, setFilter] = useState<'all' | EarningTypeStatus>('all')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/v1/pe/earning-proposals`)
        if (cancelled) return
        if (!res.ok) {
          setState({ phase: 'error', message: `Provian answered HTTP ${res.status}. Try again shortly.` })
          return
        }
        setState({ phase: 'ready', projection: (await res.json()) as EarningTypeProjection })
      } catch {
        if (!cancelled) {
          setState({ phase: 'error', message: 'Could not reach Provian. Try again shortly.' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const header = (
    <>
      <p className="eyebrow text-provian-blue-bright/80">Kinds of work</p>
      <h1 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-5xl">
        What earns, what&rsquo;s building, what&rsquo;s in review.
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
        New kinds of work need no permission. When a witness first sees one, it is recorded and goes
        into review for a named price, with no form to file; it earns from the day that price is signed.
        This page shows every kind of work the network has seen and where it stands: named and live,
        being built, in review, or proof that does not mint on its own.
      </p>
    </>
  )

  const counts = state.phase === 'ready' ? state.projection.counts ?? {} : {}
  const types = state.phase === 'ready' ? state.projection.types ?? [] : []
  const footer = state.phase === 'ready' ? state.projection.footer : undefined
  const reviewPromise = state.phase === 'ready' ? state.projection.review_promise : undefined

  const shown = useMemo(
    () => (filter === 'all' ? types : types.filter((t) => t.status === filter)),
    [types, filter],
  )

  if (state.phase === 'loading') {
    return (
      <div>
        {header}
        <p className="mt-8 font-mono text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div>
        {header}
        <p className="mt-8 max-w-2xl text-lg leading-8 text-text-secondary">{state.message}</p>
        <CopyBlock label="API" text={`curl ${API_BASE}/v1/pe/earning-proposals`} />
      </div>
    )
  }

  return (
    <div>
      {header}

      {reviewPromise && (
        <div className="glass mt-8 rounded-xl border-l-2 border-provian-gold/40 p-5">
          <div className="font-mono text-xs uppercase tracking-wider text-provian-gold">Review turnaround</div>
          <p className="mt-2 leading-7 text-text-secondary">{reviewPromise}</p>
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const n = f.key === 'all' ? types.length : counts[f.key] ?? 0
          const active = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-4 py-1.5 font-mono text-xs uppercase tracking-wider transition ${
                active
                  ? 'border-provian-blue/50 bg-provian-blue/10 text-provian-blue'
                  : 'border-white/10 bg-surface text-text-muted hover:text-text-secondary'
              }`}
            >
              {f.label} <span className="ml-1 text-text-muted">{n}</span>
            </button>
          )
        })}
      </div>

      {filter !== 'all' && (
        <p className="mt-4 text-sm leading-6 text-text-muted">{STATUS_META[filter].blurb}</p>
      )}

      {shown.length === 0 ? (
        <p className="mt-8 font-mono text-sm text-text-muted">No types in this view yet.</p>
      ) : (
        <ul className="mt-6 grid gap-3">
          {shown
            .slice()
            .sort((a, b) => {
              const ai = STATUS_ORDER.indexOf((a.status ?? 'queued') as EarningTypeStatus)
              const bi = STATUS_ORDER.indexOf((b.status ?? 'queued') as EarningTypeStatus)
              if (ai !== bi) return ai - bi
              return (a.action_type ?? '').localeCompare(b.action_type ?? '')
            })
            .map((view) => (
              <TypeRow key={view.action_type ?? Math.random()} view={view} />
            ))}
        </ul>
      )}

      {footer && (
        <div className="glass mt-10 rounded-xl p-5">
          <h2 className="font-mono text-xs uppercase tracking-wider text-text-muted">
            The signed policy
          </h2>
          <p className="mt-2 text-sm leading-6 text-text-secondary">
            &ldquo;Live&rdquo; is computed from the signed policy the running network serves,
            matched against its signature, never from a hand edit.
          </p>
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            {typeof footer.matrix_entry_count === 'number' && (
              <div className="flex justify-between gap-4">
                <dt className="font-mono uppercase tracking-wider text-text-muted">Named kinds</dt>
                <dd className="text-text-secondary">{footer.matrix_entry_count}</dd>
              </div>
            )}
            {footer.matrix_policy_version && (
              <div className="flex justify-between gap-4">
                <dt className="font-mono uppercase tracking-wider text-text-muted">Policy version</dt>
                <dd className="font-mono text-text-secondary">{footer.matrix_policy_version}</dd>
              </div>
            )}
            {typeof footer.digest_match === 'boolean' && (
              <div className="flex justify-between gap-4">
                <dt className="font-mono uppercase tracking-wider text-text-muted">Signature</dt>
                <dd className={footer.digest_match ? 'text-provian-blue' : 'text-provian-gold'}>
                  {footer.digest_match ? 'matched' : 'awaiting activation'}
                </dd>
              </div>
            )}
          </dl>
          {footer.template_digest && (
            <CopyBlock label="Signed policy digest" text={footer.template_digest} />
          )}
        </div>
      )}

      <CopyBlock label="API" text={`curl ${API_BASE}/v1/pe/earning-proposals`} />

      <p className="mt-10 max-w-2xl text-sm leading-6 text-text-muted">
        Every act of work mints PVT once, at the value its evidence supports. A status here never
        reprices a receipt already sealed.
      </p>
    </div>
  )
}
