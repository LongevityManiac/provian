/**
 * Solana token accounts on the push: a token receive names the token account, not its owner, so
 * every watched owner's token accounts are registered too, and a delivery naming one queues the
 * owner's pointer (the rotation's own `(signature, owner)` key). Each guard has its RED case.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  ADDRESS_ACTIVITY_MEMBERS_COLLECTION,
  ADDRESS_ACTIVITY_STATE_COLLECTION,
  AddressActivitySigningKeys,
  handleAddressActivityDelivery,
  syncAddressActivityWebhooks,
  type AlchemyNotifyApi,
  type AlchemyWebhook,
  type AddressActivitySyncDeps,
} from './address-activity-push';
import {
  SOLANA_OWNER_ENUMERATION_INTERVAL_MS,
  SOLANA_TOKEN_ACCOUNTS_COLLECTION,
  SOLANA_TOKEN_OWNERS_COLLECTION,
  associatedTokenAccount,
  derivedTokenAccounts,
  isOnEd25519Curve,
  tokenBalancePairs,
} from './address-activity-solana-tokens';
import { base58Decode, base58Encode } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  SOLANA_PROVEN_ADDRESS_SCHEMA,
  createSolanaProofEvidence,
  type SolanaProvenAddressRecord,
} from '../external-address/solana-link';
import { SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION, solanaChainRecordObservationId } from './solana-chain-record-lane';
import { SOLANA_USDC_MINT_ADDRESS } from './solana-chain-record-derive';

const NOW = 1_900_000_000_000;
const KEY = 'whsec_test_signing_key';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const sign = (body: string): string => crypto.createHmac('sha256', KEY).update(body, 'utf8').digest('hex');
const solAddr = (): string => base58Encode(crypto.randomBytes(32));
const solSig = (): string => base58Encode(crypto.randomBytes(64));
const webhook = (id: string, network: string): AlchemyWebhook => ({ id, network, signingKey: KEY, url: 'https://relay.test/hook', isActive: true, type: 'ADDRESS_ACTIVITY' });

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

/** A Solana delivery in Alchemy's shape (snake_case, wrapped message and meta). */
function solanaBody(txs: Array<{ signature: string; keys: string[]; balances?: Array<{ index: number; owner: string; mint?: string }> }>): string {
  return JSON.stringify({
    webhookId: 'wh_sol', id: 'whevt_s', type: 'ADDRESS_ACTIVITY',
    event: { network: 'SOLANA_MAINNET', slot: 401_000_000, transaction: txs.map((t) => ({
      signature: t.signature, is_vote: false, slot: 401_000_000,
      transaction: [{ signatures: [t.signature], message: [{ account_keys: t.keys }] }],
      meta: [{ post_token_balances: (t.balances ?? []).map((b) => ({ account_index: b.index, owner: b.owner, mint: b.mint ?? SOLANA_USDC_MINT_ADDRESS })) }],
    })) },
  });
}

const observation = (signature: string, owner: string) =>
  db.store.get(`${SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${solanaChainRecordObservationId(signature, owner)}`);

const syncDeps = (sol: string[], tokenAccounts: AddressActivitySyncDeps['solanaTokenAccounts'], capacity?: number): AddressActivitySyncDeps => ({
  db: db as unknown as Firestore,
  api,
  webhookUrl: 'https://relay.test/hook',
  evmCandidates: async () => [],
  solanaCandidates: async () => sol,
  solanaTokenAccounts: tokenAccounts,
  now: () => NOW,
  ...(capacity === undefined ? {} : { capacity }),
});

beforeEach(() => {
  db = createFakeFirestore();
  api = apiWith([webhook('wh_sol', 'SOLANA_MAINNET')]);
  keys = new AddressActivitySigningKeys(api, () => NOW);
  // The live Solana webhook already exists.
  db.store.set(`${ADDRESS_ACTIVITY_STATE_COLLECTION}/state_SOLANA_MAINNET`, { webhooks: [{ id: 'wh_sol', count: 0 }] });
});

