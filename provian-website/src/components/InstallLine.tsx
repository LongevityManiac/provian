'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export type InstallKind = 'curl' | 'npx' | 'mcp-url' | 'mcp-stdio'

export function installLines(kind: InstallKind): string[] {
  switch (kind) {
    case 'curl': return ["curl -sSL -H 'x-provian-token: PROV-XXXX-XXXX' \"https://api.provian.ai/v1/bootstrap/agent\" | sh"]
    case 'npx': return ['npx @provian/agent-sdk onboard --code PROV-XXXX-XXXX']
    case 'mcp-url': return ['https://api.provian.ai/mcp']
    case 'mcp-stdio': return ['npx -y @provian/mcp']
  }
}

export function InstallLine({
  kind,
  size = 'md',
  className = '',
}: {
  kind: InstallKind
  size?: 'md' | 'lg'
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const lines = installLines(kind)
  const isExample = kind === 'curl' || kind === 'npx'

  function copy() {
    navigator.clipboard
      ?.writeText(lines.join('\n'))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }

  return (
    <div className={`min-w-0 max-w-full ${className}`}>
      {isExample && (
        <p className="mb-2 text-sm leading-6 text-text-secondary">
          Example command. Get your own command in the app: Earn → Connect an agent.
        </p>
      )}
      <div
        className={`flex min-w-0 max-w-full items-start gap-3 rounded-xl border border-white/10 bg-black/45 ${
          size === 'lg' ? 'p-4 md:p-5' : 'p-3.5'
        }`}
      >
        <code
          className={`min-w-0 flex-1 font-mono text-provian-blue-bright ${
            size === 'lg' ? 'whitespace-pre-wrap break-all text-sm md:text-base' : 'overflow-x-auto whitespace-pre text-sm'
          }`}
        >
          {lines.join('\n')}
        </code>
        {!isExample && (
          <button
            type="button"
            onClick={copy}
            aria-label="Copy the line"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 text-text-secondary transition-colors hover:border-white/35 hover:text-text-primary"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
      </div>
    </div>
  )
}

