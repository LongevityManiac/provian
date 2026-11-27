/**
 * Push discovery (Alchemy address-activity webhooks): a delivery queues exactly the pointer the
 * rotating scans would have queued, only under the webhook's own signature, only for watched
 * addresses; the sync registers every watched address once. Every guard ships with the RED case
 * that differs from its GREEN case in one fact.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  ADDRESS_ACTIVITY_MEMBERS_COLLECTION,
  AddressActivityDeliveryError,
  AddressActivitySigningKeys,
  addressActivitySignatureValid,
  handleAddressActivityDelivery,
  syncAddressActivityWebhooks,
  type AlchemyNotifyApi,
  type AlchemyWebhook,
} from './address-activity-push';
import { CHAIN_RECORD_OBSERVATIONS_COLLECTION, chainRecordObservationId, provenObservationWalletId } from './chain-record-watcher';
import { CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from './native-wallet-registration';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { base58Encode } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  SOLANA_PROVEN_ADDRESS_SCHEMA,
  createSolanaProofEvidence,
  type SolanaProvenAddressRecord,
} from '../external-address/solana-link';
import { SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION, solanaChainRecordObservationId } from './solana-chain-record-lane';

const WATCHED = '0xa11ce00000000000000000000000000000000001';
const PROVEN = '0xb0b0000000000000000000000000000000000002';
const STRANGER = '0xc0ffee0000000000000000000000000000000003';
const TX1 = `0x${'11'.repeat(32)}`;
const TX2 = `0x${'22'.repeat(32)}`;
const NOW = 1_900_000_000_000;
const KEY = 'whsec_test_signing_key';

const webhook = (id: string, network: string): AlchemyWebhook => ({ id, network, signingKey: KEY, url: 'https://relay.test/hook', isActive: true, type: 'ADDRESS_ACTIVITY' });
const sign = (body: string, key = KEY): string => crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
const solAddr = (): string => base58Encode(crypto.randomBytes(32));
const solSig = (): string => base58Encode(crypto.randomBytes(64));

let db: FakeFirestore;
let api: jest.Mocked<AlchemyNotifyApi>;
let keys: AddressActivitySigningKeys;

function apiWith(hooks: AlchemyWebhook[]): jest.Mocked<AlchemyNotifyApi> {
  let n = 0;
  return {
    listWebhooks: jest.fn(async () => hooks),
    createWebhook: jest.fn(async ({ network }) => { n += 1; const w = webhook(`wh_new_${n}`, network); hooks.push(w); return w; }),
    addAddresses: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<AlchemyNotifyApi>;
}

function seedNative(address: string, walletId: string): void {
  db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(address)}`, {
    schema_version: CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA, chain_id: 8453, address, wallet_id: walletId,
    owner_type: 'agent', owner_id: `agent-${walletId}`, created_at_ms: 1,
  });
  db.store.set(`agent_wallets/${walletId}`, { id: walletId, platform: 'sdk' });
}

function seedSolana(address: string): void {
  const evidence = createSolanaProofEvidence({ challengeId: crypto.randomUUID(), challengeMessage: 'm', signature: solSig(), verifiedAtMs: 1 });
  const record: SolanaProvenAddressRecord = {
    schema_version: SOLANA_PROVEN_ADDRESS_SCHEMA, address, chain: 'solana',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', owner_type: 'human', agent_id: null, user_id: 'u1',
    wallet_id: 'w1', owner_evm_address: '0xcccc00000000000000000000000000000000000c', origin: 'native',
    proven_at_ms: 1, proven_at_slot: 400_000_000, proof_method: 'ed25519', signature_hash: evidence.signature_sha256,
    proof_evidence: evidence, created_at: 1,
  };
  db.store.set(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${address}`, { ...record });
}

function evmBody(activity: unknown[], network = 'ARB_MAINNET', webhookId = 'wh_arb'): string {
  return JSON.stringify({ webhookId, id: 'whevt_1', createdAt: '2026-11-27T00:00:00Z', type: 'ADDRESS_ACTIVITY', event: { network, activity } });
}

const transfer = (hash: string, from: string, to: string, category = 'erc20') =>
  ({ blockNum: '0x10', hash, fromAddress: from, toAddress: to, category, value: 1, asset: 'USDC' });

beforeEach(() => {
  db = createFakeFirestore();
  api = apiWith([webhook('wh_arb', 'ARB_MAINNET'), webhook('wh_sol', 'SOLANA_MAINNET')]);
  keys = new AddressActivitySigningKeys(api, () => NOW);
  seedNative(WATCHED, 'wallet_watched');
});

describe('delivery signature', () => {
  it('a delivery signed with the webhook key queues; RED: one byte of body changed after signing is refused and queues nothing', async () => {
    const body = evmBody([transfer(TX1, STRANGER, WATCHED)]);
    const ok = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(ok.queued).toBe(1);

    const db2 = createFakeFirestore();
    seedNative(WATCHED, 'wallet_watched');
    const tampered = body.replace('0x10', '0x11');
    await expect(handleAddressActivityDelivery(db2 as unknown as Firestore, keys, tampered, sign(body), NOW))
      .rejects.toMatchObject({ status: 401 });
    expect([...db2.store.keys()].filter((k) => k.startsWith(CHAIN_RECORD_OBSERVATIONS_COLLECTION))).toHaveLength(0);
  });

  it('RED: a webhook id the team does not own is refused (401), and a wrong key is refused', async () => {
    const body = evmBody([transfer(TX1, STRANGER, WATCHED)], 'ARB_MAINNET', 'wh_foreign');
    await expect(handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW)).rejects.toBeInstanceOf(AddressActivityDeliveryError);
    expect(addressActivitySignatureValid('x', sign('x', 'other'), KEY)).toBe(false);
    expect(addressActivitySignatureValid('x', sign('x'), KEY)).toBe(true);
    expect(addressActivitySignatureValid('x', 'not-hex', KEY)).toBe(false);
  });

  it('RED: a payload naming another network than its webhook is refused', async () => {
    const body = evmBody([transfer(TX1, STRANGER, WATCHED)], 'OPT_MAINNET', 'wh_arb');
    await expect(handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW))
      .rejects.toMatchObject({ status: 400, message: 'address_activity_network_mismatch' });
  });

  it('an unknown webhook id refreshes the key list at most once a minute (a forged id cannot amplify)', async () => {
    let t = NOW;
    const k = new AddressActivitySigningKeys(api, () => t);
    for (let i = 0; i < 5; i += 1) await k.get('wh_unknown');
    expect(api.listWebhooks).toHaveBeenCalledTimes(1);
    t += 61_000;
    await k.get('wh_unknown');
    expect(api.listWebhooks).toHaveBeenCalledTimes(2);
  });
});

describe('EVM delivery', () => {
  it('queues the scan\'s own pointer for a watched address (one per tx), and nothing for a stranger', async () => {
    const body = evmBody([transfer(TX1, STRANGER, WATCHED), transfer(TX1, STRANGER, WATCHED), transfer(TX2, STRANGER, '0xdead000000000000000000000000000000000004')]);
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(r).toMatchObject({ queued: 1, already_queued: 0 });
    const doc = db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX1, 'wallet_watched', 42161)}`);
    expect(doc).toMatchObject({ source: 'multichain_scan', chain_id: 42161, wallet_id: 'wallet_watched' });
    expect([...db.store.keys()].filter((k) => k.startsWith(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`))).toHaveLength(1);
  });

  it('a transaction the scan already queued is not queued again (same observation id)', async () => {
    const body = evmBody([transfer(TX1, WATCHED, STRANGER, 'external')]);
    await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    const again = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(again).toMatchObject({ queued: 0, already_queued: 1 });
  });

  it('a proven EOA address is queued under its proven id; RED: a contract-proven one is not', async () => {
    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${PROVEN}`, { proof_method: 'eip191_eoa' });
    const body = evmBody([transfer(TX1, STRANGER, PROVEN)]);
    await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(db.store.get(`${CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${chainRecordObservationId(TX1, provenObservationWalletId(PROVEN), 42161)}`)).toBeDefined();

    db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${PROVEN}`, { proof_method: 'eip1271_contract' });
    const body2 = evmBody([transfer(TX2, STRANGER, PROVEN)]);
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body2, sign(body2), NOW);
    expect(r).toMatchObject({ queued: 0 });
  });

  it('RED: categories the scan does not read (an NFT, an internal transfer) and reorged entries queue nothing', async () => {
    const removed = { ...transfer(TX2, STRANGER, WATCHED), log: { removed: true } };
    const body = evmBody([transfer(TX1, STRANGER, WATCHED, 'erc721'), transfer(TX1, STRANGER, WATCHED, 'internal'), removed]);
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(r).toMatchObject({ queued: 0, transactions: 0 });
  });
});

describe('Solana delivery', () => {
  it('queues (signature, address) for each proven address the transaction names; RED: an unproven address queues nothing', async () => {
    const proven = solAddr();
    const stranger = solAddr();
    const signature = solSig();
    seedSolana(proven);
    const body = JSON.stringify({
      webhookId: 'wh_sol', id: 'whevt_s', type: 'ADDRESS_ACTIVITY',
      event: { network: 'SOLANA_MAINNET', slot: 401_000_000, transaction: [{
        signature, is_vote: false, slot: 401_000_000,
        transaction: [{ signatures: [signature], message: [{ account_keys: [stranger, proven] }] }],
        meta: [{ post_token_balances: [{ owner: proven }] }],
      }] },
    });
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(r).toMatchObject({ queued: 1, transactions: 1 });
    expect(db.store.get(`${SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${solanaChainRecordObservationId(signature, proven)}`))
      .toMatchObject({ signature, address: proven, slot: 401_000_000, status: 'pending' });
    expect(db.store.get(`${SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${solanaChainRecordObservationId(signature, stranger)}`)).toBeUndefined();
  });
});

describe('sync', () => {
  const syncDeps = (evm: string[], sol: string[], capacity?: number) => ({
    db: db as unknown as Firestore,
    api,
    webhookUrl: 'https://relay.test/hook',
    evmCandidates: async () => evm,
    solanaCandidates: async () => sol,
    now: () => NOW,
    ...(capacity === undefined ? {} : { capacity }),
  });

  it('registers each watched address once per network, creating a webhook when none exists', async () => {
    api = apiWith([]);
    const sol = solAddr();
    const r = await syncAddressActivityWebhooks(syncDeps([WATCHED, PROVEN], [sol]));
    expect(r.networks.ARB_MAINNET).toMatchObject({ added: 2, webhooks: 1, complete: true });
    expect(r.networks.OPT_MAINNET).toMatchObject({ added: 2, webhooks: 1, complete: true });
    expect(r.networks.SOLANA_MAINNET).toMatchObject({ added: 1, webhooks: 1, complete: true });
    expect(api.createWebhook).toHaveBeenCalledTimes(3);
    expect(db.store.get(`${ADDRESS_ACTIVITY_MEMBERS_COLLECTION}/ARB_MAINNET_${WATCHED}`)).toMatchObject({ webhook_id: 'wh_new_1' });

    // RED for "once": the same candidates again register nothing.
    const again = await syncAddressActivityWebhooks(syncDeps([WATCHED, PROVEN], [sol]));
    expect(again.networks.ARB_MAINNET).toMatchObject({ candidates: 2, added: 0 });
    expect(api.addAddresses).not.toHaveBeenCalled();
  });

  it('a full webhook is not added to: the next address opens a new webhook', async () => {
    api = apiWith([]);
    await syncAddressActivityWebhooks(syncDeps([WATCHED, PROVEN], [], 2));
    const r = await syncAddressActivityWebhooks(syncDeps([WATCHED, PROVEN, STRANGER], [], 2));
    expect(r.networks.ARB_MAINNET).toMatchObject({ added: 1, webhooks: 2 });
  });

  it('RED: without the auth token nothing is called', async () => {
    const r = await syncAddressActivityWebhooks({ ...syncDeps([WATCHED], []), api: null });
    expect(r.skipped).toBe('auth_token_unconfigured');
  });
});
