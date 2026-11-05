import type { Firestore } from 'firebase-admin/firestore';

const listProvenAddresses = jest.fn();
jest.mock('../external-address/link', () => ({ listProvenAddresses }));

import type { AgentBankDeps } from '../agent-bank/types';
import {
  buildBaseInboundDeps,
  scanInboundUsdc,
  type InboundUsdcScanDeps,
} from './inbound-usdc-watcher';
import { buildBaseOutboundDeps } from './outbound-usdc-watcher';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
} from './native-wallet-registration';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  watcherAddressAdmissionDocId,
} from './watcher-address-admission';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import { seedCanonicalAgentAuthority, seedCanonicalHumanAuthority } from './__test-helpers__/canonical-authority';
import { canTransitionMintDisposition } from './policy/monetary-accounting';
import {
  judgeReclassification,
  reclassifyWrite,
  type ReclassifyRowFacts,
} from '../../../scripts/reclassify-test-genesis-pes';

function emptySnapshot() {
  return { forEach: () => undefined, docs: [], empty: true, size: 0 };
}

function enumerationDb(options: { collectionError?: { name: string; error: Error } } = {}): Firestore {
  return {
    collection: (name: string) => ({
      get: async () => {
        if (name === options.collectionError?.name) throw options.collectionError.error;
        return emptySnapshot();
      },
      where: () => ({
        get: async () => {
          return emptySnapshot();
        },
      }),
    }),
  } as unknown as Firestore;
}


/**
 * Enumeration semantics (2026-08-16 production-effect audit, item 3):
 *
 * - COLLECTION-LEVEL reads stay all-or-nothing: a failed authority-collection
 * read or external-enumeration read still aborts the scan and holds the
 * checkpoint (first three tests).
 * - PER-WALLET faults now ISOLATE: one wallet whose authority records fail
 * validation is excluded from the cycle (reason logged, taxonomy preserved)
 * and the scan proceeds for everyone else. The scan order follows the
 * previous whole-scan abort, which took the watcher down for ~330
 * consecutive cycles when consignment re-marked probe wallets.
 * - Cross-wallet `watched_address_enumeration_duplicate*` contests still
 * abort: a contested address identity is not attributable to one wallet.
 */
