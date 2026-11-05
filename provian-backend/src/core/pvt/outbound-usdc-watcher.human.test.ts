/**
 * HUMAN outbound-USDC earning leg (send / swap): the enumeration +
 * emit-wiring proof. The exact parallel of the `enumerateNativeAgentOutbound…`
 * tests (3d) — same fake-Firestore fixtures, same generatePE MOCK so the
 * emit's downstream call is inspected in isolation.
 *
 * This layer proves the WIRING: a human native address is enumerated with
 * `source:'native_human'`, and the emit hands generatePE `ownerType:'human'`
 * + `agentId = user_id` + the on-chain `counterpartyAddress`. The MONEY OUTCOME
 * (that those params make the same-owner fence seal a human→own transfer
 * `record_only` through the real recordPEAccrual) is proven in the sibling
 * `outbound-usdc-watcher.human-accrual.test.ts`. Two layers, same shape as the
 * device-witnessed / mobile-chat overlays.
 *
 * NB the fixtures here seed the REAL human-wallet field `address` (per
 * HumanWalletDocument, human-wallet-registration.ts:41) — NOT the `evm_address`
 * that `watcher-enumeration.test.ts::seedCanonicalHumanAuthority` writes (an
 * unused-but-misleading fixture field; the enumerator cross-checks `wallet.address`).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';

// Same isolation as outbound-usdc-watcher.test.ts: the emit calls the
// module-level generatePE; mock it so the downstream call args are inspectable
// without the real chain-tip / accrual machinery.
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async () => ({ peId: 'pe_test', peHash: 'h', prevHash: 'p' })),
}));

import {
  buildBaseOutboundDeps,
  enumerateNativeHumanOutboundAddresses,
  enumerateNativeAgentOutboundAddresses,
  type OutboundActivityEvent,
  type WatchedOutboundAddress,
} from './outbound-usdc-watcher';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  createNativeWalletRegistrationFence,
} from './native-wallet-registration';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';

const HADDR = '0x1111111111111111111111111111111111111111';

// -----------------------------------------------------------------------------
// (A) enumerateNativeHumanOutboundAddresses
// -----------------------------------------------------------------------------
describe('enumerateNativeHumanOutboundAddresses ', () => {
  const seedNativeHuman = async (opts: {
    address?: string;
    walletId?: string;
    userId?: string;
    platform?: string;
    withWallet?: boolean;
    withFence?: boolean;
    walletAddressOverride?: string;
    observedHead?: number;
  } = {}): Promise<ReturnType<typeof createFakeFirestore>> => {
    const fake = createFakeFirestore();
    const address = (opts.address ?? HADDR).toLowerCase();
    const walletId = opts.walletId ?? 'hw1';
    const userId = opts.userId ?? 'huser1';
    await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(address))
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address,
        wallet_id: walletId,
        owner_type: 'human',
        owner_id: userId,
        created_at_ms: 111,
      });
    if (opts.withWallet !== false) {
      await fake.collection('wallets').doc(walletId).set({
        id: walletId,
        type: 'human',
        user_id: userId,
        // REAL field name (HumanWalletDocument.address), not evm_address.
        address: opts.walletAddressOverride ?? address,
        ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
        ...(opts.withFence === false
          ? {}
          : { native_watcher_registration: createNativeWalletRegistrationFence(opts.observedHead ?? 9_000) }),
      });
    }
    return fake;
  };

  it('admits a valid human native wallet with the creation-block no-retro fence; agentId carries the user_id', async () => {
    const out = await enumerateNativeHumanOutboundAddresses(
      (await seedNativeHuman({ observedHead: 9_000 })) as unknown as Firestore,
    );
    expect(out).toEqual([{
      address: HADDR,
      walletId: 'hw1',
      agentId: 'huser1', // the human user_id in the accrual-identity slot
      provenAtBlock: 9_001, // eligibility_start_block = observed_head + 1
      source: 'native_human',
    }]);
  });

  it('RED: a platform:test human wallet is excluded; flipping to production admits it', async () => {
    expect(await enumerateNativeHumanOutboundAddresses(
      (await seedNativeHuman({ platform: 'test' })) as unknown as Firestore,
    )).toEqual([]);
    expect(await enumerateNativeHumanOutboundAddresses(
      (await seedNativeHuman({ platform: 'production' })) as unknown as Firestore,
    )).toHaveLength(1);
  });

  it('RED: THROWS fail-closed when the human wallet doc is missing', async () => {
    await expect(enumerateNativeHumanOutboundAddresses(
      (await seedNativeHuman({ withWallet: false })) as unknown as Firestore,
    )).rejects.toThrow('watched_address_enumeration_invalid:human_wallet_missing:hw1');
  });

  it('RED: THROWS when the wallet address does not match the index authority', async () => {
    await expect(enumerateNativeHumanOutboundAddresses(
      (await seedNativeHuman({ walletAddressOverride: '0x2222222222222222222222222222222222222222' })) as unknown as Firestore,
    )).rejects.toThrow('watched_address_enumeration_invalid:human_wallet_identity:hw1');
  });

  it('RED: THROWS when the no-retro fence is absent — a native wallet is never admitted fenceless', async () => {
    await expect(enumerateNativeHumanOutboundAddresses(
      (await seedNativeHuman({ withFence: false })) as unknown as Firestore,
    )).rejects.toThrow('watched_address_enumeration_invalid:human_wallet_fence:hw1');
  });

  it('does not admit agent rows (owner_type filter is selective, not empty-population)', async () => {
    // Seed a human AND an agent row; the human enumerator returns only the human,
    // and the agent enumerator returns only the agent — proving the where-filter
    // is real, not a vacuous all/nothing.
    const fake = await seedNativeHuman({ observedHead: 9_000 });
    await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId('0x9999999999999999999999999999999999999999'))
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address: '0x9999999999999999999999999999999999999999',
        wallet_id: 'aw9',
        owner_type: 'agent',
        owner_id: 'agent9',
        created_at_ms: 111,
      });
    await fake.collection('agent_wallets').doc('aw9').set({
      id: 'aw9', agent_id: 'agent9', address: '0x9999999999999999999999999999999999999999',
      platform: 'openai', native_watcher_registration: createNativeWalletRegistrationFence(9_000),
    });
    const humans = await enumerateNativeHumanOutboundAddresses(fake as unknown as Firestore);
    const agents = await enumerateNativeAgentOutboundAddresses(fake as unknown as Firestore);
    expect(humans.map((h) => h.source)).toEqual(['native_human']);
    expect(humans[0].agentId).toBe('huser1');
    expect(agents.map((a) => a.source)).toEqual(['native_agent']);
  });
});

// -----------------------------------------------------------------------------
// (A2) listWatchedAddresses unions human + conflict dedup
// -----------------------------------------------------------------------------
describe('buildBaseOutboundDeps.listWatchedAddresses unions human native wallets ', () => {
  it('includes a human native wallet in the watched set alongside agents', async () => {
    const fake = createFakeFirestore();
    await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(HADDR))
      .set({
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453, address: HADDR, wallet_id: 'hw1', owner_type: 'human',
        owner_id: 'huser1', created_at_ms: 111,
      });
    await fake.collection('wallets').doc('hw1').set({
      id: 'hw1', type: 'human', user_id: 'huser1', address: HADDR,
      native_watcher_registration: createNativeWalletRegistrationFence(9_000),
    });
    const watched = await buildBaseOutboundDeps({
      db: fake as unknown as Firestore,
    } as unknown as AgentBankDeps).listWatchedAddresses();
    expect(watched.map((w) => w.source)).toEqual(['native_human']);
    expect(watched[0].walletId).toBe('hw1');
  });
});

// -----------------------------------------------------------------------------
// (A3) emitActivityPE attributes a human native PE to the human owner
// -----------------------------------------------------------------------------
describe('buildBaseOutboundDeps.emitActivityPE owner attribution ', () => {
  const genPEMock = generatePE as jest.Mock;
  beforeEach(() => genPEMock.mockClear());

  const makeDeps = () => buildBaseOutboundDeps({
    db: createFakeFirestore() as unknown as Firestore,
  } as unknown as AgentBankDeps);

  const humanAddr: WatchedOutboundAddress = {
    address: HADDR, walletId: 'hw1', agentId: 'huser1', provenAtBlock: 500, source: 'native_human',
  };
  const agentAddr: WatchedOutboundAddress = {
    address: '0x9999999999999999999999999999999999999999', walletId: 'aw9', agentId: 'agent9',
    provenAtBlock: 500, source: 'native_agent',
  };
  const event = (): OutboundActivityEvent => ({
    txHash: `0x${'a'.repeat(64)}`, logIndex: 0, blockNumber: 1500,
    toAddress: '0x3333333333333333333333333333333333333333', amountUsd: 5,
    amountAtomic: '5000000', observedAtMs: 1234,
  });

  it('a native_human send is attributed ownerType:human, agentId=user_id, with the on-chain counterparty', async () => {
    await makeDeps().emitActivityPE(humanAddr, event(), 'send', {
      asset: 'USDC', verified: true, finality_confirmations: 12,
    });
    const passed = genPEMock.mock.calls[0][1] as {
      ownerType: string; agentId: string; counterpartyAddress: string; actionType: string;
    };
    expect(passed.ownerType).toBe('human');
    expect(passed.agentId).toBe('huser1');
    expect(passed.counterpartyAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(passed.actionType).toBe('send');
  });

  it('RED: a native_agent send stays ownerType:agent (attribution is source-driven, not blanket-human)', async () => {
    await makeDeps().emitActivityPE(agentAddr, event(), 'send', {
      asset: 'USDC', verified: true, finality_confirmations: 12,
    });
    const passed = genPEMock.mock.calls[0][1] as { ownerType: string; agentId: string };
    expect(passed.ownerType).toBe('agent');
    expect(passed.agentId).toBe('agent9');
  });
});
