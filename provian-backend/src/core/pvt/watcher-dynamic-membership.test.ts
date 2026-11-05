import { jest } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';

const verifyPop = jest.fn(async (expected: { registration_id: string; agent_id: string }) => ({
  ok: true as const,
  registration_context: { ...expected, credential_recovery_generation: null },
}));
jest.mock('../agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    _challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => verifyPop(expected),
}));
import type { AgentBankDeps } from '../agent-bank/types';

import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import {
  buildBaseInboundDeps,
  scanInboundUsdc,
  type InboundTransferLog,
  type InboundUsdcScanDeps,
  type WatchedWallet,
} from './inbound-usdc-watcher';
import {
  scanOutboundUsdc,
  type OutboundActivityEvent,
  type OutboundTransferLog,
  type OutboundUsdcScanDeps,
  type WatchedOutboundAddress,
} from './outbound-usdc-watcher';
import { WATCHER_ADDRESS_ADMISSION_COLLECTION } from './watcher-address-admission';
import type { RouterDeps } from '../agent-wallet/types';
import { createAgentWalletRouter } from '../../routes/agent-wallet';
import { createHumanWalletRegistrationHandler } from '../../routes/human-wallet-registration';
import { proofForAddress, testSigner } from '../wallet-registration/__test-helpers__/address-proof';

const EXISTING = '0x1111111111111111111111111111111111111111';
const NEW_ONE_SIGNER = testSigner('22');
const NEW_ONE = NEW_ONE_SIGNER.address.toLowerCase();
// registered through the human route, which requires proof of control — a real key.
const NEW_TWO_SIGNER = testSigner('33');
const NEW_TWO = NEW_TWO_SIGNER.address.toLowerCase();
const COUNTERPARTY = '0x4444444444444444444444444444444444444444';

const nativeInbound: WatchedWallet = {
  walletId: 'native-wallet',
  agentId: 'native-agent',
  address: EXISTING,
  createdAtMs: 1,
  eligibilityStartBlock: 0,
};

function externalInbound(address = NEW_ONE, fence = 120): WatchedWallet {
  return {
    walletId: `wallet-${address}`,
    agentId: `agent-${address}`,
    address,
    createdAtMs: 1,
    isExternalProven: true,
    provenAtBlock: fence,
    eligibilityStartBlock: fence,
  };
}

function outbound(address = NEW_ONE, fence = 120): WatchedOutboundAddress {
  return {
    address,
    walletId: `wallet-${address}`,
    agentId: `agent-${address}`,
    provenAtBlock: fence,
    source: 'external_proven',
  };
}

function inboundLog(address: string, blockNumber: number, label: string): InboundTransferLog {
  return {
    txHash: testTxHash(label),
    logIndex: 0,
    blockNumber,
    fromAddress: COUNTERPARTY,
    toAddress: address,
    amountAtomic: '5000000',
  };
}

function outboundLog(address: string, blockNumber: number, label: string): OutboundTransferLog {
  return {
    txHash: testTxHash(label),
    logIndex: 0,
    blockNumber,
    fromAddress: address,
    toAddress: COUNTERPARTY,
    amountAtomic: '5000000',
  };
}

function admissionRows(fake: FakeFirestore, direction: 'inbound' | 'outbound') {
  const prefix = `${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`;
  return [...fake.store.entries()]
    .filter(([key, value]) => key.startsWith(prefix) && value.direction === direction)
    .map(([, value]) => value);
}

function asyncBarrier(): {
  entered: Promise<void>;
  wait: () => Promise<void>;
  release: () => void;
} {
  let markEntered!: () => void;
  let release!: () => void;
  let marked = false;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered,
    wait: async () => {
      if (!marked) {
        marked = true;
        markEntered();
      }
      await released;
    },
    release,
  };
}