describe('associated token account derivation', () => {
  it('matches the Solana SDK (vectors from @solana/spl-token getAssociatedTokenAddressSync)', () => {
    expect(associatedTokenAccount('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', SOLANA_USDC_MINT_ADDRESS)).toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
    expect(associatedTokenAccount('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', TOKEN_2022)).toBe('897krAvWH3RbymaCYE3o9emopUwocieHuKTUk9nySpq6');
    expect(associatedTokenAccount('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', SOLANA_USDC_MINT_ADDRESS)).toBe('7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK');
    expect(associatedTokenAccount('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')).toBe('D9Rsc81iPd5iDaLoNLqWXDKjN7tNUwL6SE9GQB4Q1jEg');
    expect(derivedTokenAccounts('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB')).toEqual(['7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK']);
  });
  it('RED: a wallet key is on the curve and a derived account is not; the wrong token program gives another account', () => {
    expect(isOnEd25519Curve(base58Decode('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB')!)).toBe(true);
    expect(isOnEd25519Curve(base58Decode('7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK')!)).toBe(false);
    expect(associatedTokenAccount('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', SOLANA_USDC_MINT_ADDRESS, TOKEN_2022)).not.toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
  });
});

describe('token balance pairs from a delivery', () => {
  it('reads snake_case and camelCase shapes, including loaded addresses; RED: an index out of range names nothing', () => {
    const owner = solAddr(), account = solAddr(), loaded = solAddr();
    expect(tokenBalancePairs({ transaction: [{ message: [{ account_keys: [owner, account] }] }], meta: [{ post_token_balances: [{ account_index: 1, owner }] }] }))
      .toEqual([{ tokenAccount: account, owner }]);
    expect(tokenBalancePairs({ transaction: { message: { accountKeys: [{ pubkey: owner }] }, meta: { postTokenBalances: [{ accountIndex: 1, owner }], loadedAddresses: { writable: [loaded], readonly: [] } } } }))
      .toEqual([{ tokenAccount: loaded, owner }]);
    expect(tokenBalancePairs({ transaction: [{ message: [{ account_keys: [owner] }] }], meta: [{ post_token_balances: [{ account_index: 5, owner }] }] })).toEqual([]);
  });
});

