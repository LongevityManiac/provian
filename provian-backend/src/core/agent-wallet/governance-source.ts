/**
 * PE METER — the pointer from an agent wallet's governance settings to the
 * identity act that set them.
 *
 * Before the meter, credential recovery proved `agent_wallets/{id}.governance` by REPLAYING every
 * `policy_updated` (`agent_governance_settings`) PE in the agent's whole chain. The relay no longer
 * keeps an actor's chain, and no read may grow with history, so the governance route now records,
 * in the same transaction that writes the wallet's new governance and seals its `policy_updated`
 * identity act, a one-document pointer naming that act (id + hash) and the governance it set.
 * Recovery validates the wallet against that ONE act: bounded per actor, one point read.
 *
 * A wallet with no pointer has never changed its governance since the meter: its governance must
 * then equal the registration's. (A wallet whose governance changed BEFORE the meter carries no
 * pointer until the legacy migration writes one from its envelope history; until then it fails
 * closed rather than being trusted.)
 */

import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { AgentGovernanceSettings } from './types';

export const AGENT_GOVERNANCE_SOURCE_COLLECTION = 'agent_governance_sources_v1' as const;
export const AGENT_GOVERNANCE_SOURCE_SCHEMA = 'agent-governance-source/v1' as const;

const PE_ID = /^pe_[A-Za-z0-9_-]{1,240}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GOVERNANCE_KEYS = Object.freeze([
  'pe_coverage_enabled',
  'attestation_enabled',
  'human_oversight_enabled',
  'spending_limits_enabled',
  'full_governance',
] as const);
const SOURCE_KEYS = Object.freeze([
  'schema_version', 'wallet_id', 'agent_id', 'source_pe_id', 'source_pe_hash',
  'governance', 'updated_at_ms',
] as const);

export interface AgentGovernanceSourceDocument {
  readonly schema_version: typeof AGENT_GOVERNANCE_SOURCE_SCHEMA;
  readonly wallet_id: string;
  readonly agent_id: string;
  readonly source_pe_id: string;
  readonly source_pe_hash: string;
  readonly governance: AgentGovernanceSettings;
  readonly updated_at_ms: number;
}

export class AgentGovernanceSourceError extends Error {
  constructor(readonly reason: string) {
    super(`agent_governance_source:${reason}`);
    this.name = 'AgentGovernanceSourceError';
  }
}

function fail(reason: string): never {
  throw new AgentGovernanceSourceError(reason);
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(raw).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

/** True for a well-formed governance settings object (exact keys, booleans, full_governance false). */
export function isAgentGovernanceSettings(value: unknown): value is AgentGovernanceSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return exactKeys(raw, GOVERNANCE_KEYS)
    && GOVERNANCE_KEYS.every((key) => typeof raw[key] === 'boolean')
    && raw.full_governance === false;
}

export function agentGovernanceSourceRef(db: Firestore, walletId: string): DocumentReference {
  return db.collection(AGENT_GOVERNANCE_SOURCE_COLLECTION).doc(walletId);
}

export function createAgentGovernanceSourceDocument(params: {
  readonly walletId: string;
  readonly agentId: string;
  readonly sourcePeId: string;
  readonly sourcePeHash: string;
  readonly governance: AgentGovernanceSettings;
  readonly updatedAtMs: number;
}): AgentGovernanceSourceDocument {
  return {
    schema_version: AGENT_GOVERNANCE_SOURCE_SCHEMA,
    wallet_id: params.walletId,
    agent_id: params.agentId,
    source_pe_id: params.sourcePeId,
    source_pe_hash: params.sourcePeHash,
    governance: { ...params.governance },
    updated_at_ms: params.updatedAtMs,
  };
}

/** Parse a stored pointer; throws `AgentGovernanceSourceError` on any malformation. */
export function parseAgentGovernanceSource(raw: unknown): AgentGovernanceSourceDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('shape');
  const doc = raw as Record<string, unknown>;
  if (!exactKeys(doc, SOURCE_KEYS)) fail('keys');
  if (doc.schema_version !== AGENT_GOVERNANCE_SOURCE_SCHEMA
    || typeof doc.wallet_id !== 'string' || doc.wallet_id.length === 0
    || typeof doc.agent_id !== 'string' || doc.agent_id.length === 0
    || typeof doc.source_pe_id !== 'string' || !PE_ID.test(doc.source_pe_id)
    || typeof doc.source_pe_hash !== 'string' || !SHA256.test(doc.source_pe_hash)
    || !isAgentGovernanceSettings(doc.governance)
    || !Number.isSafeInteger(doc.updated_at_ms) || (doc.updated_at_ms as number) < 0) {
    fail('fields');
  }
  return doc as unknown as AgentGovernanceSourceDocument;
}
