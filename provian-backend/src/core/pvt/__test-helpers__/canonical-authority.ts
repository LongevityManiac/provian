/**
 * Canonical native-wallet authorities as registration writes them (wallet row, birth identity
 * act, chain tip, address index, registration index, inbound admission) — the watcher
 * enumeration suites' fixtures, shared so the registry-mode suites seed the same rows.
 */
import { createFakeFirestore } from './fake-firestore';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
} from '../native-wallet-registration';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  watcherAddressAdmissionDocId,
} from '../watcher-address-admission';
import { canonicalAgentPeHash } from '../../agent-wallet/canonical-agent-pe-chain';

export function seedCanonicalAgentAuthority(args: {
  db: ReturnType<typeof createFakeFirestore>;
  walletId: string;
  agentId: string;
  address: string;
  observedHead: number;
  createdAt?: number;
  platform?: string;
}): Record<string, unknown> {
  const createdAt = args.createdAt ?? 1;
  const fence = createNativeWalletRegistrationFence(args.observedHead);
  const wallet = {
    id: args.walletId,
    agent_id: args.agentId,
    address: args.address,
    platform: args.platform ?? 'sdk',
    created_at: createdAt,
    native_watcher_registration: fence,
  };
  const birthPeId = `pe_${args.agentId}`;
  const birthCanonical = {
    id: birthPeId,
    wallet_id: args.walletId,
    agent_id: args.agentId,
    action_type: 'agent_wallet_created',
    actor_address: args.address,
    timestamp: createdAt,
    prev_hash: '0x0000',
    attestation_type: 'software',
    metadata: { platform: args.platform ?? 'sdk' },
    compute: null,
    geo: null,
    execution_env: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
  };
  const birthHash = canonicalAgentPeHash(birthCanonical);
  args.db.store.set(`agent_wallets/${args.walletId}`, wallet);
  args.db.store.set(`identity_pes_legacy_v1/${birthPeId}`, {
    ...birthCanonical,
    hash: birthHash,
    user_id: args.agentId,
    policy_action_type: 'wallet_created',
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null,
    counterparty_type: null,
    session_lineage: null,
    self_referencing: false,
    trust_level_at_creation: null,
    created_at: createdAt,
    durability: 'final',
  });
  args.db.store.set(`pe_chain_tips/${args.agentId}`, {
    hash: birthHash,
    user_id: args.agentId,
    updated_at: createdAt,
  });
  args.db.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/address_${args.walletId}`,
    {
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453,
      address: args.address,
      wallet_id: args.walletId,
      owner_type: 'agent',
      owner_id: args.agentId,
      created_at_ms: createdAt,
    },
  );
  args.db.store.set(
    `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/agent_${args.agentId}`,
    {
      schema_version: 'native-agent-registration/v1',
      registration_id: `registration-${args.agentId}`,
      request_fingerprint_sha256: '1'.repeat(64),
      agent_id: args.agentId,
      address: args.address,
      wallet_id: args.walletId,
      pe_id: birthPeId,
      pe_hash: birthHash,
      api_key_prefix: 'pvn_live_123456789abcdef',
      created_at_ms: createdAt,
      credential_recovery_generation: 0,
      updated_at_ms: createdAt,
    },
  );
  const target = {
    direction: 'inbound' as const,
    chainId: 8453,
    address: args.address,
    walletId: args.walletId,
    agentId: args.agentId,
    eligibilityStartBlock: fence.eligibility_start_block,
  };
  args.db.store.set(
    `${WATCHER_ADDRESS_ADMISSION_COLLECTION}/${watcherAddressAdmissionDocId(target)}`,
    {
      schema_version: 'pvt-watcher-address-admission/v3',
      direction: 'inbound',
      chain_id: 8453,
      address: args.address,
      wallet_id: args.walletId,
      agent_id: args.agentId,
      eligibility_start_block: fence.eligibility_start_block,
      state: 'live',
      backfill_next_block: fence.eligibility_start_block,
      catch_up_through_block: fence.eligibility_start_block - 1,
      membership_generation: 1,
      generation_fenced_at_registration: true,
      revision: 1,
      created_at_ms: createdAt,
      updated_at_ms: createdAt,
    },
  );
  return wallet;
}

export function seedCanonicalHumanAuthority(args: {
  db: ReturnType<typeof createFakeFirestore>;
  walletId: string;
  userId: string;
  address: string;
  observedHead: number;
  createdAt?: number;
  platform?: string;
}): Record<string, unknown> {
  const createdAt = args.createdAt ?? 1;
  const fence = createNativeWalletRegistrationFence(args.observedHead);
  const wallet: Record<string, unknown> = {
    id: args.walletId,
    type: 'human',
    user_id: args.userId,
    evm_address: args.address,
    created_at: createdAt,
    native_watcher_registration: fence,
    ...(args.platform !== undefined ? { platform: args.platform } : {}),
  };
  args.db.store.set(`wallets/${args.walletId}`, wallet);
  args.db.store.set(
    `human_wallet_registration_by_user_v1/${args.userId}`,
    {
      schema_version: 'human-wallet-registration/v2',
      user_id: args.userId,
      request_fingerprint: '2'.repeat(64),
      wallet_id: args.walletId,
      pe_id: `pe_human_${args.userId}`,
      pe_hash: '3'.repeat(64),
      prev_hash: 'genesis',
      address: args.address,
      public_key_sha256: '4'.repeat(64),
      economic_device_id: `device-${args.userId}`,
      created_at_ms: createdAt,
      genesis_qualification_id: `gq-${args.userId}`,
      standard_accrual_status: 'complete',
      standard_accrual_acknowledged_at_ms: createdAt,
    },
  );
  args.db.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/address_${args.walletId}`,
    {
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453,
      address: args.address,
      wallet_id: args.walletId,
      owner_type: 'human',
      owner_id: args.userId,
      created_at_ms: createdAt,
    },
  );
  const target = {
    direction: 'inbound' as const,
    chainId: 8453,
    address: args.address,
    walletId: args.walletId,
    agentId: args.userId,
    eligibilityStartBlock: fence.eligibility_start_block,
  };
  args.db.store.set(
    `${WATCHER_ADDRESS_ADMISSION_COLLECTION}/${watcherAddressAdmissionDocId(target)}`,
    {
      schema_version: 'pvt-watcher-address-admission/v3',
      direction: 'inbound',
      chain_id: 8453,
      address: args.address,
      wallet_id: args.walletId,
      agent_id: args.userId,
      eligibility_start_block: fence.eligibility_start_block,
      state: 'live',
      backfill_next_block: fence.eligibility_start_block,
      catch_up_through_block: fence.eligibility_start_block - 1,
      membership_generation: 1,
      generation_fenced_at_registration: true,
      revision: 1,
      created_at_ms: createdAt,
      updated_at_ms: createdAt,
    },
  );
  return wallet;
}