describe('sync: every watched owner\'s token accounts go on the Solana webhook', () => {
  it('registers the owner, its derived USDC account and every account it holds, once; the owner is next due a day later', async () => {
    const owner = solAddr(), held = solAddr();
    seedSolana(owner);
    const reader = jest.fn(async () => [held]);
    const r = await syncAddressActivityWebhooks(syncDeps([owner], reader));
    expect(r.networks.SOLANA_MAINNET).toMatchObject({ added: 1, complete: true, token_accounts: { owners_seeded: 1, owners_enumerated: 1, registered: 2 } });
    const derived = derivedTokenAccounts(owner)[0];
    for (const account of [derived, held]) {
      expect(db.store.get(`${ADDRESS_ACTIVITY_MEMBERS_COLLECTION}/SOLANA_MAINNET_${account}`)).toMatchObject({ webhook_id: 'wh_sol' });
      expect(db.store.get(`${SOLANA_TOKEN_ACCOUNTS_COLLECTION}/${account}`)).toMatchObject({ owners: [owner], registered: true });
    }
    expect(db.store.get(`${SOLANA_TOKEN_OWNERS_COLLECTION}/${owner}`)).toMatchObject({ next_enumeration_at_ms: NOW + SOLANA_OWNER_ENUMERATION_INTERVAL_MS });
    expect(db.store.get(`${ADDRESS_ACTIVITY_STATE_COLLECTION}/state_SOLANA_MAINNET`)).toMatchObject({ webhooks: [{ id: 'wh_sol', count: 3 }], token_owners_synced_through_ms: NOW });

    // RED for "once": the next run enumerates nobody and adds nothing.
    api.addAddresses.mockClear();
    reader.mockClear();
    const again = await syncAddressActivityWebhooks(syncDeps([], reader));
    expect(again.networks.SOLANA_MAINNET.token_accounts).toMatchObject({ owners_seeded: 0, owners_enumerated: 0, registered: 0 });
    expect(reader).not.toHaveBeenCalled();
    expect(api.addAddresses).not.toHaveBeenCalled();
  });

  it('the first run seeds every owner already proven, not only those proven since the last sync', async () => {
    const old = solAddr();
    seedSolana(old);
    db.store.set(`${ADDRESS_ACTIVITY_STATE_COLLECTION}/state_SOLANA_MAINNET`, { webhooks: [{ id: 'wh_sol', count: 1 }], synced_through_ms: NOW - 1 });
    const all = jest.fn(async (since: number | null) => (since === null ? [old] : []));
    const r = await syncAddressActivityWebhooks({ ...syncDeps([], async () => []), solanaCandidates: all });
    expect(r.networks.SOLANA_MAINNET.token_accounts).toMatchObject({ owners_seeded: 1 });
    expect(all).toHaveBeenCalledWith(null);
  });

  it('RED: a run whose seeding fails leaves the owner for the next run, even after the owner cursor moved on', async () => {
    const T0 = NOW - 60 * 60_000;
    const owner = solAddr();
    seedSolana(owner);
    const provenAt = T0 + 30_000;
    db.store.set(`${ADDRESS_ACTIVITY_STATE_COLLECTION}/state_SOLANA_MAINNET`, {
      webhooks: [{ id: 'wh_sol', count: 0 }], synced_through_ms: T0, token_owners_synced_through_ms: T0,
    });
    const candidates = async (since: number | null) => (since === null || provenAt >= since ? [owner] : []);
    const realGetAll = db.getAll.bind(db);
    let failOnce = true;
    db.getAll = (async (...refs: Parameters<typeof db.getAll>) => {
      if (failOnce && String((refs[0] as { path?: string }).path ?? '').startsWith(SOLANA_TOKEN_OWNERS_COLLECTION)) { failOnce = false; throw new Error('UNAVAILABLE'); }
      return realGetAll(...refs);
    }) as typeof db.getAll;
    const deps = (at: number) => ({ ...syncDeps([], async () => []), solanaCandidates: candidates, now: () => at });
    const r1 = await syncAddressActivityWebhooks(deps(T0 + 16 * 60_000));
    expect(r1.networks.SOLANA_MAINNET).toMatchObject({ complete: false });
    expect(db.store.get(`${SOLANA_TOKEN_OWNERS_COLLECTION}/${owner}`)).toBeUndefined();
    const r2 = await syncAddressActivityWebhooks(deps(T0 + 31 * 60_000));
    expect(r2.networks.SOLANA_MAINNET.token_accounts).toMatchObject({ owners_seeded: 1 });
    expect(db.store.get(`${SOLANA_TOKEN_OWNERS_COLLECTION}/${owner}`)).toBeDefined();
    db.getAll = realGetAll;
  });

  it('RED: an enumeration that fails leaves the owner due and the run incomplete', async () => {
    const owner = solAddr();
    seedSolana(owner);
    const r = await syncAddressActivityWebhooks(syncDeps([owner], async () => { throw new Error('leg_down'); }));
    expect(r.networks.SOLANA_MAINNET).toMatchObject({ complete: false, token_accounts: { enumeration_errors: 1 } });
    expect(db.store.get(`${SOLANA_TOKEN_OWNERS_COLLECTION}/${owner}`)).toMatchObject({ next_enumeration_at_ms: 0 });
  });
});