function inboundDeps(args: {
  fake: FakeFirestore;
  watched: WatchedWallet[];
  logs: InboundTransferLog[];
  emitted: string[];
  head?: number;
  onFetch?: () => void | Promise<void>;
  beforeBackfillCursorAdvance?: InboundUsdcScanDeps['beforeBackfillCursorAdvance'];
  verificationError?: () => Error | null;
}): InboundUsdcScanDeps {
  return {
    db: args.fake as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => args.head ?? 211, // H-11 = finalized target 200
    getLogs: async ({ fromBlock, toBlock, toAddresses }) => {
      await args.onFetch?.();
      const addresses = new Set(toAddresses.map((address) => address.toLowerCase()));
      return args.logs.filter((log) => log.blockNumber >= fromBlock
        && log.blockNumber <= toBlock
        && addresses.has(log.toAddress.toLowerCase()));
    },
    listWatchedWallets: async () => [...args.watched],
    verifyFundingEvent: async (wallet, event) => {
      const error = args.verificationError?.();
      if (error) throw error;
      return baseEconomicEvidence({
        transactionHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        fromAddress: event.fromAddress,
        toAddress: wallet.address,
        amountAtomic: event.amountAtomic,
      });
    },
    emitFundingPE: async (_wallet, event) => {
      args.emitted.push(event.txHash);
      return { peId: `pe-${event.txHash}`, peHash: 'hash' };
    },
    beforeBackfillCursorAdvance: args.beforeBackfillCursorAdvance,
    now: () => 1_000,
  };
}

function outboundDeps(args: {
  fake: FakeFirestore;
  watched: WatchedOutboundAddress[];
  logs: OutboundTransferLog[];
  emitted: string[];
  head?: number;
  onFetch?: () => void | Promise<void>;
  beforeBackfillCursorAdvance?: OutboundUsdcScanDeps['beforeBackfillCursorAdvance'];
  verificationError?: () => Error | null;
}): OutboundUsdcScanDeps {
  return {
    db: args.fake as unknown as Firestore,
    chainId: 8453,
    chainName: 'base',
    getBlockNumber: async () => args.head ?? 211,
    getLogs: async ({ fromBlock, toBlock, fromAddresses }) => {
      await args.onFetch?.();
      const addresses = new Set(fromAddresses.map((address) => address.toLowerCase()));
      return args.logs.filter((log) => log.blockNumber >= fromBlock
        && log.blockNumber <= toBlock
        && addresses.has(log.fromAddress.toLowerCase()));
    },
    isDexRouter: () => false,
    isStakingContract: () => false,
    listWatchedAddresses: async () => [...args.watched],
    verifyActivityEvent: async (address, event: OutboundActivityEvent) => {
      const error = args.verificationError?.();
      if (error) throw error;
      return baseEconomicEvidence({
        transactionHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        fromAddress: address.address,
        toAddress: event.toAddress,
        amountAtomic: event.amountAtomic,
      });
    },
    emitActivityPE: async (_address, event) => {
      args.emitted.push(event.txHash);
      return { peId: `pe-${event.txHash}`, peHash: 'hash' };
    },
    beforeBackfillCursorAdvance: args.beforeBackfillCursorAdvance,
    now: () => 1_000,
  };
}

function productionInboundDeps(args: {
  fake: FakeFirestore;
  logs: InboundTransferLog[];
  emitted: string[];
  head?: number;
  onFetch?: () => void | Promise<void>;
  verificationError?: () => Error | null;
}): InboundUsdcScanDeps {
  const production = buildBaseInboundDeps({
    db: args.fake as unknown as Firestore,
  } as AgentBankDeps);
  return {
    ...production,
    getBlockNumber: async () => args.head ?? 211,
    getLogs: async ({ fromBlock, toBlock, toAddresses }) => {
      await args.onFetch?.();
      const addresses = new Set(toAddresses.map((address) => address.toLowerCase()));
      return args.logs.filter((log) => log.blockNumber >= fromBlock
        && log.blockNumber <= toBlock
        && addresses.has(log.toAddress.toLowerCase()));
    },
    verifyFundingEvent: async (wallet, event) => {
      const error = args.verificationError?.();
      if (error) throw error;
      return baseEconomicEvidence({
        transactionHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        fromAddress: event.fromAddress,
        toAddress: wallet.address,
        amountAtomic: event.amountAtomic,
      });
    },
    emitFundingPE: async (_wallet, event) => {
      args.emitted.push(event.txHash);
      return { peId: `pe-${event.txHash}`, peHash: 'hash' };
    },
    now: () => Date.now(),
  };
}

