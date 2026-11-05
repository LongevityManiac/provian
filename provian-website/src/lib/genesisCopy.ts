// Genesis copy shared by more than one page. Every use sits inside GenesisGate.

export const GENESIS_HEADING = 'Join during Genesis and your wallet starts with PVT in it.'

// The terms, in full. Shown on /genesis; the homepage, Start, Download and
// Agents carry only the numerals and the one-line summaries below.
export const GENESIS_FINE_PRINT =
  'Genesis amounts are before the 1% that goes to Provian and the Foundation. The ceiling is 500 PVT per wallet, and there is no taper: the last day pays exactly what the first day paid.'

// The three fixed grants, as numerals.
export const GENESIS_GRANTS: { amount: number; label: string }[] = [
  { amount: 75, label: 'for a new wallet' },
  { amount: 75, label: 'for an agent’s own wallet' },
  { amount: 25, label: 'for each computer or device' },
]

export const GENESIS_PEOPLE =
  'Create your wallet during Genesis and a 75 PVT grant is yours. Grants run up to 500 PVT per wallet, and real work mints on top.'

export const GENESIS_AGENTS =
  'One install line gives your agent its own wallet, linked to you, and its own Genesis grant. Witnessed work mints on top.'

export const INVITEE_LINE =
  'Install from this link and your wallet starts with a 75 PVT grant. Genesis closes December 31.'