describe('delivery: a token receive names only the token account', () => {
  async function registered(owner: string, account: string): Promise<void> {
    seedSolana(owner);
    await syncAddressActivityWebhooks(syncDeps([owner], async () => [account]));
  }

  it('queues the owner\'s pointer (the rotation\'s own key); RED: an account no watched owner holds queues nothing', async () => {
    const owner = solAddr(), account = solAddr(), sender = solAddr(), unknown = solAddr();
    await registered(owner, account);
    const sig = solSig(), other = solSig();
    const body = solanaBody([{ signature: sig, keys: [sender, account] }, { signature: other, keys: [sender, unknown] }]);
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(r).toMatchObject({ transactions: 2, queued: 1, unwatched: 1 });
    expect(observation(sig, owner)).toMatchObject({ signature: sig, address: owner, status: 'pending' });
    expect(observation(other, owner)).toBeUndefined();
  });

  it('RED: an owner whose proof was removed queues nothing through its token account', async () => {
    const owner = solAddr(), account = solAddr();
    await registered(owner, account);
    db.store.delete(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${owner}`);
    const sig = solSig();
    const body = solanaBody([{ signature: sig, keys: [solAddr(), account] }]);
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW);
    expect(r).toMatchObject({ queued: 0, unwatched: 1 });
  });

  it('a transaction creating a watched owner\'s new token account registers it at once, so the next receive into it is pushed', async () => {
    const owner = solAddr(), created = solAddr(), sender = solAddr();
    await registered(owner, solAddr());
    api.addAddresses.mockClear();
    const createSig = solSig();
    const create = solanaBody([{ signature: createSig, keys: [sender, created, owner], balances: [{ index: 1, owner }] }]);
    const first = await handleAddressActivityDelivery(db as unknown as Firestore, keys, create, sign(create), NOW, { api, url: 'https://relay.test/hook' });
    expect(first).toMatchObject({ queued: 1, token_accounts_registered: 1 });
    expect(api.addAddresses).toHaveBeenCalledWith('wh_sol', [created]);
    expect(db.store.get(`${SOLANA_TOKEN_ACCOUNTS_COLLECTION}/${created}`)).toMatchObject({ owners: [owner], registered: true });

    const nextSig = solSig();
    const next = solanaBody([{ signature: nextSig, keys: [sender, created] }]);
    const second = await handleAddressActivityDelivery(db as unknown as Firestore, keys, next, sign(next), NOW);
    expect(second).toMatchObject({ queued: 1 });
    expect(observation(nextSig, owner)).toMatchObject({ address: owner });
  });

  it('RED: a token balance owned by an unwatched address records nothing', async () => {
    const stranger = solAddr(), account = solAddr();
    const body = solanaBody([{ signature: solSig(), keys: [stranger, account], balances: [{ index: 1, owner: stranger }] }]);
    await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW, { api, url: 'https://relay.test/hook' });
    expect(db.store.get(`${SOLANA_TOKEN_ACCOUNTS_COLLECTION}/${account}`)).toBeUndefined();
    expect(api.addAddresses).not.toHaveBeenCalled();
  });

  it('without a registrar, or with every webhook full, the new account stays pending and the next sync registers it', async () => {
    const owner = solAddr(), created = solAddr();
    await registered(owner, solAddr());
    api.addAddresses.mockClear();
    db.store.set(`${ADDRESS_ACTIVITY_STATE_COLLECTION}/state_SOLANA_MAINNET`, {
      ...db.store.get(`${ADDRESS_ACTIVITY_STATE_COLLECTION}/state_SOLANA_MAINNET`), webhooks: [{ id: 'wh_sol', count: 95_000 }],
    });
    const body = solanaBody([{ signature: solSig(), keys: [solAddr(), created, owner], balances: [{ index: 1, owner }] }]);
    const r = await handleAddressActivityDelivery(db as unknown as Firestore, keys, body, sign(body), NOW, { api, url: 'https://relay.test/hook' });
    expect(r.token_accounts_registered).toBe(0);
    expect(api.createWebhook).not.toHaveBeenCalled();
    expect(db.store.get(`${SOLANA_TOKEN_ACCOUNTS_COLLECTION}/${created}`)).toMatchObject({ registered: false });
    // The owner named by the delivery is due for a fresh enumeration on the next sync.
    expect(db.store.get(`${SOLANA_TOKEN_OWNERS_COLLECTION}/${owner}`)).toMatchObject({ next_enumeration_at_ms: NOW });

    const s = await syncAddressActivityWebhooks(syncDeps([], async () => [created]));
    expect(s.networks.SOLANA_MAINNET.token_accounts).toMatchObject({ registered: 1 });
    expect(api.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ network: 'SOLANA_MAINNET', addresses: [created] }));
    expect(db.store.get(`${SOLANA_TOKEN_ACCOUNTS_COLLECTION}/${created}`)).toMatchObject({ registered: true });
  });
});
