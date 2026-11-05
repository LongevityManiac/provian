import { useId } from 'react'

// The PVT proof mark: a minted platinum coin carrying a deep navy verified
// check inside a thin seal ring. The same drawing as the app's PVTIcon
// (src/components/TokenIcon.tsx), in the same platinum tokens.
export function PvtCoin({ size = 20, className = '' }: { size?: number; className?: string }) {
  const gradient = `pvtPlat${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={`inline-block shrink-0 align-[-0.12em] ${className}`}
    >
      <defs>
        <radialGradient id={gradient} cx="38%" cy="30%" r="82%">
          <stop offset="0" stopColor="#F5F7FB" />
          <stop offset="1" stopColor="#C2C9D5" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${gradient})`} />
      <circle cx="50" cy="50" r="45.5" fill="none" stroke="#F5F7FB" strokeOpacity="0.45" strokeWidth="1.5" />
      <circle cx="50" cy="50" r="47" fill="none" stroke="#8A93A3" strokeOpacity="0.55" strokeWidth="2" />
      <circle cx="50" cy="50" r="27" fill="none" stroke="#1B2637" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M34 53 L45 64 L68 37" fill="none" stroke="#152233" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A PVT amount as a numeral with the coin beside it.
export function Pvt({
  amount,
  className = '',
  coin = 28,
}: {
  amount: string | number
  className?: string
  coin?: number
}) {
  return (
    <span className={`inline-flex items-center gap-[0.28em] ${className}`}>
      <span className="numeral">{amount}</span>
      <PvtCoin size={coin} />
      <span className="sr-only">PVT</span>
    </span>
  )
}
