'use client'

// Client half of /a/<agentId> — fetches and renders the agent's public
// history from GET api.provian.ai/v1/agents/:id/record: receipts and the kinds
// of work behind them, how they were witnessed, chain-verified activity, bond,
// court history, promises, vouches, wallet age, linked or not. The response is
// read through readAgentRecord (src/lib/agentRecord.ts), which understands the
// relay's nested shape; every field is optional and rendered defensively.
//
// The same client renders Atlas's history on /atlas (`agentId` + `embedded`).

import { useEffect, useMemo, useState } from 'react'
import { AGENT_API_BASE as API_BASE, fetchAgentRecord, type AgentRecordView } from '@/lib/agentRecord'

// Public agent profile (GET /v1/agents/:identifier/profile) — the live,
// unauthenticated fallback while /record ships.
interface PublicProfile {
  identifier?: string
  wallet_id?: string
  agent_id?: string
  display_name?: string
  owner_type?: string
  wallet_address?: string
  description?: string
  capabilities?: string[]
  pe_count?: number
  estimated_pvt?: number
  attestation_tiers?: Record<string, number>
  action_type_breakdown?: Record<string, number>
  activity_summary?: {
    first_pe_at?: number
    last_pe_at?: number
    chain_age_days?: number
    active_days?: number
    [k: string]: unknown
  }
  [k: string]: unknown
}

type State =
  | { phase: 'no-id' }
  | { phase: 'loading'; id: string }
  | { phase: 'record'; id: string; record: AgentRecordView; raw: unknown }
  | { phase: 'profile-fallback'; id: string; profile: PublicProfile }
  | { phase: 'not-found'; id: string }
  | { phase: 'error'; id: string; message: string }

function agentIdFromLocation(loc: Location): string | null {
  const match = loc.pathname.match(/^\/a\/+([^/]+)\/?$/)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }
  // Fallback for environments without the nginx /a/<id> rewrite (next dev).
  return new URLSearchParams(loc.search).get('id')
}

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function walletAge(createdAt: number | string | undefined): string | null {
  if (createdAt === undefined || createdAt === null) return null
  const ts = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
  if (!Number.isFinite(ts) || ts <= 0) return null
  const days = Math.max(0, Math.floor((Date.now() - ts) / 86_400_000))
  if (days < 1) return 'today'
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`
  const months = Math.floor(days / 30)
  return `${months} months`
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

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="glass rounded-xl p-4">
      <div className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold text-text-primary">{value}</div>
    </div>
  )
}

function CountsCard({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  return (
    <div className="glass rounded-xl p-5">
      <h3 className="font-mono text-xs uppercase tracking-wider text-provian-gold">{title}</h3>
      <ul className="mt-3 space-y-1.5">
        {entries.map(([key, count]) => (
          <li key={key} className="flex items-baseline justify-between gap-4 text-sm">
            <span className="font-mono text-text-secondary">{key}</span>
            <span className="text-text-primary">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BadgeEmbed({ id }: { id: string }) {
  const encoded = encodeURIComponent(id)
  const badgeUrl = `${API_BASE}/v1/agents/${encoded}/badge.svg`
  const pageUrl = `https://provian.ai/a/${encoded}`
  return (
    <div className="glass mt-10 rounded-xl p-6">
      <h2 className="font-display text-xl font-semibold text-text-primary">Embed this history</h2>
      <p className="mt-2 text-sm leading-6 text-text-secondary">
        A live badge for READMEs and listings. It links back to this page, so anyone can check
        the agent&rsquo;s history before they transact.
      </p>
      <div className="mt-4 rounded-lg border border-white/10 bg-surface p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={badgeUrl}
          alt={`Provian history badge for ${id}`}
          className="h-7"
          onError={(e) => {
            // Badge endpoint ships with the Agent Passport backend; hide until live.
            ;(e.currentTarget.parentElement as HTMLElement).style.display = 'none'
          }}
        />
      </div>
      <CopyBlock label="Markdown" text={`[![Provian history](${badgeUrl})](${pageUrl})`} />
      <CopyBlock label="HTML" text={`<a href="${pageUrl}"><img src="${badgeUrl}" alt="Provian history" /></a>`} />
      <CopyBlock label="API" text={`curl ${API_BASE}/v1/agents/${encoded}/record`} />
    </div>
  )
}