describe('watcher enumeration is all-or-nothing', () => {
  beforeEach(() => listProvenAddresses.mockReset());

  it('propagates external-address enumeration failure for inbound and outbound', async () => {
    listProvenAddresses.mockRejectedValue(new Error('external_enumeration_unavailable'));
    const deps = { db: enumerationDb() } as AgentBankDeps;
    await expect(buildBaseInboundDeps(deps).listWatchedWallets()).rejects.toThrow(
      'external_enumeration_unavailable',
    );
    await expect(buildBaseOutboundDeps(deps).listWatchedAddresses()).rejects.toThrow(
      'external_enumeration_unavailable',
    );
  });

  it('propagates canonical authority enumeration failure instead of returning a partial set', async () => {
    listProvenAddresses.mockResolvedValue([]);
    const deps = {
      db: enumerationDb({
        collectionError: {
          name: 'human_wallet_registration_by_user_v1',
          error: new Error('human_enumeration_unavailable'),
        },
      }),
    } as AgentBankDeps;
    await expect(buildBaseInboundDeps(deps).listWatchedWallets()).rejects.toThrow(
      'human_enumeration_unavailable',
    );
  });

  it('does not advance an existing checkpoint when enumeration fails', async () => {
    const db = createFakeFirestore();
    const checkpoint = {
      chain_id: 8453,
      last_processed_block: 100,
      membership_generation: 0,
      updated_at: 1,
    };
    db.store.set('genesis_inbound_checkpoints/8453', checkpoint);
    const deps: InboundUsdcScanDeps = {
      db: db as unknown as Firestore,
      chainId: 8453,
      chainName: 'base',
      getBlockNumber: async () => 200,
      getLogs: async () => { throw new Error('logs_must_not_run'); },
      listWatchedWallets: async () => { throw new Error('enumeration_incomplete'); },
      verifyFundingEvent: async () => { throw new Error('verification_must_not_run'); },
      emitFundingPE: async () => { throw new Error('emit_must_not_run'); },
    };
    await expect(scanInboundUsdc(deps)).rejects.toThrow('enumeration_incomplete');
    expect(db.store.get('genesis_inbound_checkpoints/8453')).toEqual(checkpoint);
  });

  it('ignores retired wallet rows and enumerates only complete canonical authorities', async () => {
    const db = createFakeFirestore();
    db.store.set('agent_wallets/legacy-agent', {
      agent_id: 'legacy-agent',
      address: '0x1111111111111111111111111111111111111111',
      platform: 'sdk',
    });
    seedCanonicalAgentAuthority({
      db,
      walletId: 'canonical-agent-wallet',
      agentId: 'canonical-agent',
      address: '0x2222222222222222222222222222222222222222',
      observedHead: 140,
    });
    db.store.set('wallets/legacy-human', {
      type: 'human',
      user_id: 'legacy-human',
      address: '0x3333333333333333333333333333333333333333',
    });
    listProvenAddresses.mockResolvedValue([]);
    const watched = await buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets();
    expect(watched).toEqual([
      expect.objectContaining({ agentId: 'canonical-agent', eligibilityStartBlock: 141 }),
    ]);
  });

  // SUPERSEDED PIN (run order + the consignment
  // convention): the previous test here asserted that a live platform:'test'
  // re-mark of a born-production wallet must REJECT the whole enumeration
  // (agent_platform_binding). That is exactly what took the inbound watcher
  // down for ~330 cycles when mark-test-wallets --sync-agent-wallets re-marked
  // the eleven / probe wallets. The consignment marker now EXCLUDES
  // the wallet (parity with the outbound watcher and every other economic
  // surface) and the scan completes.
  // RED negative control, recorded in the commit: this test fails against the
  // pre-fix source (listWatchedWallets throws agent_platform_binding), proving
  // the live-marker skip is load-bearing, not vacuous.
  it('excludes a consignment-marked (live platform:test) wallet and completes the scan', async () => {
    const db = createFakeFirestore();
    const wallet = seedCanonicalAgentAuthority({
      db,
      walletId: 'canonical-production-wallet',
      agentId: 'canonical-production-agent',
      address: '0x9999999999999999999999999999999999999999',
      observedHead: 140,
      platform: 'sdk',
    });
    // The exact / production shape: born 'sdk'/'mcp', live doc
    // re-marked 'test' with the original label stashed.
    db.store.set('agent_wallets/canonical-production-wallet', {
      ...wallet,
      platform: 'test',
      pre_test_platform: 'sdk',
    });
    seedCanonicalAgentAuthority({
      db,
      walletId: 'healthy-sibling-wallet',
      agentId: 'healthy-sibling-agent',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      observedHead: 140,
      platform: 'sdk',
    });
    db.store.set('genesis_inbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 100,
      membership_generation: 1,
      updated_at: 1,
    });
    listProvenAddresses.mockResolvedValue([]);

    const watched = await buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets();

    // Non-empty evaluated population : the healthy sibling proves the
    // enumeration completed and returned wallets — the exclusion assertion is
    // not passing over an empty set.
    expect(watched).toHaveLength(1);
    expect(watched).toEqual([
      expect.objectContaining({ agentId: 'healthy-sibling-agent' }),
    ]);
    expect(watched).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ walletId: 'canonical-production-wallet' }),
    ]));
    // Enumeration never writes the checkpoint.
    expect(db.store.get('genesis_inbound_checkpoints/8453'))
      .toMatchObject({ last_processed_block: 100, membership_generation: 1 });
  });

  // The pre_test_platform stash on the consigned doc must not read as an
  // identity fault either: the live-marker skip fires BEFORE the exact-shape
  // identity checks, so the enumeration fault log stays empty — the eleven
  // consigned probes are deterministic skips, not per-cycle faults.
  it('treats a consigned wallet as a silent skip, not an enumeration fault', async () => {
    const db = createFakeFirestore();
    const wallet = seedCanonicalAgentAuthority({
      db,
      walletId: 'consigned-quiet-wallet',
      agentId: 'consigned-quiet-agent',
      address: '0x9898989898989898989898989898989898989898',
      observedHead: 140,
      platform: 'mcp',
    });
    db.store.set('agent_wallets/consigned-quiet-wallet', {
      ...wallet,
      platform: 'test',
      pre_test_platform: 'mcp',
    });
    seedCanonicalAgentAuthority({
      db,
      walletId: 'quiet-sibling-wallet',
      agentId: 'quiet-sibling-agent',
      address: '0xabababababababababababababababababababab',
      observedHead: 140,
    });
    listProvenAddresses.mockResolvedValue([]);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const watched = await buildBaseInboundDeps({
        db: db as unknown as Firestore,
      } as AgentBankDeps).listWatchedWallets();
      expect(watched).toHaveLength(1);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // PER-WALLET FAULT ISOLATION: a genuine integrity fault (here a non-test
  // platform mismatch between the birth PE and the live doc) excludes exactly
  // that wallet — with its precise `watched_address_enumeration_invalid:*`
  // reason logged — while the healthy sibling is still enumerated.
  // RED negative control, recorded in the commit: against the pre-fix source
  // (no per-wallet catch) this test fails because the whole enumeration
  // throws — proving the isolation is load-bearing.
  it('excludes one integrity-faulted wallet, logs its exact reason, and keeps enumerating', async () => {
    const db = createFakeFirestore();
    const wallet = seedCanonicalAgentAuthority({
      db,
      walletId: 'faulted-binding-wallet',
      agentId: 'faulted-binding-agent',
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      observedHead: 140,
      platform: 'sdk',
    });
    // Born 'sdk', live doc says 'mcp': neither is 'test', so this is a real
    // platform-binding integrity fault, not a consignment skip.
    db.store.set('agent_wallets/faulted-binding-wallet', {
      ...wallet,
      platform: 'mcp',
    });
    seedCanonicalAgentAuthority({
      db,
      walletId: 'isolation-sibling-wallet',
      agentId: 'isolation-sibling-agent',
      address: '0xcccccccccccccccccccccccccccccccccccccccc',
      observedHead: 140,
    });
    listProvenAddresses.mockResolvedValue([]);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const watched = await buildBaseInboundDeps({
        db: db as unknown as Firestore,
      } as AgentBankDeps).listWatchedWallets();
      expect(watched).toHaveLength(1);
      expect(watched).toEqual([
        expect.objectContaining({ agentId: 'isolation-sibling-agent' }),
      ]);
      // The reason taxonomy is preserved in the fault log line.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('enumeration fault'),
        expect.objectContaining({
          message: 'watched_address_enumeration_invalid:agent_platform_binding:faulted-binding-wallet',
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('excludes a consignment-marked human wallet while the real human stays watched', async () => {
    const db = createFakeFirestore();
    // The production shape after mark-test-wallets: the consigned human
    // carries platform:'test'; the real human wallet has NO platform field.
    seedCanonicalHumanAuthority({
      db,
      walletId: 'consigned-human-wallet',
      userId: 'consigned-human',
      address: '0xdddddddddddddddddddddddddddddddddddddddd',
      observedHead: 140,
      platform: 'test',
    });
    seedCanonicalHumanAuthority({
      db,
      walletId: 'real-human-wallet',
      userId: 'real-human',
      address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      observedHead: 140,
    });
    listProvenAddresses.mockResolvedValue([]);

    const watched = await buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets();

    expect(watched).toHaveLength(1);
    expect(watched).toEqual([
      expect.objectContaining({ walletId: 'real-human-wallet', ownerType: 'human' }),
    ]);
  });

  // Proven-external leg parity with outbound-usdc-watcher.ts: an external
  // address owned by a live platform:'test' agent never enters the watched
  // set. RED negative control, recorded in the commit: against the pre-fix
  // source (no live-platform read on this leg) the test-owned address IS
  // returned and this test fails.
  it('excludes a proven external address owned by a test-platform agent', async () => {
    const db = createFakeFirestore();
    db.store.set('agent_wallets/wallet_aw_test-owner', {
      id: 'wallet_aw_test-owner',
      agent_id: 'test-owner-agent',
      platform: 'test',
      pre_test_platform: 'mcp',
    });
    db.store.set('agent_wallets/wallet_aw_real-owner', {
      id: 'wallet_aw_real-owner',
      agent_id: 'real-owner-agent',
      platform: 'sdk',
    });
    listProvenAddresses.mockResolvedValue([
      {
        agent_id: 'test-owner-agent',
        wallet_id: 'wallet_aw_test-owner',
        address: '0x1212121212121212121212121212121212121212',
        proven_at_block: 91,
        proven_at_ms: 1,
      },
      {
        agent_id: 'real-owner-agent',
        wallet_id: 'wallet_aw_real-owner',
        address: '0x3434343434343434343434343434343434343434',
        proven_at_block: 91,
        proven_at_ms: 1,
      },
    ]);

    const watched = await buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets();

    // Non-empty population: the real owner's address proves the leg ran.
    expect(watched).toHaveLength(1);
    expect(watched).toEqual([
      expect.objectContaining({
        walletId: 'wallet_aw_real-owner',
        address: '0x3434343434343434343434343434343434343434',
        isExternalProven: true,
      }),
    ]);
  });

  // NEGATIVE CONTROL that isolation did NOT over-reach (feed the guard
  // the violating input and assert it still reports the violation): a
  // cross-wallet duplicate address is a contested identity attributable to no
  // single wallet — it must still abort the whole enumeration.
  it('still aborts the whole enumeration on a cross-wallet duplicate address', async () => {
    const db = createFakeFirestore();
    const address = '0x5656565656565656565656565656565656565656';
    // Claimant one is a fully valid canonical authority for the address...
    seedCanonicalAgentAuthority({
      db,
      walletId: 'duplicate-claimant-one',
      agentId: 'duplicate-agent-one',
      address,
      observedHead: 140,
    });
    // ...and a second address-index row (a different wallet) claims the SAME
    // address. The contest is not attributable to either wallet, so the whole
    // enumeration must still refuse — isolation never swallows this class.
    db.store.set(
      `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/address_duplicate-claimant-two`,
      {
        schema_version: 'native-wallet-address-index/v1',
        chain_id: 8453,
        address,
        wallet_id: 'duplicate-claimant-two',
        owner_type: 'agent',
        owner_id: 'duplicate-agent-two',
        created_at_ms: 1,
      },
    );
    listProvenAddresses.mockResolvedValue([]);

    await expect(buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets()).rejects.toThrow(
      `watched_address_enumeration_duplicate:${address}`,
    );
  });

  it('never treats an external admission as authority for a same-wallet native row', async () => {
    const db = createFakeFirestore();
    const walletId = 'wallet_aw_external-only';
    const nativeAddress = '0x7777777777777777777777777777777777777777';
    const externalAddress = '0x8888888888888888888888888888888888888888';
    db.store.set(`agent_wallets/${walletId}`, {
      id: walletId,
      agent_id: 'external-only-agent',
      address: nativeAddress,
      platform: 'sdk',
      created_at: 1,
      native_watcher_registration: createNativeWalletRegistrationFence(80),
    });
    const externalTarget = {
      direction: 'inbound' as const,
      chainId: 8453,
      address: externalAddress,
      walletId,
      agentId: 'external-only-agent',
      eligibilityStartBlock: 91,
    };
    db.store.set(
      `${WATCHER_ADDRESS_ADMISSION_COLLECTION}/${watcherAddressAdmissionDocId(externalTarget)}`,
      {
        schema_version: 'pvt-watcher-address-admission/v2',
        direction: 'inbound',
        chain_id: 8453,
        address: externalAddress,
        wallet_id: walletId,
        agent_id: 'external-only-agent',
        eligibility_start_block: 91,
        state: 'live',
        backfill_next_block: 91,
        catch_up_through_block: 90,
        membership_generation: 0,
        revision: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    );
    listProvenAddresses.mockResolvedValue([{
      agent_id: 'external-only-agent',
      wallet_id: walletId,
      address: externalAddress,
      proven_at_block: 91,
      proven_at_ms: 1,
    }]);

    const watched = await buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets();

    expect(watched).toEqual([
      expect.objectContaining({
        walletId,
        address: externalAddress,
        isExternalProven: true,
      }),
    ]);
    expect(watched).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ address: nativeAddress }),
    ]));
  });

  // SUPERSEDED PIN (run order): this test previously
  // asserted that a deleted canonical wallet row REJECTS the whole scan and
  // holds the global checkpoint until repair. Under per-wallet isolation the
  // faulted wallet is excluded for the cycle, everyone else keeps earning,
  // and the checkpoint advances. Direction is fail-closed — an unverifiable
  // identity earns nothing, no false mints. KNOWN COVERAGE GAP, raised to
  // the operator as an open question (not built — it would be new admission-state
  // machinery): deposits arriving for the faulted wallet while the checkpoint
  // advances past them are NOT auto-recovered after repair, because its
  // admission stays 'live' and has no demote-to-backfilling path.
  it('excludes a deleted canonical row for the cycle while the sibling still earns', async () => {
    const db = createFakeFirestore();
    const faultedWalletId = 'wallet_aw_canonical-corruption';
    const faultedAddress = '0x5555555555555555555555555555555555555555';
    const siblingAddress = '0x4444444444444444444444444444444444444444';
    db.store.set('genesis_inbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 100,
      membership_generation: 1,
      updated_at: 1,
    });
    const canonicalWallet = seedCanonicalAgentAuthority({
      db,
      walletId: faultedWalletId,
      agentId: 'canonical-corruption-agent',
      address: faultedAddress,
      observedHead: 90,
    });
    seedCanonicalAgentAuthority({
      db,
      walletId: 'wallet_aw_healthy-sibling',
      agentId: 'healthy-sibling-agent',
      address: siblingAddress,
      observedHead: 90,
    });
    db.store.delete(`agent_wallets/${faultedWalletId}`);
    listProvenAddresses.mockResolvedValue([]);
    const productionList = buildBaseInboundDeps({
      db: db as unknown as Firestore,
    } as AgentBankDeps).listWatchedWallets;
    const emitted: string[] = [];
    const faultedEvent = {
      txHash: testTxHash('canonical-gap-event'),
      logIndex: 0,
      blockNumber: 105,
      fromAddress: '0x6666666666666666666666666666666666666666',
      toAddress: faultedAddress,
      amountAtomic: '5000000',
    };
    const siblingEvent = {
      txHash: testTxHash('healthy-sibling-event'),
      logIndex: 0,
      blockNumber: 105,
      fromAddress: '0x6666666666666666666666666666666666666666',
      toAddress: siblingAddress,
      amountAtomic: '7000000',
    };
    let head = 121;
    const scanDeps: InboundUsdcScanDeps = {
      db: db as unknown as Firestore,
      chainId: 8453,
      chainName: 'base',
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock, toAddresses }) => (
        [faultedEvent, siblingEvent].filter((event) => fromBlock <= event.blockNumber
          && toBlock >= event.blockNumber
          && toAddresses.includes(event.toAddress))
      ),
      listWatchedWallets: productionList,
      verifyFundingEvent: async (wallet, observed) => baseEconomicEvidence({
        transactionHash: observed.txHash,
        logIndex: observed.logIndex,
        blockNumber: observed.blockNumber,
        fromAddress: observed.fromAddress,
        toAddress: wallet.address,
        amountAtomic: observed.amountAtomic,
      }),
      emitFundingPE: async (_wallet, observed) => {
        emitted.push(observed.txHash);
        return { peId: `pe_${observed.txHash.slice(2)}`, peHash: 'hash' };
      },
      now: () => 10_000,
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Faulted cycle: the scan COMPLETES, the sibling's deposit is emitted,
      // the faulted wallet is excluded with its exact reason logged, and the
      // checkpoint advances.
      await expect(scanInboundUsdc(scanDeps)).resolves.toMatchObject({
        watched_wallets: 1,
        from_block: 101,
        to_block: 110,
        pes_emitted: 1,
      });
      expect(emitted).toEqual([siblingEvent.txHash]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('enumeration fault'),
        expect.objectContaining({
          message: `watched_address_enumeration_invalid:agent_wallet_missing:${faultedWalletId}`,
        }),
      );
      expect(db.store.get('genesis_inbound_checkpoints/8453'))
        .toMatchObject({ last_processed_block: 110 });

      // After repair the wallet re-enters the watched set for NEW blocks. Its
      // fault-window deposit (block 105, now behind the checkpoint) is not
      // auto-recovered — the open question above, pinned here so the gap is
      // explicit rather than silent.
      db.store.set(`agent_wallets/${faultedWalletId}`, canonicalWallet);
      head = 141;
      await expect(scanInboundUsdc(scanDeps)).resolves.toMatchObject({
        watched_wallets: 2,
        from_block: 111,
        to_block: 130,
      });
      expect(emitted).toEqual([siblingEvent.txHash]);
      expect(await productionList()).toEqual(expect.arrayContaining([
        expect.objectContaining({ walletId: faultedWalletId }),
      ]));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// =============================================================================
// reclassify-test-genesis-pes GUARDS (2026-08-16 audit item 3): the eleven
// / probe genesis_signup PEs stuck mint_status 'eligible' are
// demoted to TERMINAL record_only by a one-shot guarded operator script. The
// verdict logic is pure and unit-tested here; ALL guards are fail-closed.
// =============================================================================
describe('reclassify-test-genesis-pes guards', () => {
  // The exact production shape of the eleven stuck probe rows.
  const probeFacts = (over: Partial<ReclassifyRowFacts> = {}): ReclassifyRowFacts => ({
    peId: 'pe_genesis_probe',
    actionType: 'genesis_signup',
    mintStatus: 'eligible',
    mintDisposition: 'eligible',
    isGenesisGrant: true,
    actorWalletPlatforms: ['test'],
    claimLedgerRowExists: false,
    outboxRowCount: 0,
    reservationRowCount: 0,
    ...over,
  });

  it('demotes the eleven-probe shape (all guards pass)', () => {
    expect(judgeReclassification(probeFacts())).toEqual({ verdict: 'demote' });
  });

  it('refuses a row failing ANY single guard (fail-closed)', () => {
    const violations: Array<[Partial<ReclassifyRowFacts>, string]> = [
      [{ actionType: 'genesis_human_signup' }, 'not_genesis_signup'],
      [{ mintStatus: 'minting' }, 'mint_status_not_eligible'],
      [{ mintDisposition: 'pending_review' }, 'mint_disposition_not_eligible'],
      [{ isGenesisGrant: false }, 'not_genesis_grant'],
      [{ isGenesisGrant: undefined }, 'not_genesis_grant'],
      [{ actorWalletPlatforms: [] }, 'actor_wallet_not_found'],
      [{ actorWalletPlatforms: ['sdk'] }, 'actor_wallet_not_test_platform'],
      // One test wallet + one live wallet for the same agent_id: ambiguity is
      // a refusal, never "mostly test".
      [{ actorWalletPlatforms: ['test', 'mcp'] }, 'actor_wallet_not_test_platform'],
      [{ claimLedgerRowExists: true }, 'claim_ledger_row_exists'],
      [{ outboxRowCount: 1 }, 'outbox_row_names_pe'],
      [{ reservationRowCount: 1 }, 'reservation_names_pe'],
    ];
    // Non-empty evaluated population.
    expect(violations.length).toBeGreaterThan(0);
    for (const [over, reason] of violations) {
      const verdict = judgeReclassification(probeFacts(over));
      expect(verdict.verdict).toBe('refuse');
      expect(verdict.verdict === 'refuse' && verdict.reason).toContain(reason);
    }
  });

  it('RED CONTROL — a minted/settled row is refused, never re-demoted', () => {
    // The settled M10 origination grant (pe_genesis_6cd358a0…) reads
    // mint_status 'minted' with a claim-ledger row: two independent guards
    // refuse it. This is the violating input fed to the guard — the
    // demote verdict cannot be produced for a row settlement ever owned.
    const minted = judgeReclassification(probeFacts({
      mintStatus: 'minted',
      mintDisposition: 'record_only',
      claimLedgerRowExists: true,
    }));
    expect(minted.verdict).toBe('refuse');
  });

  it('the demotion is lawful and TERMINAL in the disposition matrix', () => {
    expect(canTransitionMintDisposition('eligible', 'record_only')).toBe(true);
    // record_only has no out-transitions: once consigned, a probe row can
    // never be re-promoted (same-state writes are the only no-op identity).
    expect(canTransitionMintDisposition('record_only', 'eligible')).toBe(false);
    expect(canTransitionMintDisposition('record_only', 'pending_review')).toBe(false);
    expect(canTransitionMintDisposition('record_only', 'ineligible_terminal')).toBe(false);
  });

  it('writes the (retired PVTv8) minting-engine record_only invalidation shape plus the audit stamp', () => {
    expect(reclassifyWrite(1_755_000_000_000)).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      disposition_reason_code: 'policy_record_only',
      estimatedPVT: 0,
      estimated_pvt_atomic: '0',
      economic_eligibility_projection: null,
      mint_status_updated_at: 1_755_000_000_000,
      test_consignment_outcome: 'd294_d295_probe_consigned',
    });
  });
});
