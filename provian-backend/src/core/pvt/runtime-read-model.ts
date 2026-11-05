/** Published product facts. Consumers read the relay's policy and chain answers;
 * none of these fields grants execution authority or reprices a sealed act. */
import type { Firestore } from 'firebase-admin/firestore';
import { PVT9_BASE_CONFIG } from './pvt9-base-config.generated';
import { DEPLOYED_TREE_GIT_HEAD } from './tree-stamp.generated';
import { PROPOSED_ACTION_POLICY_ENTRIES, PROPOSED_ACTION_POLICY_MANIFEST } from './policy/proposed-action-policy';
import { hashProposedMonetaryPolicyTemplate } from './policy/proposed-monetary-policy';
import { WITNESS_CLASSES, classAdmissionProfile, PROPOSED_EVIDENCE_CLASS_BASES_BPS } from './policy/evidence-class';
import { genesisArmedWindow } from './genesis-award-state-machine';
import { readPvt9SettlementFactors } from './pvt9-settlement-factors';
import { evaluateCapClock } from './wp4/cap-clock';
import { readCapClockObservation } from './wp4/settlement-chain-adapter';
import { resolvePvt9Target } from './wp4/operator-runtime';
import { projectEarningTypes } from './policy/earning-type-projection';
import { cache } from '../../cache';
import { readConsoleCounters } from '../observability/request-counters';
import { computeAddress } from 'ethers';
import fs from 'fs';
import path from 'path';
import { publishRuntimePages, cleanRuntimePages } from './runtime-read-model-pages';

export const RUNTIME_READ_MODEL_COLLECTION = 'pvt_runtime_read_model_v1';
export const RUNTIME_READ_MODEL_DOCUMENT = 'current';

export interface RuntimeGasWalletState { configured: boolean; address: string | null; error: string | null; }
/** Public identities only. A malformed configured key remains an alarm, never an absent wallet. */
export function publicRuntimeGasWallets(env: Readonly<Record<string, string | undefined>>): Record<string, RuntimeGasWalletState> {
  const states: Record<string, RuntimeGasWalletState> = {};
  const roles: Readonly<Record<string, string>> = {
    settlement_minter: 'PVT9_SETTLEMENT_MINTER_KEY', settlement_approver: 'PVT9_SETTLEMENT_APPROVER_KEY',
    escrow_keeper: 'ESCROW_RELEASE_KEY', pool_keeper: 'POOL_KEEPER_KEY',
    bond_keeper: 'BOND_KEEPER_KEY', payout_gas: 'PAYOUT_BASE_GAS_KEY',
  };
  for (const [role, name] of Object.entries(roles)) {
    const key = env[name]?.trim();
    let address: string | null = null;
    try { address = key ? computeAddress(key).toLowerCase() : null; }
    catch { /* Never copy a crypto-library error that might contain the key. */ }
    states[role] = { configured: Boolean(key), address, error: key && address === null ? 'invalid_runtime_key' : null };
  }
  return states;
}

/** Emit canonical answers beside the relay's existing product status counters. */
export async function publishRuntimeReadModel(db: Firestore): Promise<void> {
  const observedAt = Date.now();
  let capClock: ReturnType<typeof evaluateCapClock> | null = null;
  try { capClock = evaluateCapClock(await readCapClockObservation(resolvePvt9Target(process.env))); }
  catch { /* Unknown is represented explicitly; consumers cannot manufacture a verdict. */ }
  const factors = await readPvt9SettlementFactors();
  const gasWalletStates = publicRuntimeGasWallets(process.env);
  const gasWalletAddresses = Object.fromEntries(Object.entries(gasWalletStates).map(([role, state]) => [role, state.address]));
  const projection = await projectEarningTypes(db, observedAt);
  const pages = await publishRuntimePages(db, observedAt, {
    action_policy_entries: PROPOSED_ACTION_POLICY_ENTRIES,
    earning_type_projection: projection.types,
  });
  const { entries: _entries, ...manifestMetadata } = PROPOSED_ACTION_POLICY_MANIFEST;
  const { types: _types, ...projectionMetadata } = projection;
  const root = {
    schema: 'provian.runtime-read-model/v1',
    observed_at_ms: observedAt,
    cache_stats: cache.getStats(),
    request_counters: readConsoleCounters(observedAt),
    gas_wallet_addresses: gasWalletAddresses,
    gas_wallet_states: gasWalletStates,
    scheduler_manifest: JSON.parse(fs.readFileSync(path.join(__dirname, '../../../scheduler-jobs.json'), 'utf8')) as unknown,
    scheduler_source_paths: JSON.parse(fs.readFileSync(path.join(__dirname, '../../scheduler-source-paths.json'), 'utf8')) as unknown,
    deployed_tree_git_head: DEPLOYED_TREE_GIT_HEAD,
    kernel_address: PVT9_BASE_CONFIG.assets.pvt9.address,
    pages,
    action_policy_manifest: manifestMetadata,
    template_digest: hashProposedMonetaryPolicyTemplate(),
    earning_type_projection: projectionMetadata,
    genesis_window: genesisArmedWindow(),
    settlement_factors: factors,
    cap_clock: capClock,
    witness_classes: WITNESS_CLASSES.map((witnessClass) => ({
      class: witnessClass, base_bps: PROPOSED_EVIDENCE_CLASS_BASES_BPS[witnessClass],
      profile: classAdmissionProfile(witnessClass),
    })),
  };
  const ref = db.collection(RUNTIME_READ_MODEL_COLLECTION).doc(RUNTIME_READ_MODEL_DOCUMENT);
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if ((previous.data()?.observed_at_ms ?? -1) > observedAt) return;
    tx.set(ref, root);
  });
  await cleanRuntimePages(db, observedAt).catch(() => console.warn('[runtime-read-model] derived page cleanup failed'));
}
