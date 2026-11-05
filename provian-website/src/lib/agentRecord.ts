// The public agent history read: GET api.provian.ai/v1/agents/:id/record.
//
// The relay's response is nested (agent / provenance / financial / bond /
// court / promises / vouches; provian-backend/src/routes/agent-record.ts). An
// earlier draft of the contract was flat (pe_count, pe_families, … at the top
// level). `readAgentRecord` reads the live shape first and the flat one as a
// fallback, so the page renders whichever the relay returns.

export const AGENT_API_BASE = 'https://api.provian.ai'

type Dict = Record<string, unknown>

function dict(v: unknown): Dict | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function counts(v: unknown): Record<string, number> {
  const d = dict(v)
  if (!d) return {}
  return Object.fromEntries(
    Object.entries(d).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0),
  )
}

export type AgentRecordView = {
  found: boolean
  displayName: string | null
  agentId: string | null
  walletId: string | null
  address: string | null
  linked: boolean | null
  createdAt: number | string | null
  receipts: number | null
  activeDays: number | null
  firstReceiptAt: number | null
  families: Record<string, number>
  witnessed: Record<string, number>
  vouches: number | null
  transfers: number | null
  x402: number | null
  bonded: boolean | null
  courtClaims: number | null
  promises: Record<string, number>
}

export function readAgentRecord(raw: unknown): AgentRecordView {
  const r = dict(raw) ?? {}
  const agent = dict(r.agent) ?? {}
  const prov = dict(r.provenance) ?? {}
  const fin = dict(r.financial) ?? {}
  const legacyChain = dict(r.chain_verified) ?? {}
  const bond = dict(r.bond)
  const court = dict(r.court) ?? {}
  const claims = dict(court.bond_claims_against)
  const vouches = dict(r.vouches)
  const linkedRaw = agent.linked_to_human ?? r.linked_human ?? r.linked
  const created = agent.created_at ?? r.created_at

  return {
    found: r.found !== false,
    displayName: str(agent.display_name) ?? str(r.display_name),
    agentId: str(agent.agent_id) ?? str(r.agent_id),
    walletId: str(agent.wallet_id) ?? str(r.wallet_id),
    address: str(agent.address) ?? str(r.address),
    linked: typeof linkedRaw === 'boolean' ? linkedRaw : null,
    createdAt: typeof created === 'number' || typeof created === 'string' ? created : null,
    receipts: num(prov.pe_count) ?? num(r.pe_count),
    activeDays: num(prov.active_days),
    firstReceiptAt: num(prov.first_pe_at),
    families: Object.keys(counts(prov.families)).length ? counts(prov.families) : counts(r.pe_families),
    witnessed: Object.keys(counts(prov.attestation_tiers)).length
      ? counts(prov.attestation_tiers)
      : counts(r.attestation_tiers),
    vouches: num(vouches?.count) ?? num(r.vouches),
    transfers: num(dict(fin.verified_transfers)?.count) ?? num(legacyChain.transfers),
    x402: num(dict(fin.x402)?.settlements_observed) ?? num(legacyChain.x402_settlements),
    bonded: typeof bond?.bonded === 'boolean' ? bond.bonded : bond && str(bond.status) ? true : null,
    courtClaims: num(claims?.total) ?? num(court.cases),
    promises: counts({
      issued: dict(r.promises)?.issued,
      settled: dict(r.promises)?.settled ?? dict(r.promises)?.fulfilled,
      defaulted: dict(r.promises)?.defaulted ?? dict(r.promises)?.broken,
    }),
  }
}

export type AgentRecordFetch =
  | { ok: true; raw: unknown; view: AgentRecordView }
  | { ok: false; reason: 'not-found' | 'error'; status?: number }

export async function fetchAgentRecord(id: string, signal?: AbortSignal): Promise<AgentRecordFetch> {
  try {
    const res = await fetch(`${AGENT_API_BASE}/v1/agents/${encodeURIComponent(id)}/record`, { signal })
    if (res.status === 404) return { ok: false, reason: 'not-found', status: 404 }
    if (!res.ok) return { ok: false, reason: 'error', status: res.status }
    const raw: unknown = await res.json()
    const view = readAgentRecord(raw)
    if (!view.found) return { ok: false, reason: 'not-found', status: 404 }
    return { ok: true, raw, view }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
