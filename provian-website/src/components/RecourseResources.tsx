'use client'
import { useEffect, useState } from 'react'

interface Resources { reserveAtomic: string; memberBalanceAtomic: string; memberCount: number; block: number; observedAtMs: number }
const amount = (value: string): string => {
  const n = BigInt(value), fraction = (n % BigInt('1000000000000000000')).toString().padStart(18, '0').replace(/0+$/, '')
  return `${n / BigInt('1000000000000000000')}${fraction ? `.${fraction}` : ''}`
}
export function RecourseResources() {
  const [data, setData] = useState<Resources | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, retry] = useState(0)
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    setFailed(false)
    fetch('https://api.provian.ai/v1/recourse/resources', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable')
        const value = await response.json() as Partial<Resources>
        if (typeof value.reserveAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.reserveAtomic)
          || typeof value.memberBalanceAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.memberBalanceAtomic)
          || !Number.isSafeInteger(value.memberCount) || !Number.isSafeInteger(value.block)
          || !Number.isSafeInteger(value.observedAtMs)) throw new Error('invalid')
        if (live) setData(value as Resources)
      }).catch(() => { if (live) setFailed(true) })
      .finally(() => clearTimeout(timeout))
    return () => { live = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])
  const denominator = data ? BigInt(data.memberBalanceAtomic) : BigInt(0)
  const percent = data && denominator > BigInt(0) ? BigInt(data.reserveAtomic) * BigInt(10000) / denominator : null
  return <div className="border-y border-white/15 py-8" aria-live="polite">
    <h2 className="font-display text-3xl">The pool’s resources</h2>
    {data ? <>
      <dl className="mt-6 grid gap-6 sm:grid-cols-3">
        <div><dt className="text-text-secondary">Reserve</dt><dd className="mt-2 break-words font-mono text-xl">{amount(data.reserveAtomic)} PVT</dd></div>
        <div><dt className="text-text-secondary">Members’ bound balances</dt><dd className="mt-2 break-words font-mono text-xl">{amount(data.memberBalanceAtomic)} PVT</dd></div>
        <div><dt className="text-text-secondary">Reserve-to-member-balance ratio</dt><dd className="mt-2 font-mono text-xl">{percent === null ? 'No member balance' : `${percent / BigInt(100)}.${(percent % BigInt(100)).toString().padStart(2, '0')}%`}</dd></div>
      </dl>
      <p className="mt-5 text-sm text-text-secondary">{data.memberCount} members · Base block {data.block} · Observed {new Date(data.observedAtMs).toLocaleString()}</p>
    </> : <p className="mt-5 text-text-secondary">{failed ? 'Resource figures could not be loaded.' : 'Loading the pool’s recorded resources…'}</p>}
    {failed && <button type="button" className="btn-ghost mt-4" onClick={() => retry(value => value + 1)}>Try again</button>}
    <p className="mt-6 text-text-secondary">An as-of resource measure, not a payment promise. Accepted determinations use their own pro rata execution rule.</p>
  </div>
}
