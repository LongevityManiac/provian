/**
 * Agent Bank - Agent Directory
 *
 * Discovery layer for agent-to-agent interactions. Agents register
 * capabilities, availability, and rates. Other agents can browse
 * and filter the directory to find collaborators.
 *
 * Firestore collection: agent_directory/ (keyed by wallet_id for upsert)
 */

import {
  SAFETY_LIMITS,
  type AgentBankDeps,
  type AgentDirectoryDocument,
  type RegisterCapabilitiesRequest,
} from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { ValidationError, NotFoundError } from './errors';
import { generatePE } from './pe-utils';
import { countVisibleAgentPEs } from '../agent-wallet/agent-pe-activity';
import { isTestPlatformWallet } from '../pvt/genesis-award-state-machine';
import { isExcludedFromPublicDisplay } from '../commons/public-visibility';

/**
 * Register or update agent capabilities in the directory.
 * Upserts by wallet_id.
 */
export async function registerCapabilities(
  deps: AgentBankDeps,
  walletId: string,
  wallet: AgentWalletDocument,
  body: RegisterCapabilitiesRequest,
): Promise<AgentDirectoryDocument> {
  if (isTestPlatformWallet(wallet)) {
    throw new ValidationError('test_platform_excluded');
  }
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    throw new ValidationError('capabilities must be a non-empty array');
  }
  if (body.capabilities.length > SAFETY_LIMITS.MAX_CAPABILITIES_COUNT) {
    throw new ValidationError(`Maximum ${SAFETY_LIMITS.MAX_CAPABILITIES_COUNT} capabilities`);
  }
  for (const cap of body.capabilities) {
    if (typeof cap !== 'string' || cap.length > 64) {
      throw new ValidationError('Each capability must be a string (max 64 chars)');
    }
  }
  if (!body.description || body.description.length > 1000) {
    throw new ValidationError('description is required (max 1000 chars)');
  }
  if (!['available', 'busy', 'offline'].includes(body.availability)) {
    throw new ValidationError('availability must be available, busy, or offline');
  }
  // hourly_rate_usdc ceiling is tied to V3 escrow safety limits (MAX_ESCROW_AMOUNT_USD),
  // not an arbitrary input cap - it lifts when those safety limits lift.
  if (body.hourly_rate_usdc !== undefined && (body.hourly_rate_usdc < 0 || body.hourly_rate_usdc > 10000)) {
    throw new ValidationError('hourly_rate_usdc must be between 0 and 10000');
  }

  // PVT is arbitrary-precision: BigInt has no overflow, and any numeric ceiling
  // here would be an invented policy rather than a technical constraint. Validate
  // well-formedness (non-negative integer string) and stop there - the market
  // handles the rest.
  let hourlyRatePvtWei: bigint | null = null;
  if (body.hourly_rate_pvt !== undefined && body.hourly_rate_pvt !== null && body.hourly_rate_pvt !== '') {
    if (typeof body.hourly_rate_pvt !== 'string' || !/^[0-9]+$/.test(body.hourly_rate_pvt)) {
      throw new ValidationError('hourly_rate_pvt must be a non-negative integer string (BigInt 18d)');
    }
    hourlyRatePvtWei = BigInt(body.hourly_rate_pvt);
  }

  const now = Date.now();

  const doc: AgentDirectoryDocument = {
    wallet_id: walletId,
    agent_id: wallet.agent_id,
    display_name: wallet.display_name,
    address: wallet.address,
    capabilities: body.capabilities,
    description: body.description,
    availability: body.availability,
    hourly_rate_usdc: body.hourly_rate_usdc,
    preferred_chains: body.preferred_chains || wallet.chains,
    // live visible-PE count, never a stored per-wallet tally.
    pe_count: await countVisibleAgentPEs(deps.db, wallet.agent_id),
    created_at: now,
    updated_at: now,
  };
  if (hourlyRatePvtWei !== null) {
    doc.hourly_rate_pvt = hourlyRatePvtWei.toString();
  }

  // Upsert - check if existing
  const existingDoc = await deps.db.collection('agent_directory').doc(walletId).get();
  if (existingDoc.exists) {
    const existing = existingDoc.data() as AgentDirectoryDocument;
    doc.created_at = existing.created_at;
  }

  await deps.db.collection('agent_directory').doc(walletId).set(doc);

  await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'agent_capabilities_registered',
    metadata: {
      capabilities: body.capabilities,
      availability: body.availability,
    },
  });

  return doc;
}

/**
 * Browse the agent directory with optional filters.
 */
export async function browseDirectory(
  deps: AgentBankDeps,
  filters: {
    capability?: string;
    availability?: string;
    min_pe_count?: number;
    limit?: number;
    offset?: number;
  },
): Promise<AgentDirectoryDocument[]> {
  const limit = Math.min(filters.limit || 50, 100);
  const offset = filters.offset || 0;

  let query: FirebaseFirestore.Query = deps.db.collection('agent_directory');

  if (filters.capability) {
    query = query.where('capabilities', 'array-contains', filters.capability);
  }

  if (filters.availability && ['available', 'busy', 'offline'].includes(filters.availability)) {
    query = query.where('availability', '==', filters.availability);
  }

  query = query.limit(limit).offset(offset);

  const snap = await query.get();
  let results = snap.docs.map((doc) => doc.data() as AgentDirectoryDocument);

  // Defense in depth for any directory row created before the writer gate:
  // public discovery must resolve the authoritative agent-wallet marker and
  // fail closed on a missing/test wallet. New test rows are refused above.
  const publicFlags = await Promise.all(results.map(async (entry) => {
    const walletDoc = await deps.db.collection('agent_wallets').doc(entry.wallet_id).get();
    return walletDoc.exists && !isExcludedFromPublicDisplay(walletDoc.data());
  }));
  results = results.filter((_entry, index) => publicFlags[index]);

  // Post-filter min_pe_count (can't combine multiple inequality filters in Firestore)
  if (filters.min_pe_count !== undefined) {
    results = results.filter((d) => d.pe_count >= filters.min_pe_count!);
  }

  return results;
}

/**
 * Get a single agent directory profile, enriched with live wallet stats.
 */
export async function getDirectoryProfile(
  deps: AgentBankDeps,
  walletId: string,
): Promise<AgentDirectoryDocument> {
  const dirDoc = await deps.db.collection('agent_directory').doc(walletId).get();
  if (!dirDoc.exists) {
    throw new NotFoundError('Agent not found in directory');
  }

  const profile = dirDoc.data() as AgentDirectoryDocument;

  // Enrich with the live visible-PE count (never a stored per-wallet tally).
  const walletDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  if (!walletDoc.exists || isExcludedFromPublicDisplay(walletDoc.data())) {
    throw new NotFoundError('Agent not found in directory');
  }
  const wallet = walletDoc.data() as AgentWalletDocument;
  profile.pe_count = await countVisibleAgentPEs(deps.db, wallet.agent_id);

  return profile;
}
