/** Public records resolve only an agent's published native wallet or public
 * profile identifier. Private address proofs never expose another address,
 * resolve back to a public identity, or become public through an earning link.
 * Human wallets are not public-record subjects. */

import type { Firestore } from 'firebase-admin/firestore';
import {
  resolveIdentifier,
  resolvedFromAgentWallet,
  type ResolvedIdentifier,
} from '../../routes/agent-profile';
import { isExcludedFromPublicDisplay } from '../commons/public-visibility';

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface RecordSubject {
  found: boolean;
  /** How the identifier matched: informs the caller which key they hit. */
  matched_by:
    | 'wallet_id'
    | 'identifier'
    | 'native_address'
    | null;
  resolved: ResolvedIdentifier | null;
  /** Agent-wallet doc creation time (ms), when known. */
  createdAt: number | null;
  platform: string | null;
  status: string | null;
}

function notFound(): RecordSubject {
  return {
    found: false,
    matched_by: null,
    resolved: null,
    createdAt: null,
    platform: null,
    status: null,
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
): Promise<{ resolved: ResolvedIdentifier; matchedBy: 'native_address' } | null> {
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

  const meta = await loadAgentWalletMeta(db, resolved.walletId);

  return {
    found: true,
    matched_by: matchedBy,
    resolved,
    createdAt: meta.createdAt,
    platform: meta.platform,
    status: meta.status,
  };
}