async function registerThroughCanonicalAgentRoute(
  fake: FakeFirestore,
  address: string,
  observedHeadBlock = 140,
  suffix = 'newcomer',
): Promise<void> {
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey: () => address,
    readBaseRegistrationHead: async () => observedHeadBlock,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  const response = await request(app).post('/v1/agent/wallet/create').send({
    registration_id: `agent-registration-watcher-${suffix}-0001`,
    agent_name: `Watcher ${suffix}`,
    agent_id: `watcher-${suffix}-agent`,
    platform: 'sdk',
    constitution_accepted_at: '2026-07-12T00:00:00.000Z',
    public_key: 'a'.repeat(128),
    challenge_id: `watcher-registration-challenge-${suffix}`,
    signature: 'ab'.repeat(64),
  });
  expect(response.status).toBe(201);
}

async function registerThroughCanonicalHumanRoute(
  fake: FakeFirestore,
  address: string,
  observedHeadBlock = 140,
  suffix = 'newcomer',
): Promise<void> {
  const handler = createHumanWalletRegistrationHandler({
    db: fake as unknown as Firestore,
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
    processGenesisQualification: async (qualificationId) => ({
      qualificationId,
      status: 'pending_activation',
      reason: 'activation_missing',
      peId: null,
      reservedAtomic: '0',
    }),
    readBaseRegistrationHead: async () => observedHeadBlock,
    makeId: (() => {
      let id = 0;
      return () => `watcher-human-${suffix}-${++id}`;
    })(),
  });
  const req = {
    user: {
      id: `watcher-${suffix}-human`,
      device_id: `watcher-human-device-${suffix}`,
    },
    body: {
      publicKey: 'b'.repeat(128),
      address,
      address_proof: await proofForAddress(address, [NEW_ONE_SIGNER, NEW_TWO_SIGNER], {
        userId: `watcher-${suffix}-human`,
        deviceId: `watcher-human-device-${suffix}`,
        nowMs: Date.now(),
      }),
    },
  } as unknown as Request;
  const captured: { status: number; body?: Record<string, unknown> } = { status: 0 };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  await handler(req, res, () => undefined);
  expect(captured.status).toBe(201);
}

