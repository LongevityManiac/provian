/**
 * the USDC watchers in registry mode (production deps over the fake Firestore; only the
 * chain is a double).
 *
 * What these pin, each with its RED control:
 * - a wallet registered AFTER the registry was seeded is watched from its first payment (RED: the
 * same wallet with its registry entry removed is missed — the registry is load-bearing);
 * - the daily reconcile finds a source row missing from the registry and the late record rescans
 * its whole fence-forward range, so the missed payment is claimed after all;
 * - the per-address resolution reaches the full enumerator's verdict for every address (RED: a
 * resolver that reads only the address's own index row disagrees on a contested wallet);
 * - a scheduled run's reads do not grow with wallet count (RED: the legacy full listing does);
 * - a failed read during per-address resolution holds the address instead of excluding it (RED:
 * without `strictReads` the same failure excludes the wallet).
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: async (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => ({
    ok: true as const,
    registration_context: {
      ...expected,
      credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
    },
  }),
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({
  ...(jest.requireActual('../jurisdiction/jurisdiction-policy') as object),
  getJurisdictionPolicy: async () => 'immediate',
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  buildBaseInboundDeps,
  enumerateInboundWatchedWallets,
  inboundSeenDocId,
  INBOUND_SEEN_COLLECTION,
  loadInboundSourcesFor,
  scanInboundUsdc,
  type InboundTransferLog,
  type InboundUsdcScanDeps,
  type WatchedWallet,
} from './inbound-usdc-watcher';
import {
  buildBaseOutboundDeps,
  enumerateOutboundWatchedAddresses,
  loadOutboundSourcesFor,
  scanOutboundUsdc,
  type OutboundUsdcScanDeps,
} from './outbound-usdc-watcher';
import { runWatchRegistryReconcile } from './watch-registry-reconcile';
import { WATCH_REGISTRY_COLLECTION, readWatchRegistry, watchRegistryAddresses } from './watch-registry';
import { admissionFromDocs, registryWatchSource } from './watch-source';
import { strictReads, WatchReadError } from './watch-read-error';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION } from './native-wallet-registration';
import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from './watcher-address-admission';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import { countingFirestore } from './__test-helpers__/counting-firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { seedCanonicalAgentAuthority, seedCanonicalHumanAuthority } from './__test-helpers__/canonical-authority';
import {
  BIRTH_ADDRESS,
  agentBankDeps,
  buildAgentRoute,
  createAgentWallet,
  type FakeDb,
} from './__test-helpers__/rotated-agent';

const SENDER = '0x9999999999999999999999999999999999999999';
const CHAIN_TIME_BASE_MS = Date.now() - 60_000;

let errorSpy: jest.SpiedFunction<typeof console.error>;
let warnSpy: jest.SpiedFunction<typeof console.warn>;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

function transfer(label: string, to: string, blockNumber: number): InboundTransferLog {
  return { txHash: testTxHash(label), logIndex: 3, blockNumber, fromAddress: SENDER, toAddress: to, amountAtomic: '1500000' };
}

function seenKey(log: InboundTransferLog): string {
  return `${INBOUND_SEEN_COLLECTION}/${inboundSeenDocId(8453, log.txHash, log.logIndex)}`;
}

/** Production inbound deps with the chain replaced by `logs` at `head`. */
function inboundOverChain(fake: FakeDb, logs: InboundTransferLog[], head: number): InboundUsdcScanDeps {
  return {
    ...buildBaseInboundDeps(agentBankDeps(fake)),
    now: () => Date.now(),
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock, toAddresses }) => {
      const wanted = new Set(toAddresses.map((a) => a.toLowerCase()));
      return logs.filter((log) => wanted.has(log.toAddress) && log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    verifyFundingEvent: async (wallet, event) => baseEconomicEvidence({
      transactionHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      fromAddress: event.fromAddress,
      toAddress: wallet.address,
      amountAtomic: event.amountAtomic,
      blockTimestampMs: CHAIN_TIME_BASE_MS + event.blockNumber,
    }),
  };
}

/** Remove one address from the watch registry, as a writer that forgot to record it would leave it. */
function dropFromRegistry(fake: FakeDb, address: string): void {
  for (const [key, value] of fake.store) {
    if (!key.startsWith(`${WATCH_REGISTRY_COLLECTION}/s`)) continue;
    const doc = value as { e?: Record<string, number> };
    if (!doc.e) continue;
    const kept = Object.fromEntries(Object.entries(doc.e).filter(([entry]) => !entry.endsWith(`|${address}`)));
    fake.store.set(key, { ...doc, e: kept });
  }
}

