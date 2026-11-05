'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

const API = 'https://api.provian.ai/v1/gates/github'
const REPOS = ['provian', 'provian-reference-gate'] as const

/** A presentation travels directly to the gate, never into a GitHub comment or browser storage. */
export default function PullRequestGatePage() {
  const [repo, setRepo] = useState<string>('provian')
  const [number, setNumber] = useState('')
  const [walletId, setWalletId] = useState('')
  const [challenge, setChallenge] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [cleared, setCleared] = useState<boolean | null>(null)
  const valid = REPOS.some((r) => r === repo) && /^[1-9][0-9]{0,9}$/.test(number)
  const endpoint = `${API}/${repo}/${number}`
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const r = params.get('repo'); const n = params.get('pr')
    if (r && REPOS.some((v) => v === r)) setRepo(r)
    if (n && /^[1-9][0-9]{0,9}$/.test(n)) setNumber(n)
  }, [])
  const reset = () => { setChallenge(''); setToken(''); setMessage(''); setCleared(null) }
  const errorMessage = (error: string): string => {
    if (error === 'link_github_identity_to_wallet') return 'Link the PR author’s GitHub account to its wallet first. The contributing walkthrough shows the human and agent paths.'
    if (error === 'burn_finality_pending_retry_same_token') return 'Base finality is pending. Keep this token and submit it again shortly. No additional burn is needed.'
    if (error === 'pr_already_cleared') return 'This PR is already cleared. No additional burn is needed.'
    if (error === 'challenge_mismatch' || error === 'presentation_replayed') return 'This presentation cannot clear this PR. It must answer this PR’s own signed challenge.'
    return error || 'The gate is temporarily unavailable. Keep the same token and retry.'
  }
  const load = async () => {
    if (!valid || busy) return
    setBusy(true); setMessage(''); setChallenge('')
    try {
      const status = await fetch(endpoint, { cache: 'no-store' })
      const state = await status.json()
      if (!status.ok) throw new Error(errorMessage(state.error))
      if (state.exempt) { setCleared(true); setMessage('LongevityManiac is exempt. No burn, presentation, gate check or review is required; direct push and merge are allowed.'); return }
      setCleared(state.cleared === true)
      if (state.cleared) { setMessage('This PR is cleared. Later pushes and reopening require no additional burn.'); return }
      const res = await fetch(`${endpoint}/challenge${walletId.trim() ? `?wallet_id=${encodeURIComponent(walletId.trim())}` : ''}`, { cache: 'no-store' })
      const value = await res.json()
      if (!res.ok) throw new Error(errorMessage(value.error))
      setChallenge(JSON.stringify(value, null, 2))
      setMessage('The signed challenge is ready. In the app, verify provian.ai and confirm the displayed 50 PVT price.')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'The gate is unavailable. Retry shortly.') }
    finally { setBusy(false) }
  }
  const submit = async () => {
    if (!valid || !token.trim() || busy) return
    setBusy(true); setMessage('')
    try {
      const res = await fetch(`${endpoint}/present`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }) })
      const result = await res.json()
      if (!res.ok) throw new Error(errorMessage(result.error))
      setCleared(true); setToken('')
      setMessage('Presentation accepted. The PR is cleared for review. For non-owner PRs, the repository owner must approve its current head on GitHub before the App merges. Later pushes keep the clearance and need a fresh approval.')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Submission failed. Keep and retry the same token.') }
    finally { setBusy(false) }
  }
  return <main className="mx-auto max-w-4xl px-6 py-16 text-text-primary md:py-24">
    <p className="eyebrow text-provian-blue-bright">provian.ai · live repository gate</p>
    <h1 className="mt-5 font-display text-4xl font-semibold md:text-6xl">One PR. One presentation.</h1>
    <p className="mt-6 max-w-3xl text-lg leading-8 text-text-secondary">LongevityManiac is exempt: owner pushes and PRs, including CC/Codex work from the owner’s checkout, need no burn, presentation, required gate check or review. Direct push and merge are allowed. Every other PR requires a 50 PVT presentation from the actual author’s own linked wallet; another wallet cannot pay. Further pushes require no additional burn. Clearance only unlocks merge: the repository owner must approve the current head on GitHub before the App merges. Git Witness earnings are unchanged.</p>
    <p className="mt-4 leading-7 text-text-secondary">Agents use the <Link className="text-provian-blue-bright underline" href="/library/contributing">SDK, MCP or CLI walkthrough</Link>. For a human contribution, get the signed challenge here, paste it into the app’s outside-gate presenter, verify provian.ai, burn 50 PVT and return the token below. <Link className="text-provian-blue-bright underline" href="/download">Get the app</Link> and link Connect → GitHub first.</p>
    <div className="mt-10 grid gap-5 rounded-2xl border border-white/10 bg-surface p-6">
      <label className="grid gap-2">Repository<select aria-label="Repository" value={repo} disabled={busy} onChange={(e) => { setRepo(e.target.value); reset() }} className="rounded-lg border border-white/20 bg-void p-3">
        {REPOS.map((r) => <option value={r} key={r}>LongevityManiac/{r}</option>)}
      </select></label>
      <label className="grid gap-2">PR number<input inputMode="numeric" value={number} disabled={busy} onChange={(e) => { setNumber(e.target.value); reset() }} className="rounded-lg border border-white/20 bg-void p-3" /></label>
      <label className="grid gap-2">Wallet id (when multiple wallets are linked)<input value={walletId} disabled={busy} onChange={(e) => { setWalletId(e.target.value); reset() }} autoComplete="off" className="rounded-lg border border-white/20 bg-void p-3" /></label>
      <button onClick={() => void load()} disabled={!valid || busy} className="btn-primary disabled:opacity-50">{busy ? 'Checking…' : 'Get signed challenge / check clearance'}</button>
      {message && <p role="status" className="rounded-lg border border-white/15 p-4 leading-7">{message}</p>}
      {challenge && cleared !== true && <>
        <label className="grid gap-2">Signed challenge<textarea readOnly value={challenge} rows={8} className="rounded-lg border border-white/20 bg-void p-3 font-mono text-xs" /></label>
        <button className="btn-secondary" onClick={() => void navigator.clipboard.writeText(challenge).then(() => setMessage('Challenge copied. Paste it into the app’s outside-gate presenter.')).catch(() => setMessage('Select and copy the challenge above.'))}>Copy challenge</button>
      </>}
      {cleared !== true && <>
        <label className="grid gap-2">Presentation token<textarea aria-label="Presentation token" value={token} onChange={(e) => setToken(e.target.value)} rows={4} autoComplete="off" spellCheck={false} className="rounded-lg border border-white/20 bg-void p-3 font-mono text-xs" /></label>
        <button onClick={() => void submit()} disabled={!valid || !token.trim() || busy} className="btn-primary disabled:opacity-50">Submit presentation</button>
      </>}
    </div>
  </main>
}