describe('lossless dynamic watcher membership', () => {
  it.each([
    ['agent', registerThroughCanonicalAgentRoute],
    ['human', registerThroughCanonicalHumanRoute],
  ] as const)(
    'generation-fences the actual production inbound path for a newly registered native %s wallet',
    async (_ownerType, registerNewcomer) => {
      const fake = createFakeFirestore();
      const logs: InboundTransferLog[] = [];
      const emitted: string[] = [];
      await registerThroughCanonicalAgentRoute(
        fake,
        EXISTING,
        99,
        `existing-${_ownerType}`,
      );

      // Establish checkpoint C=130 and the original live membership through
      // production Firestore enumeration.
      await scanInboundUsdc(productionInboundDeps({
        fake,
        logs,
        emitted,
        head: 141,
      }), { startBlock: 100 });
      const checkpointBefore = fake.store.get('genesis_inbound_checkpoints/8453');
      expect(checkpointBefore).toMatchObject({
        last_processed_block: 130,
        membership_generation: 1,
      });

      const barrier = asyncBarrier();
      const oldWorker = scanInboundUsdc(productionInboundDeps({
        fake,
        logs,
        emitted,
        onFetch: barrier.wait,
      }));
      await barrier.entered;

      // Registration itself observes head 140, creates admission from H+1,
      // and invalidates G before any later watcher is allowed to run.
      await registerNewcomer(fake, NEW_ONE, 140, `newcomer-${_ownerType}`);
      const preRegistration = inboundLog(NEW_ONE, 140, 'native-pre-registration');
      const eligible = inboundLog(NEW_ONE, 150, 'native-eligible-race');
      logs.push(preRegistration, eligible, eligible);

      // No second watcher runs here: the canonical registration transaction
      // already owns the admission and generation fence.
      expect(admissionRows(fake, 'inbound')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          address: NEW_ONE,
          eligibility_start_block: 141,
          catch_up_through_block: 140,
          backfill_next_block: 141,
          state: 'live',
          membership_generation: 2,
          generation_fenced_at_registration: true,
        }),
      ]));

      barrier.release();
      await expect(oldWorker).rejects.toThrow('watcher_membership_generation_changed');
      expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
        last_processed_block: 130,
        membership_generation: 2,
      });

      const recovered = await scanInboundUsdc(productionInboundDeps({
        fake,
        logs,
        emitted,
      }));
      await scanInboundUsdc(productionInboundDeps({ fake, logs, emitted }));
      expect(recovered.duplicates_skipped).toBe(1);
      expect(emitted).toEqual([eligible.txHash]);
      expect(emitted).not.toContain(preRegistration.txHash);
      expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
        last_processed_block: 200,
        membership_generation: 2,
      });
    },
  );

  it('admits multiple native production newcomers independently', async () => {
    const fake = createFakeFirestore();
    const logs: InboundTransferLog[] = [];
    const emitted: string[] = [];
    await registerThroughCanonicalAgentRoute(fake, EXISTING, 99, 'existing-multi');
    await scanInboundUsdc(productionInboundDeps({ fake, logs, emitted, head: 141 }), {
      startBlock: 100,
    });

    await registerThroughCanonicalAgentRoute(fake, NEW_ONE, 140, 'multi-agent');
    await registerThroughCanonicalHumanRoute(fake, NEW_TWO, 145, 'multi-human');
    const first = inboundLog(NEW_ONE, 150, 'native-multi-agent');
    const second = inboundLog(NEW_TWO, 175, 'native-multi-human');
    logs.push(first, second, first, second);

    await scanInboundUsdc(productionInboundDeps({ fake, logs, emitted }));
    expect(emitted.sort()).toEqual([first.txHash, second.txHash].sort());
    const newcomerAdmissions = admissionRows(fake, 'inbound').filter(
      (row) => row.address === NEW_ONE || row.address === NEW_TWO,
    );
    expect(newcomerAdmissions).toHaveLength(2);
    expect(newcomerAdmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: NEW_ONE, eligibility_start_block: 141, state: 'live' }),
      expect.objectContaining({ address: NEW_TWO, eligibility_start_block: 146, state: 'live' }),
    ]));
  });

  it('inbound generation-fences an older full scan after a newcomer becomes live at C', async () => {
    const fake = createFakeFirestore();
    fake.store.set('genesis_inbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 130,
      membership_generation: 0,
      updated_at: 1,
    });
    const watched = [nativeInbound];
    const logs: InboundTransferLog[] = [];
    const emitted: string[] = [];
    const newcomer = externalInbound(NEW_ONE, 120); // proof head H=119; rewards start H+1
    const sameHead = inboundLog(newcomer.address, 119, 'inbound-same-proof-head');
    const firstEligible = inboundLog(newcomer.address, 120, 'inbound-first-eligible');
    const racedEvent = inboundLog(newcomer.address, 150, 'inbound-live-checkpoint-race');
    const barrier = asyncBarrier();

    const olderRun = scanInboundUsdc(inboundDeps({
      fake,
      watched,
      logs,
      emitted,
      onFetch: barrier.wait,
    }));
    await barrier.entered;

    // The older worker already enumerated only the native wallet. A second full
    // watcher path now discovers the newcomer, backfills through C=130, and
    // transitions it to live while the first worker still owns C+1..D.
    watched.push(newcomer);
    logs.push(sameHead, firstEligible, racedEvent, racedEvent);
    await scanInboundUsdc(inboundDeps({
      fake,
      watched,
      logs,
      emitted,
      head: 141, // finalized through C=130 under inclusive H-11 finality
    }));
    expect(emitted).toEqual([firstEligible.txHash]);
    expect(admissionRows(fake, 'inbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: newcomer.address,
        state: 'live',
        backfill_next_block: 131,
        catch_up_through_block: 130,
        membership_generation: 2,
      }),
    ]));

    barrier.release();
    await expect(olderRun).rejects.toThrow('watcher_membership_generation_changed');
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 130,
      membership_generation: 2,
    });

    const catchUp = await scanInboundUsdc(inboundDeps({ fake, watched, logs, emitted }));
    await scanInboundUsdc(inboundDeps({ fake, watched, logs, emitted }));
    expect(catchUp.duplicates_skipped).toBe(1);
    expect(emitted).toEqual([firstEligible.txHash, racedEvent.txHash]);
    expect(emitted).not.toContain(sameHead.txHash);
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
      membership_generation: 2,
    });
  });

  it('outbound generation-fences an older full scan after a newcomer becomes live at C', async () => {
    const fake = createFakeFirestore();
    const existing = outbound(EXISTING, 100);
    const newcomer = outbound(NEW_ONE, 120);
    const watched = [existing];
    const logs: OutboundTransferLog[] = [];
    const emitted: string[] = [];

    // Establish C=130 and the existing address through the real full path.
    await scanOutboundUsdc(outboundDeps({
      fake,
      watched,
      logs,
      emitted,
      head: 141,
    }), { startBlock: 100 });
    expect(fake.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 130,
      membership_generation: 1,
    });

    const sameHead = outboundLog(newcomer.address, 119, 'outbound-same-proof-head');
    const firstEligible = outboundLog(newcomer.address, 120, 'outbound-first-eligible');
    const racedEvent = outboundLog(newcomer.address, 150, 'outbound-live-checkpoint-race');
    const barrier = asyncBarrier();
    const olderRun = scanOutboundUsdc(outboundDeps({
      fake,
      watched,
      logs,
      emitted,
      onFetch: barrier.wait,
    }));
    await barrier.entered;

    watched.push(newcomer);
    logs.push(sameHead, firstEligible, racedEvent, racedEvent);
    await scanOutboundUsdc(outboundDeps({
      fake,
      watched,
      logs,
      emitted,
      head: 141,
    }));
    expect(emitted).toEqual([firstEligible.txHash]);
    expect(admissionRows(fake, 'outbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: newcomer.address,
        state: 'live',
        backfill_next_block: 131,
        catch_up_through_block: 130,
        membership_generation: 2,
      }),
    ]));

    barrier.release();
    await expect(olderRun).rejects.toThrow('watcher_membership_generation_changed');
    expect(fake.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 130,
      membership_generation: 2,
    });

    const catchUp = await scanOutboundUsdc(outboundDeps({ fake, watched, logs, emitted }));
    await scanOutboundUsdc(outboundDeps({ fake, watched, logs, emitted }));
    expect(catchUp.duplicates_skipped).toBe(1);
    expect(emitted).toEqual([firstEligible.txHash, racedEvent.txHash]);
    expect(emitted).not.toContain(sameHead.txHash);
    expect(fake.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
      membership_generation: 2,
    });
  });

  it('rejects a stale concurrent checkpoint commit instead of regressing it', async () => {
    const fake = createFakeFirestore();
    fake.store.set('genesis_inbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 100,
      membership_generation: 0,
      updated_at: 1,
    });
    // Establish the pre-existing native member before racing two global
    // checkpoint writers; the race under test is checkpoint monotonicity.
    await scanInboundUsdc(inboundDeps({
      fake,
      watched: [nativeInbound],
      logs: [],
      emitted: [],
      head: 111,
    }));
    const highBarrier = asyncBarrier();
    const lowBarrier = asyncBarrier();
    const highRun = scanInboundUsdc(inboundDeps({
      fake,
      watched: [nativeInbound],
      logs: [],
      emitted: [],
      head: 211,
      onFetch: highBarrier.wait,
    }));
    const lowRun = scanInboundUsdc(inboundDeps({
      fake,
      watched: [nativeInbound],
      logs: [],
      emitted: [],
      head: 161,
      onFetch: lowBarrier.wait,
    }));
    await highBarrier.entered;
    await lowBarrier.entered;

    highBarrier.release();
    await highRun;
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
    });

    lowBarrier.release();
    await expect(lowRun).rejects.toThrow('watcher_checkpoint_changed');
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
    });
  });

  it('inbound catches an address added after enumeration through the advanced checkpoint exactly once', async () => {
    const fake = createFakeFirestore();
    const watched = [nativeInbound];
    const logs: InboundTransferLog[] = [];
    const emitted: string[] = [];
    const newcomer = externalInbound();
    const event = inboundLog(newcomer.address, 150, 'inbound-interleaving');
    let interleaved = false;
    const deps = inboundDeps({
      fake,
      watched,
      logs,
      emitted,
      onFetch: () => {
        if (interleaved) return;
        interleaved = true;
        watched.push(newcomer);
        logs.push(event);
      },
    });

    await scanInboundUsdc(deps, { startBlock: 100 });
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
    });
    expect(emitted).toEqual([]);

    await scanInboundUsdc(deps);
    await scanInboundUsdc(deps);
    expect(emitted).toEqual([event.txHash]);
    expect(admissionRows(fake, 'inbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: newcomer.address,
        eligibility_start_block: 120,
        state: 'live',
        backfill_next_block: 201,
        catch_up_through_block: 200,
      }),
    ]));
  });

  it('outbound catches an address added after enumeration through the advanced checkpoint exactly once', async () => {
    const fake = createFakeFirestore();
    const existing = outbound(EXISTING, 100);
    const newcomer = outbound();
    const watched = [existing];
    const logs: OutboundTransferLog[] = [];
    const emitted: string[] = [];
    const event = outboundLog(newcomer.address, 150, 'outbound-interleaving');
    let interleaved = false;
    const deps = outboundDeps({
      fake,
      watched,
      logs,
      emitted,
      onFetch: () => {
        if (interleaved) return;
        interleaved = true;
        watched.push(newcomer);
        logs.push(event);
      },
    });

    await scanOutboundUsdc(deps, { startBlock: 100 });
    expect(fake.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
    });
    expect(emitted).toEqual([]);

    await scanOutboundUsdc(deps);
    await scanOutboundUsdc(deps);
    expect(emitted).toEqual([event.txHash]);
    expect(admissionRows(fake, 'outbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: newcomer.address,
        eligibility_start_block: 120,
        state: 'live',
        backfill_next_block: 201,
      }),
    ]));
  });

  // -------------------------------------------------------------------------
  // COMPOSITION — the empty-advance is a DIFFERENT way to reach an
  // advanced checkpoint than the band scan every test above uses. The
  // fix (advanceEmptyWatcherCheckpoint) moves the global cursor to head while
  // the watched set is empty; its safety rests on the claim that an address
  // admitted LATER, with a fence BEHIND the empty-advanced cursor, still
  // backfills its full (fence, cursor] window and never skips its pre-link
  // activity. No existing test reaches the advanced checkpoint via the empty
  // path, so this composes the two features the fix created in ONE flow.
  //
  // RED negative control (proven failing under mutation, recorded in the
  // commit): set ensureWatcherAddressAdmission's catch_up ceiling to
  // `eligibility_start_block - 1` (drop the checkpoint/input terms) and the
  // newcomer goes live immediately with NO backfill; the band then starts at
  // cursor+1 so the in-window event is never scanned and `emitted` stays []
  // — the exact "silently skips its pre-link window" failure. The below-fence
  // assertion keeps the recovery assertion non-vacuous: `emitted` must be the
  // backfill catching the (fence, cursor] window, not the fence being ignored.
  // -------------------------------------------------------------------------
  it('outbound: a behind-cursor-fence newcomer recovers its full window after an EMPTY-set advance', async () => {
    const fake = createFakeFirestore();
    const emitted: string[] = [];

    // Run 1 — the watched set is EMPTY (the normal pre-launch state, every
    // agent platform:'test'). The cursor must ADVANCE to head-minConf (200 for
    // head 211), not freeze. No newcomer is present, so this is unambiguously
    // the empty-advance path — not a side effect of scanning any address.
    const runEmpty = await scanOutboundUsdc(outboundDeps({
      fake, watched: [], logs: [], emitted, head: 211,
    }));
    expect(runEmpty.watched_addresses).toBe(0);
    expect(fake.store.get('activity_outbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
      membership_generation: 0,
    });

    // Run 2 — a newcomer whose fence (120) sits BEHIND the empty-advanced
    // cursor (200) appears, with an in-window event at 150 and a below-fence
    // event at 110. (120, 200] is exactly the pre-link range that would be
    // silently skipped if the empty-advance had marked it "covered".
    const newcomer = outbound(NEW_ONE, 120);
    const inWindow = outboundLog(newcomer.address, 150, 'empty-advance-outbound-in-window');
    const belowFence = outboundLog(newcomer.address, 110, 'empty-advance-outbound-below-fence');
    const watched = [newcomer];
    const logs = [inWindow, belowFence];
    await scanOutboundUsdc(outboundDeps({ fake, watched, logs, emitted, head: 211 }));
    await scanOutboundUsdc(outboundDeps({ fake, watched, logs, emitted, head: 211 }));

    // Recovered: the in-window event IS emitted (backfilled from the fence up
    // to the empty-advanced cursor). Below-fence never earns (fence holds).
    expect(emitted).toEqual([inWindow.txHash]);
    expect(emitted).not.toContain(belowFence.txHash);
    expect(admissionRows(fake, 'outbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: newcomer.address,
        eligibility_start_block: 120,
        state: 'live',
        backfill_next_block: 201,   // backfilled the ENTIRE 120..200 window
        catch_up_through_block: 200, // == the empty-advanced cursor
      }),
    ]));
  });

  it('inbound: a behind-cursor-fence newcomer recovers its full window after an EMPTY-set advance', async () => {
    const fake = createFakeFirestore();
    const emitted: string[] = [];

    // Run 1 — empty inbound watched set → cursor advances to 200 (head 211).
    const runEmpty = await scanInboundUsdc(inboundDeps({
      fake, watched: [], logs: [], emitted, head: 211,
    }));
    expect(runEmpty.watched_wallets).toBe(0);
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toMatchObject({
      last_processed_block: 200,
      membership_generation: 0,
    });

    // Run 2 — behind-cursor-fence newcomer (fence 120) with in-window (150)
    // and below-fence (110) events.
    const newcomer = externalInbound(NEW_ONE, 120);
    const inWindow = inboundLog(newcomer.address, 150, 'empty-advance-inbound-in-window');
    const belowFence = inboundLog(newcomer.address, 110, 'empty-advance-inbound-below-fence');
    const watched = [newcomer];
    const logs = [inWindow, belowFence];
    await scanInboundUsdc(inboundDeps({ fake, watched, logs, emitted, head: 211 }));
    await scanInboundUsdc(inboundDeps({ fake, watched, logs, emitted, head: 211 }));

    expect(emitted).toEqual([inWindow.txHash]);
    expect(emitted).not.toContain(belowFence.txHash);
    expect(admissionRows(fake, 'inbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: newcomer.address,
        eligibility_start_block: 120,
        state: 'live',
        backfill_next_block: 201,
        catch_up_through_block: 200,
      }),
    ]));
  });

  it('persists the inbound backfill cursor across a crash and deduplicates repeated logs', async () => {
    const fake = createFakeFirestore();
    const checkpoint = {
      chain_id: 8453,
      last_processed_block: 200,
      membership_generation: 0,
      updated_at: 1,
    };
    fake.store.set('genesis_inbound_checkpoints/8453', checkpoint);
    const newcomer = externalInbound();
    const event = inboundLog(newcomer.address, 150, 'inbound-crash');
    const emitted: string[] = [];
    const crashing = inboundDeps({
      fake,
      watched: [newcomer],
      logs: [event, event],
      emitted,
      beforeBackfillCursorAdvance: async () => {
        throw new Error('simulated_process_crash');
      },
    });

    // blockChunk pinned so the event's block (150) sits in the FIRST backfill
    // window and the emit precedes the crashing cursor advance — the persistence
    // semantics under test are chunk-size-agnostic (the default is 10).
    await expect(scanInboundUsdc(crashing, { blockChunk: 100 })).rejects.toThrow('simulated_process_crash');
    expect(emitted).toEqual([event.txHash]);
    expect(admissionRows(fake, 'inbound')).toEqual([
      expect.objectContaining({ state: 'backfilling', backfill_next_block: 120 }),
    ]);
    expect(fake.store.get('genesis_inbound_checkpoints/8453')).toEqual(checkpoint);

    const retried = await scanInboundUsdc(inboundDeps({
      fake,
      watched: [newcomer],
      logs: [event, event],
      emitted,
    }));
    expect(retried.duplicates_skipped).toBe(2);
    expect(emitted).toEqual([event.txHash]);
    expect(admissionRows(fake, 'inbound')).toEqual([
      expect.objectContaining({ state: 'live', backfill_next_block: 201 }),
    ]);
  });

  it('retains an outbound claim across RPC/finality disagreement and emits once after agreement', async () => {
    const fake = createFakeFirestore();
    fake.store.set('activity_outbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 200,
      membership_generation: 0,
      updated_at: 1,
    });
    const newcomer = outbound();
    const event = outboundLog(newcomer.address, 150, 'outbound-reorg');
    const emitted: string[] = [];
    let disagreement = true;
    const deps = outboundDeps({
      fake,
      watched: [newcomer],
      logs: [event],
      emitted,
      verificationError: () => disagreement
        ? new Error('economic_discovery_rpc_disagreement:receipt')
        : null,
    });

    const disagreed = await scanOutboundUsdc(deps);
    expect(disagreed.errors).toBe(1);
    expect(emitted).toEqual([]);
    expect(admissionRows(fake, 'outbound')).toEqual([
      expect.objectContaining({ state: 'live', backfill_next_block: 201 }),
    ]);

    disagreement = false;
    await scanOutboundUsdc(deps);
    await scanOutboundUsdc(deps);
    expect(emitted).toEqual([event.txHash]);
  });

  it('admits and catches up multiple inbound addresses independently in one run', async () => {
    const fake = createFakeFirestore();
    fake.store.set('genesis_inbound_checkpoints/8453', {
      chain_id: 8453,
      last_processed_block: 200,
      membership_generation: 0,
      updated_at: 1,
    });
    const first = externalInbound(NEW_ONE, 120);
    const second = externalInbound(NEW_TWO, 130);
    const firstEvent = inboundLog(first.address, 150, 'multi-first');
    const secondEvent = inboundLog(second.address, 175, 'multi-second');
    const emitted: string[] = [];

    await scanInboundUsdc(inboundDeps({
      fake,
      watched: [first, second],
      logs: [firstEvent, secondEvent],
      emitted,
    }));

    expect(emitted.sort()).toEqual([firstEvent.txHash, secondEvent.txHash].sort());
    expect(admissionRows(fake, 'inbound')).toHaveLength(2);
    expect(admissionRows(fake, 'inbound')).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: first.address, state: 'live', backfill_next_block: 201 }),
      expect.objectContaining({ address: second.address, state: 'live', backfill_next_block: 201 }),
    ]));
  });
});