async function registryHas(fake: FakeDb, address: string): Promise<boolean> {
  const snapshot = await readWatchRegistry(fake as unknown as Firestore);
  return snapshot !== null && watchRegistryAddresses(snapshot).includes(address);
}

describe('a wallet registered after the registry was seeded', () => {
  /** First run over an empty network (seeds registry + marks), then the agent registers. */
  async function registeredAfterSeeding() {
    const { app, fake } = buildAgentRoute();
    // Head 100 → the watcher processes through 88, so the agent's birth fence (141) is ahead of
    // the checkpoint and its admission is LIVE at registration: no backfilling state makes it
    // pending — only its registry entry does.
    await scanInboundUsdc(inboundOverChain(fake, [], 100), { blockChunk: 100 });
    expect(await readWatchRegistry(fake as unknown as Firestore)).not.toBeNull();
    await createAgentWallet(app);
    return fake;
  }

  test('its first payment is claimed by the next scheduled run', async () => {
    const fake = await registeredAfterSeeding();
    expect(await registryHas(fake, BIRTH_ADDRESS)).toBe(true);
    const payment = transfer('first-payment', BIRTH_ADDRESS, 200);
    await scanInboundUsdc(inboundOverChain(fake, [payment], 400), { blockChunk: 100 });
    expect(fake.store.get(seenKey(payment))).toBeDefined();
  });

  test('RED CONTROL — the same wallet without its registry entry is missed by the run', async () => {
    const fake = await registeredAfterSeeding();
    dropFromRegistry(fake, BIRTH_ADDRESS);
    expect(await registryHas(fake, BIRTH_ADDRESS)).toBe(false);
    const payment = transfer('missed-payment', BIRTH_ADDRESS, 200);
    const report = await scanInboundUsdc(inboundOverChain(fake, [payment], 400), { blockChunk: 100 });
    expect(fake.store.get(seenKey(payment))).toBeUndefined();
    expect(report.to_block).toBeGreaterThan(payment.blockNumber);
  });

  test('the reconcile adds the missing entry and the late record rescans its range, claiming the payment', async () => {
    const fake = await registeredAfterSeeding();
    dropFromRegistry(fake, BIRTH_ADDRESS);
    const payment = transfer('late-payment', BIRTH_ADDRESS, 200);
    await scanInboundUsdc(inboundOverChain(fake, [payment], 400), { blockChunk: 100 });
    expect(fake.store.get(seenKey(payment))).toBeUndefined();

    const reconciled = await runWatchRegistryReconcile(fake as unknown as Firestore, Date.now(), { revision: 'r1' });
    expect(reconciled.missing_found).toBeGreaterThanOrEqual(1);
    expect(await registryHas(fake, BIRTH_ADDRESS)).toBe(true);

    await scanInboundUsdc(inboundOverChain(fake, [payment], 500), { blockChunk: 100 });
    expect(fake.store.get(seenKey(payment))).toBeDefined();
  });
});

/** Two valid agents, a human and an excluded test agent; optionally a contested wallet. */
function seededNetwork(extraAgents = 0, options: { contested?: boolean } = {}): FakeDb {
  const db = createFakeFirestore();
  seedCanonicalAgentAuthority({ db, walletId: 'agent-a', agentId: 'agent-a', address: '0x' + 'a1'.repeat(20), observedHead: 140 });
  seedCanonicalAgentAuthority({ db, walletId: 'agent-b', agentId: 'agent-b', address: '0x' + 'b2'.repeat(20), observedHead: 140 });
  seedCanonicalHumanAuthority({ db, walletId: 'human-h', userId: 'user-h', address: '0x' + 'c3'.repeat(20), observedHead: 140 });
  // The outbound human enumerator reads the wallet's `address` (the inbound one, `evm_address`).
  db.store.set('wallets/human-h', { ...(db.store.get('wallets/human-h') as Record<string, unknown>), address: '0x' + 'c3'.repeat(20) });
  seedCanonicalAgentAuthority({ db, walletId: 'agent-t', agentId: 'agent-t', address: '0x' + 'd4'.repeat(20), observedHead: 140, platform: 'test' });
  // The checkpoint the registrations raised: every seeded admission is generation 1.
  db.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453, last_processed_block: 150, membership_generation: 1, updated_at: 1,
  });
  if (options.contested) seedContestedWallet(db);
  for (let i = 0; i < extraAgents; i += 1) {
    const hex = (0x1000 + i).toString(16).padStart(4, '0');
    seedCanonicalAgentAuthority({
      db,
      walletId: `extra-${i}`,
      agentId: `extra-${i}`,
      address: `0x${hex.repeat(10)}`,
      observedHead: 140,
    });
  }
  return db;
}