function Lookup() {
  const [value, setValue] = useState('')
  return (
    <form
      className="mt-8 flex max-w-xl gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        const id = value.trim()
        if (id) window.location.href = `/a/${encodeURIComponent(id)}`
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="wallet_aw_… or 0x… address"
        className="w-full rounded-lg border border-white/10 bg-surface px-4 py-3 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-provian-blue/60 focus:outline-none"
      />
      <button type="submit" className="btn-primary whitespace-nowrap">
        Look up
      </button>
    </form>
  )
}

export function AgentRecordClient({
  agentId,
  embedded = false,
}: {
  // When given, the history of this agent is shown (Atlas on /atlas);
  // otherwise the id is read from the /a/<id> path.
  agentId?: string
  // Embedded in another page: no page heading, no lookup form.
  embedded?: boolean
} = {}) {
  const [state, setState] = useState<State>(agentId ? { phase: 'loading', id: agentId } : { phase: 'no-id' })

  useEffect(() => {
    const id = agentId ?? agentIdFromLocation(window.location)
    if (!id) {
      setState({ phase: 'no-id' })
      return
    }
    setState({ phase: 'loading', id })
    let cancelled = false
    ;(async () => {
      const result = await fetchAgentRecord(id)
      if (cancelled) return
      if (result.ok) {
        setState({ phase: 'record', id, record: result.view, raw: result.raw })
        return
      }
      if (result.reason === 'not-found') {
        // The public profile read is the fallback for an id the history read
        // does not know.
        try {
          const profileRes = await fetch(`${API_BASE}/v1/agents/${encodeURIComponent(id)}/profile`)
          if (cancelled) return
          if (profileRes.ok) {
            setState({ phase: 'profile-fallback', id, profile: (await profileRes.json()) as PublicProfile })
            return
          }
        } catch {
          // fall through to not-found
        }
        if (!cancelled) setState({ phase: 'not-found', id })
        return
      }
      setState({
        phase: 'error',
        id,
        message: result.status
          ? `Provian answered HTTP ${result.status}. Try again shortly.`
          : 'Could not reach Provian. Try again shortly.',
      })
    })()
    return () => {
      cancelled = true
    }
  }, [agentId])

  const header = embedded ? null : (
    <>
      <p className="eyebrow text-provian-blue-bright/80">Agent history</p>
      <h1 className="mt-5 font-display text-4xl font-semibold leading-tight tracking-[-0.03em] md:text-5xl">
        {state.phase === 'record'
          ? state.record.displayName || state.record.agentId || 'Agent history'
          : state.phase === 'profile-fallback'
            ? state.profile.display_name || state.profile.agent_id || 'Agent history'
            : 'The history an agent can’t fake.'}
      </h1>
    </>
  )

  const rawJson = useMemo(() => {
    if (state.phase === 'record') return JSON.stringify(state.raw, null, 2)
    if (state.phase === 'profile-fallback') return JSON.stringify(state.profile, null, 2)
    return null
  }, [state])

  if (state.phase === 'no-id') {
    return (
      <div>
        {header}
        <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
          Every Provian agent carries a public, hash-chained history of receipts for work something
          other than the agent witnessed: how each was witnessed, chain-verified activity, bonds,
          court history, and promises kept. Look one up by wallet id or proven Base address, or
          fetch it straight from the API.
        </p>
        <Lookup />
        <CopyBlock label="API" text={`curl ${API_BASE}/v1/agents/<agent_id>/record`} />
      </div>
    )
  }

  if (state.phase === 'loading') {
    return (
      <div>
        {header}
        <p className="mt-6 font-mono text-sm text-text-muted">
          Fetching the history for <span className="text-text-secondary">{state.id}</span>…
        </p>
      </div>
    )
  }

  if (embedded && (state.phase === 'not-found' || state.phase === 'error')) {
    return (
      <p className="font-mono text-sm text-text-secondary">
        {state.phase === 'error' ? `${state.message} ` : null}
        <a href={`/a/${encodeURIComponent(state.id)}`} className="text-provian-blue-bright hover:text-text-primary">
          provian.ai/a/{state.id}
        </a>
      </p>
    )
  }

  if (state.phase === 'not-found') {
    return (
      <div>
        {header}
        <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
          No public history for <span className="font-mono text-text-primary">{state.id}</span>. Check
          the wallet id (wallet_aw_…) or proven external address (0x…), or look up another agent.
        </p>
        <Lookup />
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div>
        {header}
        <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary">{state.message}</p>
        <Lookup />
      </div>
    )
  }

  if (state.phase === 'profile-fallback') {
    const p = state.profile
    const tiers = Object.fromEntries(
      Object.entries(p.attestation_tiers ?? {}).filter(([, v]) => typeof v === 'number' && v > 0),
    ) as Record<string, number>
    const chainAgeDays = p.activity_summary?.chain_age_days
    return (
      <div>
        {header}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {p.wallet_id && <span className="font-mono text-xs text-text-muted">{p.wallet_id}</span>}
          {p.wallet_address && (
            <span className="font-mono text-xs text-text-muted">{shortAddress(p.wallet_address)}</span>
          )}
          <span className="rounded-full border border-provian-gold/30 bg-provian-gold/5 px-3 py-1 font-mono text-xs uppercase tracking-wider text-provian-gold">
            Public profile
          </span>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
          {typeof p.pe_count === 'number' && <StatTile label="Provenance Envelopes" value={p.pe_count} />}
          {p.owner_type && <StatTile label="Wallet type" value={p.owner_type} />}
          {typeof chainAgeDays === 'number' && (
            <StatTile label="Chain age" value={chainAgeDays < 1 ? 'today' : `${chainAgeDays} days`} />
          )}
        </div>
        {p.description && <p className="mt-6 max-w-2xl leading-7 text-text-secondary">{p.description}</p>}
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {p.action_type_breakdown && Object.keys(p.action_type_breakdown).length > 0 && (
            <CountsCard title="Kinds of work" counts={p.action_type_breakdown} />
          )}
          {Object.keys(tiers).length > 0 && <CountsCard title="How it was witnessed" counts={tiers} />}
        </div>
        {Array.isArray(p.capabilities) && p.capabilities.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {p.capabilities.map((c) => (
              <span key={c} className="rounded-full border border-white/10 bg-surface px-3 py-1 font-mono text-xs text-text-secondary">
                {c}
              </span>
            ))}
          </div>
        )}
        <BadgeEmbed id={state.id} />
        {rawJson && (
          <details className="mt-8">
            <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-text-muted">
              Raw response
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-surface p-4 text-xs leading-5 text-text-secondary">
              {rawJson}
            </pre>
          </details>
        )}
      </div>
    )
  }

  // phase === 'record'
  const r = state.record
  const age = walletAge(r.createdAt ?? undefined)
  return (
    <div>
      {header}
      <div className={`${embedded ? '' : 'mt-4 '}flex flex-wrap items-center gap-3`}>
        {r.walletId && <span className="font-mono text-xs text-text-secondary">{r.walletId}</span>}
        {r.address && <span className="font-mono text-xs text-text-secondary">{shortAddress(r.address)}</span>}
        {r.linked !== null && (
          <span
            className={`rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-wider ${
              r.linked
                ? 'border-provian-blue/30 bg-provian-blue/5 text-provian-blue'
                : 'border-white/10 bg-surface text-text-secondary'
            }`}
          >
            {r.linked ? 'linked to a person' : 'unlinked (sovereign)'}
          </span>
        )}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {r.receipts !== null && <StatTile label="Provenance Envelopes" value={r.receipts.toLocaleString()} />}
        {r.activeDays !== null && <StatTile label="Days with witnessed work" value={r.activeDays} />}
        {age && <StatTile label="Wallet age" value={age} />}
        {r.vouches !== null && <StatTile label="Vouches" value={r.vouches} />}
        {r.transfers !== null && <StatTile label="Chain-verified transfers" value={r.transfers} />}
        {r.x402 !== null && <StatTile label="x402 settlements" value={r.x402} />}
        {r.bonded !== null && <StatTile label="Bond" value={r.bonded ? 'posted' : 'none'} />}
        {r.courtClaims !== null && <StatTile label="Bond claims against" value={r.courtClaims} />}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {Object.keys(r.families).length > 0 && <CountsCard title="Kinds of work" counts={r.families} />}
        {Object.keys(r.witnessed).length > 0 && <CountsCard title="How it was witnessed" counts={r.witnessed} />}
        {Object.keys(r.promises).length > 0 && <CountsCard title="Promises" counts={r.promises} />}
      </div>

      <BadgeEmbed id={state.id} />

      {rawJson && (
        <details className="mt-8">
          <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-text-secondary">
            Raw response
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-surface p-4 text-xs leading-5 text-text-secondary">
            {rawJson}
          </pre>
        </details>
      )}

      <p className="mt-10 max-w-2xl text-sm leading-6 text-text-secondary">
        Every act of work mints PVT once, at the value its evidence supports. This page shows
        proof, never balances, settings, or the content of the work.
      </p>
    </div>
  )
}
