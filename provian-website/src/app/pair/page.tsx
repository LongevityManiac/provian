'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronRight, Monitor } from 'lucide-react'
import QRCode from 'qrcode'

const ENDPOINT = 'https://api.provian.ai/v1/computer-pairing'

type PairingStatus =
  | { state: 'waiting_for_phone' }
  | { state: 'waiting_for_computer'; macLinux: string; windows: string }
  | { state: 'connected'; name: string; firstProof: boolean }

async function request<T>(operation: string, browserKey: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${ENDPOINT}/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserKey }),
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(String(response.status))
  return response.json() as Promise<T>
}

export default function PairComputerPage() {
  const [generation, setGeneration] = useState(0)
  const [code, setCode] = useState('')
  const [qr, setQr] = useState('')
  const [status, setStatus] = useState<PairingStatus | null>(null)
  const [error, setError] = useState('')
  const [system, setSystem] = useState<'macLinux' | 'windows'>('macLinux')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setSystem('windows')
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      byte => byte.toString(16).padStart(2, '0')).join('')
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      let delay = 5000
      try {
        const next = await request<PairingStatus>('browser-status', key, signal)
        if (signal.aborted) return
        setStatus(next)
        setError('')
        if (next.state === 'connected') return
      } catch (failure) {
        if (signal.aborted) return
        if (failure instanceof Error && failure.message === '404') {
          setError('This code expired. Start again to get a new one.')
          setStatus(null)
          return
        }
        setError('Reconnecting…')
        delay = 10_000
      }
      timer = setTimeout(poll, delay)
    }

    async function start() {
      try {
        const next = await request<{ code: string }>('start', key, signal)
        const displayCode = next.code.toUpperCase().match(/.{4}/g)?.join(' ') ?? next.code
        const image = await QRCode.toDataURL(`provian-computer:${next.code}`, { width: 224, margin: 4 })
        if (signal.aborted) return
        setCode(displayCode)
        setQr(image)
        setStatus({ state: 'waiting_for_phone' })
        timer = setTimeout(poll, 2000)
      } catch {
        if (!signal.aborted) setError('Couldn’t start pairing. Try again.')
      }
    }

    setCode('')
    setQr('')
    setStatus(null)
    setError('')
    setCopied(false)
    void start()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [generation])

  return (
    <section className="mx-auto min-h-[70vh] w-full max-w-2xl px-6 pb-24 pt-28">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-current text-sky-300">
        {status?.state === 'connected' ? <Check aria-hidden /> : <Monitor aria-hidden />}
      </div>
      <h1 className="mb-4 text-4xl font-semibold tracking-tight sm:text-5xl">Connect your computer</h1>

      {status?.state === 'waiting_for_phone' && (
        <>
          <p className="mb-7 max-w-md text-lg text-slate-300">Scan this with Provian on your phone, or type the code there. Confirm that the codes match.</p>
          {qr && <img src={qr} width={224} height={224} alt="Scan this pairing code with Provian" className="rounded-xl" />}
          <p className="mt-5 font-mono text-2xl tabular-nums tracking-widest">{code}</p>
          <p className="mt-5 text-sm text-slate-300" role="status">Waiting for your phone</p>
        </>
      )}

      {status?.state === 'waiting_for_computer' && (
        <>
          <p className="mb-6 text-lg text-slate-300">Open {system === 'windows' ? 'PowerShell' : 'Terminal'} on this computer. Paste this command and press Enter.</p>
          <label className="mb-4 block text-sm text-slate-300">
            Operating system
            <select value={system} onChange={(event) => {
              setSystem(event.target.value === 'windows' ? 'windows' : 'macLinux')
              setCopied(false)
            }} className="mt-2 block rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-white">
              <option value="macLinux">macOS or Linux</option>
              <option value="windows">Windows</option>
            </select>
          </label>
          <pre className="max-w-full whitespace-pre-wrap break-all rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm"><code>{status[system]}</code></pre>
          <button type="button" className="mt-4 rounded-xl bg-sky-300 px-5 py-3 font-semibold text-slate-950" onClick={async () => {
            try {
              await navigator.clipboard.writeText(status[system])
              setCopied(true)
            } catch {
              setError('Select the command above to copy it.')
            }
          }}>{copied ? 'Copied' : 'Copy setup command'}</button>
          <p className="mt-5 text-sm text-slate-300" role="status">Waiting for your computer</p>
        </>
      )}

      {status?.state === 'connected' && (
        <div role="status">
          <p className="text-xl text-sky-300">{status.name} connected</p>
          {status.firstProof && <p className="mt-2 text-slate-300">First proof arrived</p>}
        </div>
      )}

      {(!status || error) && <p className="mt-5 text-slate-300" role="status">{error || 'Getting your pairing code…'}</p>}
      {!status && error && (
        <button type="button" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-sky-300 px-5 py-3 font-semibold text-slate-950"
          onClick={() => setGeneration(value => value + 1)}>Get a new code <ChevronRight size={16} aria-hidden /></button>
      )}
    </section>
  )
}