/** agent-c: a second address-index row names its wallet with another address (a contest). */
function seedContestedWallet(db: FakeDb): void {
  seedCanonicalAgentAuthority({ db, walletId: 'agent-c', agentId: 'agent-c', address: CONTESTED[0], observedHead: 140 });
  db.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/address_agent-c-second`, {
    schema_version: 'native-wallet-address-index/v1',
    chain_id: 8453,
    address: CONTESTED[1],
    wallet_id: 'agent-c',
    owner_type: 'agent',
    owner_id: 'agent-c',
    created_at_ms: 1,
  });
}

const CONTESTED = ['0x' + 'e5'.repeat(20), '0x' + 'f6'.repeat(20)];
const NETWORK_ADDRESSES = ['a1', 'b2', 'c3', 'd4'].map((b) => '0x' + b.repeat(20));

type Verdict = { kind: 'valid'; wallet: WatchedWallet } | { kind: 'excluded' } | { kind: 'hold' };

async function fullVerdicts(fake: FakeDb): Promise<Map<string, Verdict>> {
  const wallets = await buildBaseInboundDeps(agentBankDeps(fake)).listWatchedWallets();
  const out = new Map<string, Verdict>();
  for (const address of NETWORK_ADDRESSES) {
    const match = wallets.filter((w) => w.address === address);
    out.set(address, match.length === 1 ? { kind: 'valid', wallet: match[0] } : { kind: 'excluded' });
  }
  return out;
}

async function scopedVerdicts(
  resolve: (address: string) => Promise<{ kind: string; wallet?: WatchedWallet }>,
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  for (const address of NETWORK_ADDRESSES) {
    const r = await resolve(address);
    out.set(address, r.kind === 'valid' ? { kind: 'valid', wallet: r.wallet as WatchedWallet } : { kind: r.kind as 'excluded' | 'hold' });
  }
  return out;
}

describe('per-address resolution matches the full enumeration', () => {
  test('every address gets the full enumerator verdict, wallet for wallet', async () => {
    const fake = seededNetwork();
    const full = await fullVerdicts(fake);
    // The fixture spans both verdicts: three watched, one excluded (test platform).
    expect([...full.values()].filter((v) => v.kind === 'valid')).toHaveLength(3);
    expect([...full.values()].filter((v) => v.kind === 'excluded')).toHaveLength(1);
    const source = buildBaseInboundDeps(agentBankDeps(fake)).watchSource!;
    await source.load(Date.now());
    const scoped = await scopedVerdicts((address) => source.resolve(address));
    expect(scoped).toEqual(full);
  });

  test('a contested wallet: the full listing refuses it, per-address resolution HOLDS both addresses', async () => {
    const fake = seededNetwork(0, { contested: true });
    await expect(buildBaseInboundDeps(agentBankDeps(fake)).listWatchedWallets())
      .rejects.toThrow('watched_address_enumeration_duplicate');
    const source = buildBaseInboundDeps(agentBankDeps(fake)).watchSource!;
    await source.load(Date.now());
    for (const address of CONTESTED) expect((await source.resolve(address)).kind).toBe('hold');
    // The rest of the network keeps its verdicts (the contest no longer stops everyone).
    expect((await source.resolve(NETWORK_ADDRESSES[0])).kind).toBe('valid');
  });

  test('RED CONTROL — a resolver reading only the address\'s own index row would WATCH the contested wallet', async () => {
    const fake = seededNetwork(0, { contested: true });
    const db = fake as unknown as Firestore;
    const naive = registryWatchSource<WatchedWallet>({
      db,
      watcher: 'inbound_usdc',
      direction: 'inbound',
      chainId: 8453,
      logPrefix: '[naive]',
      addressOf: (wallet) => wallet.address,
      resolveAddress: async (address, exclude) => {
        const sources = await loadInboundSourcesFor(db, address);
        // Drop every index row but the address's own: the sibling that contests the wallet is lost.
        const own = { ...sources, addressIndexDocs: sources.addressIndexDocs.filter((doc) => (doc.data() as { address?: string }).address === address) };
        return {
          wallets: await enumerateInboundWatchedWallets(db, own, exclude),
          admission: admissionFromDocs(sources.admissionDocs, 'inbound', 8453, address),
        };
      },
    });
    expect((await naive.resolve(CONTESTED[0])).kind).toBe('valid');
  });
});

describe('a scheduled run reads the same amount at any wallet count', () => {
  const READ_COLLECTIONS = [NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, 'agent_wallets', 'watcher_address_admissions_v1'];

  async function secondRunReads(extraAgents: number, legacy: boolean): Promise<number> {
    const fake = seededNetwork(extraAgents);
    // The first run seeds the registry and marks (a one-time O(wallets) pass).
    await scanInboundUsdc(inboundOverChain(fake, [], 200), { blockChunk: 100 });
    let total = 0;
    for (const collection of READ_COLLECTIONS) {
      const counted = countingFirestore(fake as unknown as Firestore, collection);
      const deps = { ...inboundOverChain(fake, [], 300), db: counted.db };
      const base = buildBaseInboundDeps({ ...agentBankDeps(fake), db: counted.db });
      const run: InboundUsdcScanDeps = legacy
        ? { ...deps, watchSource: undefined, listWatchedWallets: base.listWatchedWallets }
        : { ...deps, watchSource: base.watchSource, takeEnumerationExclusions: base.takeEnumerationExclusions };
      await scanInboundUsdc(run, { blockChunk: 100 });
      total += counted.docsRead();
    }
    return total;
  }

  test('registry mode: 60 more wallets read nothing more', async () => {
    // Both sizes leave at least 25 addresses for the second run's health sweep (25 per run), so
    // the sweep reads the same; everything else a quiet run reads is fixed-size.
    const small = await secondRunReads(60, false);
    const large = await secondRunReads(120, false);
    expect(large).toBe(small);
  });

  test('RED CONTROL — the legacy full listing reads every wallet each run', async () => {
    const small = await secondRunReads(60, true);
    const large = await secondRunReads(120, true);
    expect(large - small).toBeGreaterThanOrEqual(60);
  });
});

describe('a rolled-back checkpoint', () => {
  test('a normal registry run passes the generation high-water check', async () => {
    const fake = seededNetwork();
    await scanInboundUsdc(inboundOverChain(fake, [], 200), { blockChunk: 100 });
    await expect(scanInboundUsdc(inboundOverChain(fake, [], 300), { blockChunk: 100 })).resolves.toBeDefined();
  });

  test('RED CONTROL — a checkpoint below a marked admission\'s generation is refused, as the full run refused it', async () => {
    const fake = seededNetwork();
    await scanInboundUsdc(inboundOverChain(fake, [], 200), { blockChunk: 100 });
    // The checkpoint is replaced with an older one (generation 0): every marked address skips
    // its per-address check, so only the high water can notice.
    fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
      chain_id: 8453, last_processed_block: 150, membership_generation: 0, updated_at: 1,
    });
    await expect(scanInboundUsdc(inboundOverChain(fake, [], 300), { blockChunk: 100 }))
      .rejects.toThrow('watcher_address_admission_invalid:future_membership_generation');
    // The full listing refuses the same state through its per-address check.
    const legacy = { ...inboundOverChain(fake, [], 300), watchSource: undefined };
    await expect(scanInboundUsdc(legacy, { blockChunk: 100 }))
      .rejects.toThrow('watcher_address_admission_invalid:future_membership_generation');
  });
});

describe('a failed read during per-address resolution', () => {
  /** Wrap `db` so every read of `collection` (doc get, query get, getAll) fails; record what is read. */
  function readsOf(db: Firestore, failing: string | null, seen: Set<string>): Firestore {
    const wrap = (target: object, collection: string | null): object => new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') return value;
        if (prop === 'collection') {
          return (name: string, ...rest: unknown[]) => wrap((value as (...a: unknown[]) => object).apply(obj, [name, ...rest]), name);
        }
        if (prop === 'getAll') {
          return async (...refs: Array<{ path: string }>) => {
            for (const ref of refs) {
              const name = ref.path.split('/')[0];
              seen.add(name);
              if (name === failing) throw new Error('firestore_unavailable');
            }
            return (value as (...a: unknown[]) => Promise<unknown>).apply(obj, refs);
          };
        }
        if (prop === 'get' && collection !== null) {
          return async (...args: unknown[]) => {
            seen.add(collection);
            if (collection === failing) throw new Error('firestore_unavailable');
            return (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
          };
        }
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
          return result !== null && typeof result === 'object' && !(result instanceof Promise) ? wrap(result as object, collection) : result;
        };
      },
    });
    return wrap(db as unknown as object, null) as unknown as Firestore;
  }

  const AGENT = '0x' + 'a1'.repeat(20);
  const HUMAN = '0x' + 'c3'.repeat(20);
  type Enumerate = (db: Firestore, address: string, exclude: (e: unknown) => void) => Promise<Array<{ address: string }>>;
  const ENUMERATORS: ReadonlyArray<[string, Enumerate]> = [
    ['inbound', async (db, address, exclude) => enumerateInboundWatchedWallets(db, await loadInboundSourcesFor(db, address), exclude)],
    ['outbound', async (db, address, exclude) => enumerateOutboundWatchedAddresses(db, await loadOutboundSourcesFor(db, address), exclude)],
  ];

  for (const [direction, enumerate] of ENUMERATORS) {
    for (const address of [AGENT, HUMAN]) {
      test(`${direction} ${address === AGENT ? 'agent' : 'human'}: a failed read of ANY collection it reads holds, never excludes`, async () => {
        const fake = seededNetwork();
        const seen = new Set<string>();
        const clean = await enumerate(readsOf(fake as unknown as Firestore, null, seen), address, () => undefined);
        expect(clean.filter((w) => w.address === address)).toHaveLength(1);
        // The population: every collection a successful resolution reads.
        console.log(`[strict-reads] ${direction} ${address.slice(0, 6)} reads: ${[...seen].sort().join(', ')}`);
        expect(seen.size).toBeGreaterThanOrEqual(4);
        for (const collection of seen) {
          const excluded: unknown[] = [];
          const db = strictReads(readsOf(fake as unknown as Firestore, collection, new Set()));
          const outcome = await enumerate(db, address, (e) => excluded.push(e)).then(() => 'resolved', (e: unknown) => e);
          expect({ collection, held: outcome instanceof WatchReadError, excluded: excluded.length })
            .toEqual({ collection, held: true, excluded: 0 });
        }
      });
    }
  }

  test('RED CONTROL — without strictReads a failed identity read EXCLUDES the agent (its payment would be skipped)', async () => {
    const fake = seededNetwork();
    const db = readsOf(fake as unknown as Firestore, 'identity_pes_legacy_v1', new Set());
    const excluded: unknown[] = [];
    const wallets = await enumerateInboundWatchedWallets(db, await loadInboundSourcesFor(db, AGENT), (e) => excluded.push(e));
    expect(wallets.filter((w) => w.address === AGENT)).toHaveLength(0);
    expect(excluded.length).toBeGreaterThan(0);
  });
});

describe('outbound registry mode', () => {
  function outboundOverChain(fake: FakeDb, head: number, db?: Firestore): OutboundUsdcScanDeps {
    const base = buildBaseOutboundDeps({ ...agentBankDeps(fake), ...(db ? { db } : {}) });
    return { ...base, getBlockNumber: async () => head, getLogs: async () => [] };
  }

  test('per-address resolution matches the full listing', async () => {
    const fake = seededNetwork();
    const deps = buildBaseOutboundDeps(agentBankDeps(fake));
    const full = await deps.listWatchedAddresses();
    const source = deps.watchSource!;
    await source.load(Date.now());
    for (const address of NETWORK_ADDRESSES) {
      const resolved = await source.resolve(address);
      const match = full.filter((w) => w.address === address);
      if (match.length === 1) expect(resolved).toMatchObject({ kind: 'valid', wallet: match[0] });
      else expect(resolved.kind).toBe('excluded');
    }
  });

  async function outboundSecondRunReads(extraAgents: number, legacy: boolean): Promise<number> {
    const fake = seededNetwork(extraAgents);
    await scanOutboundUsdc(outboundOverChain(fake, 200), { blockChunk: 100 });
    const counted = countingFirestore(fake as unknown as Firestore, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION);
    const deps = outboundOverChain(fake, 300, counted.db);
    await scanOutboundUsdc(legacy ? { ...deps, watchSource: undefined } : deps, { blockChunk: 100 });
    return counted.docsRead();
  }

  test('a scheduled run reads the same at 60 or 120 more wallets', async () => {
    expect(await outboundSecondRunReads(120, false)).toBe(await outboundSecondRunReads(60, false));
  });

  test('RED CONTROL — the legacy full listing grows with wallet count', async () => {
    expect(await outboundSecondRunReads(120, true) - await outboundSecondRunReads(60, true)).toBeGreaterThanOrEqual(60);
  });
});
