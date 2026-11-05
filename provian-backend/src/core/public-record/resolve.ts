/**
 * Public-record subject resolution (beneficiary routing/bond lifecycle, agent-first launch).
 *
 * Resolves the :id / :address a public caller supplies to an agent-wallet
 * subject. Accepted forms, in order:
 * 1. an EVM address (0x + 40 hex) — matched against the agent's NATIVE
 * sovereign wallet address, then against PROVEN external addresses
 * (the one-address-one-agent link minted by /v1/agent/external-address);
 * 2. anything else — the agent-profile identifier resolution (wallet id,
 * provisional id, agent_id, display_name).
 *
 * Privacy boundary: HUMAN wallets are NEVER resolvable here. An address that
 * belongs to a human wallet resolves to "not found" humans did not opt into
 * a public reputation surface by creating a wallet; agents did by signing up
 * to a public agent economy (and, for external addresses, by signing an
 * explicit link consent). Do not add a `wallets` (human) lookup to this file.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  resolveIdentifier,
  resolvedFromAgentWallet,
  type ResolvedIdentifier,
} from '../../routes/agent-profile';
import { getProvenAddress } from '../external-address/link';
import { isExcludedFromPublicDisplay } from '../commons/public-visibility';

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface PublicExternalLink {
  /** The proven external address (lowercase). */
  address: string;
  proven_at: number | null;
  chain: string | null;
  /** Read-only reputation tier assigned at proof time (prior history mints 0). */
  initial_reputation_tier: string | null;
}

export interface RecordSubject {
  found: boolean;
  /** How the identifier matched: informs the caller which key they hit. */
  matched_by:
    | 'wallet_id'
    | 'identifier'
    | 'native_address'
    | 'proven_external_address'
    | null;
  resolved: ResolvedIdentifier | null;
  /** Agent-wallet doc creation time (ms), when known. */
  createdAt: number | null;
  platform: string | null;
  status: string | null;
  /** Proven external link, when one exists for this agent (public by consent). */
  externalLink: PublicExternalLink | null;
}

function notFound(): RecordSubject {
  return {
    found: false,
    matched_by: null,
    resolved: null,
    createdAt: null,
    platform: null,
    status: null,
    externalLink: null,
  };
}

interface AgentWalletDocLike {
  id?: string;
  created_at?: number;
  platform?: string;
  status?: string;
}

function timestampMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Load the proven external link for an agent wallet, if any. proven_addresses
 * is keyed by ADDRESS (doc id = lowercase address), so the reverse lookup is a
 * where() on wallet_id / agent_id. One address per agent by protocol rule.
 * Exposes ONLY the public-by-consent fields — never signature_hash or
 * baseline_nonce.
 */
export async function loadExternalLinkForAgent(
  db: Firestore,
  walletId: string | null,
  agentId: string | null,
): Promise<PublicExternalLink | null> {
  try {
    for (const [field, value] of [['wallet_id', walletId], ['agent_id', agentId]] as const) {
      if (!value) continue;
      const snap = await db.collection('proven_addresses')
        .where(field, '==', value)
        .limit(1)
        .get();
      if (!snap.empty) {
        const data = snap.docs[0].data() as Record<string, unknown>;
        return {
          address: (optionalString(data.address) ?? snap.docs[0].id).toLowerCase(),
          proven_at: timestampMs(data.proven_at_ms),
          chain: optionalString(data.chain),
          initial_reputation_tier: optionalString(data.initial_reputation_tier),
        };
      }
    }
    return null;
  } catch (error) {
    console.warn('[PublicRecord] external link lookup unavailable:', error);
    return null;
  }
}

async function loadAgentWalletMeta(
  db: Firestore,
  walletId: string | null,
): Promise<{ createdAt: number | null; platform: string | null; status: string | null }> {
  if (!walletId) return { createdAt: null, platform: null, status: null };
  try {
    const doc = await db.collection('agent_wallets').doc(walletId).get();
    if (!doc.exists) return { createdAt: null, platform: null, status: null };
    const data = doc.data() as AgentWalletDocLike;
    return {
      createdAt: timestampMs(data.created_at),
      platform: optionalString(data.platform),
      status: optionalString(data.status),
    };
  } catch {
    return { createdAt: null, platform: null, status: null };
  }
}

async function resolveByAddress(
  db: Firestore,
  address: string,
): Promise<{ resolved: ResolvedIdentifier; matchedBy: 'native_address' | 'proven_external_address' } | null> {
  const lower = address.toLowerCase();

  // Native sovereign agent wallet — agent_wallets.address is stored lowercase.
  const nativeSnap = await db.collection('agent_wallets')
    .where('address', '==', lower)
    .limit(1)
    .get();
  if (!nativeSnap.empty) {
    const doc = nativeSnap.docs[0];
    if (isExcludedFromPublicDisplay(doc.data())) return null;
    return {
      resolved: resolvedFromAgentWallet(doc.id, (doc.data() ?? {}) as Record<string, unknown>),
      matchedBy: 'native_address',
    };
  }

  // Proven external address — proven_addresses doc id IS the lowercase address.
  const proven = await getProvenAddress(db, lower);
  if (proven) {
    // wallet_id is the native agent wallet id when one exists (else agent_id).
    const byWalletId = await db.collection('agent_wallets').doc(proven.wallet_id).get();
    if (byWalletId.exists) {
      if (isExcludedFromPublicDisplay(byWalletId.data())) return null;
      return {
        resolved: resolvedFromAgentWallet(
          byWalletId.id,
          (byWalletId.data() ?? {}) as Record<string, unknown>,
        ),
        matchedBy: 'proven_external_address',
      };
    }
    const byAgentId = await db.collection('agent_wallets')
      .where('agent_id', '==', proven.agent_id)
      .limit(1)
      .get();
    if (!byAgentId.empty) {
      const doc = byAgentId.docs[0];
      if (isExcludedFromPublicDisplay(doc.data())) return null;
      return {
        resolved: resolvedFromAgentWallet(doc.id, (doc.data() ?? {}) as Record<string, unknown>),
        matchedBy: 'proven_external_address',
      };
    }
  }

  return null;
}

/**
 * Resolve a public record identifier (wallet id, agent_id, display name, or
 * EVM address) to an agent-wallet subject. Agent wallets only — see the
 * privacy boundary note at the top of this file.
 */
export async function resolveRecordSubject(
  db: Firestore,
  identifier: string,
): Promise<RecordSubject> {
  let resolved: ResolvedIdentifier | null = null;
  let matchedBy: RecordSubject['matched_by'] = null;

  if (EVM_ADDRESS_PATTERN.test(identifier)) {
    const byAddress = await resolveByAddress(db, identifier);
    if (!byAddress) return notFound();
    resolved = byAddress.resolved;
    matchedBy = byAddress.matchedBy;
  } else {
    resolved = await resolveIdentifier(db, identifier);
    matchedBy = identifier.startsWith('wallet_aw_') ? 'wallet_id' : 'identifier';
  }

  if (!resolved || resolved.type === 'not_found') return notFound();

  const [meta, externalLink] = await Promise.all([
    loadAgentWalletMeta(db, resolved.walletId),
    loadExternalLinkForAgent(db, resolved.walletId, resolved.agentId),
  ]);

  return {
    found: true,
    matched_by: matchedBy,
    resolved,
    createdAt: meta.createdAt,
    platform: meta.platform,
    status: meta.status,
    externalLink,
  };
}
