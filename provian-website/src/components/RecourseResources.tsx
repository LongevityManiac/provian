'use client'
import { useEffect, useState } from 'react'

interface Resources { schema: 'provian-recourse-resources/v2'; reserveAtomic: string; allocatedAtomic: string; block: number; observedAtMs: number;
  ratio: null | { numerator: string; denominator: string; block: number; transactionHash: string } }
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
        if (value.schema !== 'provian-recourse-resources/v2' || typeof value.reserveAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.reserveAtomic)
          || typeof value.allocatedAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.allocatedAtomic)
          || !Number.isSafeInteger(value.block)
          || (value.ratio !== null && (!value.ratio || typeof value.ratio.numerator !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.ratio.numerator)
            || typeof value.ratio.denominator !== 'string' || !/^[1-9][0-9]*$/.test(value.ratio.denominator)
            || BigInt(value.ratio.numerator) > BigInt(value.ratio.denominator) || !Number.isSafeInteger(value.ratio.block)
            || value.ratio.block > Number(value.block) || !/^0x[0-9a-f]{64}$/.test(value.ratio.transactionHash)))
          || !Number.isSafeInteger(value.observedAtMs)) throw new Error('invalid')
        if (live) setData(value as Resources)
      }).catch(() => { if (live) setFailed(true) })
      .finally(() => clearTimeout(timeout))
    return () => { live = false; clearTimeout(timeout); controller.abort() }
  }, [attempt])
  const denominator = data?.ratio ? BigInt(data.ratio.denominator) : BigInt(0)
  const percent = data?.ratio && denominator > BigInt(0) ? BigInt(data.ratio.numerator) * BigInt(10000) / denominator : null
  return <div className="border-y border-white/15 py-8" aria-live="polite">
    <h2 className="font-display text-3xl">The pool’s resources</h2>
    {data ? <>
      <dl className="mt-6 grid gap-6 sm:grid-cols-3">
        <div><dt className="text-text-secondary">Available reserve now</dt><dd className="mt-2 break-words font-mono text-xl">{amount(data.reserveAtomic)} PVT</dd></div>
        <div><dt className="text-text-secondary">Allocated restorations awaiting withdrawal</dt><dd className="mt-2 break-words font-mono text-xl">{amount(data.allocatedAtomic)} PVT</dd></div>
        <div><dt className="text-text-secondary">Last executed batch ratio</dt><dd className="mt-2 font-mono text-xl">{percent === null ? 'No batch executed by this pool' : `${percent / BigInt(100)}.${(percent % BigInt(100)).toString().padStart(2, '0')}%`}</dd></div>
      </dl>
      <p className="mt-5 text-sm text-text-secondary">Base block {data.block} · Observed {new Date(data.observedAtMs).toLocaleString()}</p>
      {data.ratio && <p className="mt-3 text-sm text-text-secondary">Batch at Base block {data.ratio.block} · <a className="underline" href={`https://basescan.org/tx/${data.ratio.transactionHash}`}>View execution</a></p>}
    </> : <p className="mt-5 text-text-secondary">{failed ? 'Resource figures could not be loaded.' : 'Loading the pool’s recorded resources…'}</p>}
    {failed && <button type="button" className="btn-ghost mt-4" onClick={() => retry(value => value + 1)}>Try again</button>}
    <p className="mt-6 text-text-secondary">The batch ratio is distributable reserves divided by accepted shortfalls. Each allocation rounds down to whole atomic units. It records that execution; it promises no future restoration percentage. Portfolio totals remain private.</p>
  </div>
}
