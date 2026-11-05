/**
 * The Solana chain-record lane's discovery and drain, over a fake Firestore with injected chain
 * reads and a recording emit (the money outcome through the real accrual is the acceptance suite).
 * Every guard ships with the RED case that differs from its GREEN case in one fact.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { base58Encode } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  SOLANA_PROVEN_ADDRESS_SCHEMA,
  createSolanaProofEvidence,
  type SolanaProvenAddressRecord,
} from '../external-address/solana-link';
import {
  SOLANA_SYSTEM_PROGRAM,
  type SolanaAgreedTransaction,
  type SolanaSignaturePointer,
} from '../onchain/solana-economic-discovery';
import {
  SOLANA_CHAIN_RECORD_CURSORS_COLLECTION,
  SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION,
  SOLANA_CHAIN_RECORD_OBSERVATION_HORIZON_MS,
  SOLANA_COMMERCE_CUT_LINE_MS,
  enqueueSolanaChainRecordObservation,
  runSolanaChainRecordCycle,
  runSolanaChainRecordDiscovery,
  runSolanaChainRecordDrain,
  solanaChainRecordCursorId,
  solanaChainRecordObservationId,
  type SolanaChainRecordDeps,
  type SolanaChainRecordEmitInput,
  type SolanaChainRecordLimits,
} from './solana-chain-record-lane';
import { FACILITATOR_SETTLEMENTS_COLLECTION, type FacilitatorSolanaIdentity } from './x402-facilitator-lane';
import { FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT } from './x402-facilitator-settlement';

const addr = (): string => base58Encode(crypto.randomBytes(32));
const sig = (): string => base58Encode(crypto.randomBytes(64));
const NOW = SOLANA_COMMERCE_CUT_LINE_MS + 10 * 86_400_000;
const AFTER_CUT_S = Math.floor((SOLANA_COMMERCE_CUT_LINE_MS + 86_400_000) / 1000);
const FENCE = 400_000_000;

let db: FakeFirestore;
beforeEach(() => { db = createFakeFirestore(); });

function seedProven(address: string, provenAtSlot = FENCE): SolanaProvenAddressRecord {
  const evidence = createSolanaProofEvidence({ challengeId: crypto.randomUUID(), challengeMessage: 'm', signature: sig(), verifiedAtMs: 1 });
  const record: SolanaProvenAddressRecord = {
    schema_version: SOLANA_PROVEN_ADDRESS_SCHEMA, address, chain: 'solana',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', owner_type: 'human', agent_id: null, user_id: 'u1',
    wallet_id: 'w1', owner_evm_address: '0xcccc00000000000000000000000000000000000c', origin: 'native',
    proven_at_ms: 1, proven_at_slot: provenAtSlot, proof_method: 'ed25519', signature_hash: evidence.signature_sha256,
    proof_evidence: evidence, created_at: 1,
  };
  db.store.set(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${address}`, { ...record });
  return record;
}

// =============================================================================
// DISCOVERY
// =============================================================================

interface History { [account: string]: SolanaSignaturePointer[] }

function discoveryOf(legs: [History, History], opts: { floor?: number; tokenAccounts?: Record<string, string[]>; failLeg?: 0 | 1 } = {}) {
  const calls = { pages: 0 };
  return {
    calls,
    discovery: {
      finalizedSlotFloor: async () => opts.floor ?? FENCE + 1_000,
      tokenAccounts: async (owner: string) => opts.tokenAccounts?.[owner] ?? [],
      signaturesPage: async (leg: 0 | 1, account: string, page: { before: string | null; limit: number }) => {
        calls.pages += 1;
        if (opts.failLeg === leg) throw new Error(`solana_rpc_leg_failed:leg${leg}:getSignaturesForAddress:http_503`);
        const all = legs[leg][account] ?? [];
        const start = page.before === null ? 0 : all.findIndex((e) => e.signature === page.before) + 1;
        return all.slice(start, start + page.limit);
      },
    },
  };
}

const entry = (slot: number, opts: { ok?: boolean; timeS?: number | null } = {}): SolanaSignaturePointer => ({
  signature: sig(), slot, blockTimeMs: opts.timeS === null ? null : (opts.timeS ?? AFTER_CUT_S) * 1000, succeeded: opts.ok ?? true,
});

function deps(over: Partial<SolanaChainRecordDeps>): SolanaChainRecordDeps {
  return {
    db: db as unknown as Firestore,
    env: {},
    readTransaction: async () => null,
    emitActPE: async () => { throw new Error('not used'); },
    now: () => NOW,
    ...over,
  };
}

const queued = (): Array<Record<string, unknown>> => [...db.store.entries()]
  .filter(([k]) => k.startsWith(`${SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION}/`)).map(([, v]) => v as Record<string, unknown>);

describe('discovery — a pointer read, bounded, never evidence', () => {
  it('queues the UNION of both legs over the address and its token accounts, inside (fence, finalized floor] and from the landing on', async () => {
    const W = addr();
    const ata = addr();
    seedProven(W);
    const shared = entry(FENCE + 50);
    const onlyA = entry(FENCE + 40);
    const onlyB = entry(FENCE + 30);
    const intoAta = entry(FENCE + 20);
    const failed = entry(FENCE + 45, { ok: false });
    const aboveFloor = entry(FENCE + 5_000);
    const beforeCut = entry(FENCE + 10, { timeS: Math.floor(SOLANA_COMMERCE_CUT_LINE_MS / 1000) - 60 });
    const atFence = entry(FENCE);
    const { discovery } = discoveryOf([
      { [W]: [aboveFloor, shared, failed, onlyA, beforeCut, atFence], [ata]: [intoAta] },
      { [W]: [aboveFloor, shared, failed, onlyB, beforeCut, atFence], [ata]: [intoAta] },
    ], { tokenAccounts: { [W]: [ata] } });
    const report = await runSolanaChainRecordDiscovery(deps({ discovery }));
    expect(report).toMatchObject({ owners: 1, accounts: 2, queued: 4, errors: 0, passes_completed: 2 });
    const got = new Set(queued().map((o) => o.signature));
    // GREEN: what either leg reported (an omission by one is covered), and the token account's receive
    expect(got).toEqual(new Set([shared.signature, onlyA.signature, onlyB.signature, intoAta.signature]));
    // RED: a failed transaction, one above the agreed floor, one before the landing, one in the fence slot
    for (const e of [failed, aboveFloor, beforeCut, atFence]) expect(got.has(e.signature)).toBe(false);
    // every observation is the OWNER's (a token account's signature is queued for the owner)
    expect(queued().every((o) => o.address === W)).toBe(true);
    expect(db.store.get(`${SOLANA_CHAIN_RECORD_CURSORS_COLLECTION}/${solanaChainRecordCursorId(W, W)}`))
      .toMatchObject({ low_slot: FENCE + 1_000, pass: null });
  });

  it('RED (a failed leg propagates): nothing is queued and the cursor does not move; the next cycle reads it all', async () => {
    const W = addr();
    seedProven(W);
    const e = entry(FENCE + 10);
    const history: History = { [W]: [e] };
    const failing = discoveryOf([history, history], { failLeg: 1 });
    const report = await runSolanaChainRecordDiscovery(deps({ discovery: failing.discovery }));
    expect(report).toMatchObject({ errors: 1, queued: 0 });
    expect(db.store.has(`${SOLANA_CHAIN_RECORD_CURSORS_COLLECTION}/${solanaChainRecordCursorId(W, W)}`)).toBe(false);
    const healthy = discoveryOf([history, history]);
    expect(await runSolanaChainRecordDiscovery(deps({ discovery: healthy.discovery }))).toMatchObject({ errors: 0, queued: 1 });
  });

  it('a long history is read across cycles (bounded pages, persisted pass) and never re-read once done', async () => {
    const W = addr();
    seedProven(W);
    const history: History = { [W]: [5, 4, 3, 2, 1].map((n) => entry(FENCE + n * 10)) };
    const { discovery, calls } = discoveryOf([history, history]);
    const limits: Partial<SolanaChainRecordLimits> = { pagesPerLeg: 1, pageSize: 2 };
    const L = { ...(await import('./solana-chain-record-lane')).SOLANA_CHAIN_RECORD_LIMITS, ...limits };
    const r1 = await runSolanaChainRecordDiscovery(deps({ discovery }), L);
    expect(r1).toMatchObject({ queued: 2, passes_completed: 0 });
    const r2 = await runSolanaChainRecordDiscovery(deps({ discovery }), L);
    expect(r2).toMatchObject({ queued: 2, passes_completed: 0 });
    const r3 = await runSolanaChainRecordDiscovery(deps({ discovery }), L);
    expect(r3).toMatchObject({ queued: 1, passes_completed: 1 });
    expect(queued()).toHaveLength(5);
    const pagesSoFar = calls.pages;
    // Done: the next cycle starts a new pass from the new floor and finds nothing new.
    const r4 = await runSolanaChainRecordDiscovery(deps({ discovery }), L);
    expect(r4).toMatchObject({ queued: 0 });
    expect(calls.pages - pagesSoFar).toBeLessThanOrEqual(2);
  });

  it('watched addresses are visited in rotation, and the rotation wraps', async () => {
    const [A, B] = [addr(), addr()].sort();
    seedProven(A);
    seedProven(B);
    const { discovery } = discoveryOf([{}, {}]);
    const L = { ...(await import('./solana-chain-record-lane')).SOLANA_CHAIN_RECORD_LIMITS, ownersPerCycle: 1 };
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await runSolanaChainRecordDiscovery(deps({ discovery }), L);
      if ('outcomes' in r && r.outcomes[0]) seen.push(r.outcomes[0].address);
      else seen.push('-');
    }
    expect(seen.slice(0, 2)).toEqual([A, B]);
    expect(seen.slice(2).filter((s) => s !== '-')[0]).toBe(A);
  });

  it('more token accounts than the per-cycle cap are scanned in a rotating window: none is skipped for good', async () => {
    const W = addr();
    seedProven(W);
    const atas = [addr(), addr(), addr()].sort();
    const history: History = Object.fromEntries(atas.map((a, i) => [a, [entry(FENCE + 10 + i)]]));
    const { discovery } = discoveryOf([history, history], { tokenAccounts: { [W]: atas } });
    const L = { ...(await import('./solana-chain-record-lane')).SOLANA_CHAIN_RECORD_LIMITS, tokenAccountsPerOwner: 2 };
    const scanned = async (): Promise<number> => {
      const r = await runSolanaChainRecordDiscovery(deps({ discovery }), L);
      return 'accounts' in r ? r.accounts : -1;
    };
    expect(await scanned()).toBe(3); // the address + two token accounts
    expect(queued()).toHaveLength(2);
    expect(await scanned()).toBe(3);
    // RED control of the cap itself would be a never-rotating window: after two cycles all three are queued.
    expect(new Set(queued().map((o) => o.signature))).toEqual(new Set(atas.map((a) => history[a][0].signature)));
  });

  it('RED: a registry record that is not valid is never scanned', async () => {
    const W = addr();
    db.store.set(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${W}`, { address: W, owner_type: 'human' });
    const { discovery, calls } = discoveryOf([{ [W]: [entry(FENCE + 1)] }, { [W]: [entry(FENCE + 1)] }]);
    const report = await runSolanaChainRecordDiscovery(deps({ discovery }));
    expect(report).toMatchObject({ owners: 0, queued: 0, outcomes: [{ address: W, outcome: 'registry_record_invalid' }] });
    expect(calls.pages).toBe(0);
  });
});

// =============================================================================
// DRAIN
// =============================================================================

function identityOf(address: string, over: Partial<FacilitatorSolanaIdentity> = {}): FacilitatorSolanaIdentity {
  return {
    walletId: 'w1', agentId: 'u1', ownerType: 'human', address, provenAtSlot: FENCE,
    ownerEvmAddress: '0xcccc00000000000000000000000000000000000c', origin: 'native', ...over,
  };
}

function sendTx(signature: string, from: string, to: string, over: Partial<SolanaAgreedTransaction> = {}): SolanaAgreedTransaction {
  return {
    signature, slot: FENCE + 10, blockTimeMs: AFTER_CUT_S * 1000, version: '0', err: null, fee: '5000',
    accountKeys: [{ pubkey: from, signer: true, writable: true }, { pubkey: to, signer: false, writable: true }],
    preLamports: ['10000000', '0'], postLamports: ['8995000', '1000000'],
    preTokenBalances: [], postTokenBalances: [],
    instructions: [{ programId: SOLANA_SYSTEM_PROGRAM, type: 'transfer', transfer: { source: from, destination: to, authority: null, mint: null, amount: '1000000' }, inner: [] }],
    providerOperatorIds: ['op-a', 'op-b'], evidenceHash: `sha256:${'a'.repeat(64)}`,
    ...over,
  };
}

interface Harness {
  emitted: SolanaChainRecordEmitInput[];
  identities: Map<string, FacilitatorSolanaIdentity>;
  chain: Map<string, SolanaAgreedTransaction | null | Error>;
  run: (over?: Partial<SolanaChainRecordDeps>) => ReturnType<typeof runSolanaChainRecordDrain>;
  queue: (signature: string, address: string, requestedAt?: number) => Promise<string>;
  obs: (id: string) => Record<string, unknown>;
}

function harness(): Harness {
  const emitted: SolanaChainRecordEmitInput[] = [];
  const identities = new Map<string, FacilitatorSolanaIdentity>();
  const chain = new Map<string, SolanaAgreedTransaction | null | Error>();
  const h: Harness = {
    emitted, identities, chain,
    run: (over = {}) => runSolanaChainRecordDrain(deps({
      resolveIdentity: async (_db, address) => identities.get(address) ?? null,
      readTransaction: async (s) => {
        const v = chain.get(s);
        if (v instanceof Error) throw v;
        return v ?? null;
      },
      emitActPE: async (input) => { emitted.push(input); return { peId: `pe_test_${emitted.length}` }; },
      ...over,
    })),
    queue: async (signature, address, requestedAt = NOW) => {
      await enqueueSolanaChainRecordObservation(db as unknown as Firestore, { signature, address, slot: FENCE + 10 }, requestedAt);
      return solanaChainRecordObservationId(signature, address);
    },
    obs: (id) => db.store.get(`${SOLANA_CHAIN_RECORD_OBSERVATIONS_COLLECTION}/${id}`) as Record<string, unknown>,
  };
  return h;
}

describe('drain — verify on both legs, derive, gate, emit', () => {
  it('GREEN: a verified send emits once; the counterparty a stranger is handed over raw', async () => {
    const h = harness();
    const [W, X, s] = [addr(), addr(), sig()];
    h.identities.set(W, identityOf(W));
    h.chain.set(s, sendTx(s, W, X));
    const id = await h.queue(s, W);
    expect(await h.run()).toMatchObject({ emitted: 1, by_type: { send: 1 } });
    expect(h.emitted[0]).toMatchObject({ counterpartyFenceAddress: X, signerFenceAddress: null, act: { actionType: 'send', counterparty: X } });
    expect(h.obs(id)).toMatchObject({ status: 'complete', outcome: { pe_id: 'pe_test_1', action_type: 'send' } });
    // a second drain (and a second queue of the same pointer) emits nothing more
    expect(await h.queue(s, W)).toBe(id);
    expect(await h.run()).toMatchObject({ leased: 0, emitted: 0 });
  });

  it('a counterparty that is a proven Provian identity is handed to the fences as its owner\'s EVM address', async () => {
    const h = harness();
    const [W, X, s] = [addr(), addr(), sig()];
    h.identities.set(W, identityOf(W));
    h.identities.set(X, identityOf(X, { walletId: 'wA', agentId: 'agentA', ownerType: 'agent', ownerEvmAddress: '0xaaaa00000000000000000000000000000000000a' }));
    h.chain.set(s, sendTx(s, W, X));
    await h.queue(s, W);
    await h.run();
    expect(h.emitted[0].counterpartyFenceAddress).toBe('0xaaaa00000000000000000000000000000000000a');
  });

  it('RED fences of the lane itself: before the landing, at the proof slot, a failed transaction, an unproven address', async () => {
    const h = harness();
    const W = addr();
    h.identities.set(W, identityOf(W));
    const cases: Array<[string, SolanaAgreedTransaction | null, string]> = [];
    const early = sig();
    cases.push([early, sendTx(early, W, addr(), { blockTimeMs: SOLANA_COMMERCE_CUT_LINE_MS - 1 }), 'refused:before_landing']);
    const atFence = sig();
    cases.push([atFence, sendTx(atFence, W, addr(), { slot: FENCE }), 'refused:before_identity_fence']);
    const failed = sig();
    cases.push([failed, sendTx(failed, W, addr(), { err: '{"InstructionError":[0,"x"]}' }), 'refused:transaction_failed']);
    const ids: string[] = [];
    for (const [s, t] of cases) { h.chain.set(s, t); ids.push(await h.queue(s, W)); }
    const stranger = addr();
    const unproven = sig();
    h.chain.set(unproven, sendTx(unproven, stranger, addr()));
    const unprovenId = await h.queue(unproven, stranger);
    const report = await h.run();
    expect(report.emitted).toBe(0);
    const outcomes = new Map(report.outcomes.map((o) => [o.id, o.outcome]));
    cases.forEach(([, , expected], i) => expect(outcomes.get(ids[i])).toBe(expected));
    expect(outcomes.get(unprovenId)).toBe('refused:not_a_provian_identity');
    // GREEN control: one slot past the fence, after the landing, succeeded → emits
    const ok = sig();
    h.chain.set(ok, sendTx(ok, W, addr(), { slot: FENCE + 1 }));
    await h.queue(ok, W);
    expect((await h.run()).emitted).toBe(1);
  });

  it('a transaction not yet agreed waits (backing off); not found after the hour is refused; past the horizon it closes', async () => {
    const h = harness();
    const W = addr();
    h.identities.set(W, identityOf(W));
    const pending = sig();
    h.chain.set(pending, new Error('solana_discovery_rpc_disagreement:transaction'));
    const pendingId = await h.queue(pending, W);
    const missing = sig();
    const missingId = await h.queue(missing, W, NOW - 2 * 3_600_000);
    const fresh = sig();
    const freshId = await h.queue(fresh, W);
    const out = new Map((await h.run()).outcomes.map((o) => [o.id, o.outcome]));
    expect(out.get(pendingId)).toBe('waiting:solana_discovery_rpc_disagreement:transaction');
    expect(h.obs(pendingId).next_attempt_at_ms).toBeGreaterThan(NOW);
    expect(out.get(missingId)).toBe('refused:transaction_not_found');
    expect(out.get(freshId)).toBe('waiting:transaction_not_finalized');
    // past the horizon a still-disagreeing read closes the observation unminted
    const old = sig();
    h.chain.set(old, new Error('solana_discovery_rpc_disagreement:transaction'));
    const oldId = await h.queue(old, W, NOW - SOLANA_CHAIN_RECORD_OBSERVATION_HORIZON_MS - 1);
    const out2 = new Map((await h.run()).outcomes.map((o) => [o.id, o.outcome]));
    expect(out2.get(oldId)).toBe('refused:horizon_expired:solana_discovery_rpc_disagreement:transaction');
    expect(h.emitted).toHaveLength(0);
  });

  it('a lane whose legs are not configured skips the whole cycle and leases nothing', async () => {
    const h = harness();
    const W = addr();
    h.identities.set(W, identityOf(W));
    const s = sig();
    const id = await h.queue(s, W);
    const report = await runSolanaChainRecordCycle(deps({ assertConfigured: () => { throw new Error('SOLANA_RPC_URL is not set'); } }));
    expect(report).toEqual({ skipped: 'solana_rpc_not_configured:SOLANA_RPC_URL is not set' });
    expect(h.obs(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('cross-lane mint-once — a facilitator settlement is the facilitator lane\'s', () => {
  const FEE = FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT; // the fee wallet when no override is configured
  function facilitatorSend(s: string, W: string, X: string): SolanaAgreedTransaction {
    return sendTx(s, W, X, {
      accountKeys: [{ pubkey: FEE, signer: true, writable: true }, { pubkey: W, signer: true, writable: true }, { pubkey: X, signer: false, writable: true }],
      preLamports: ['50000000', '10000000', '0'], postLamports: ['49995000', '9000000', '1000000'],
    });
  }
  const pointer = (s: string, acts: unknown[], status = 'recorded') =>
    db.store.set(`${FACILITATOR_SETTLEMENTS_COLLECTION}/solana:${s}`, { status, acts });

  it('no pointer yet → waits; RED: the same transfer NOT paid by the facilitator emits at once', async () => {
    const h = harness();
    const [W, X] = [addr(), addr()];
    h.identities.set(W, identityOf(W));
    const viaFacilitator = sig();
    h.chain.set(viaFacilitator, facilitatorSend(viaFacilitator, W, X));
    const fid = await h.queue(viaFacilitator, W);
    const direct = sig();
    h.chain.set(direct, sendTx(direct, W, X));
    const did = await h.queue(direct, W);
    const out = new Map((await h.run()).outcomes.map((o) => [o.id, o.outcome]));
    expect(out.get(fid)).toBe('waiting:awaiting_facilitator_lane');
    expect(out.get(did)).toBe('emitted:send');
  });

  it('the facilitator\'s act for this address MINTED → this lane emits nothing; sealed at zero → this lane emits', async () => {
    const h = harness();
    const [W, X] = [addr(), addr()];
    h.identities.set(W, identityOf(W));
    const minted = sig();
    h.chain.set(minted, facilitatorSend(minted, W, X));
    pointer(minted, [{ role: 'buyer', address: W, action_type: 'x402_payment', recorded: true, pe_id: 'pe_fac_minted', reason: null }]);
    db.store.set('pe_history/pe_fac_minted', { mint_status: 'eligible' });
    const zero = sig();
    h.chain.set(zero, facilitatorSend(zero, W, X));
    pointer(zero, [{ role: 'buyer', address: W, action_type: 'x402_payment', recorded: true, pe_id: 'pe_fac_zero', reason: null }]);
    db.store.set('pe_history/pe_fac_zero', { mint_status: 'record_only' });
    const mid = await h.queue(minted, W);
    const zid = await h.queue(zero, W);
    const out = new Map((await h.run()).outcomes.map((o) => [o.id, o.outcome]));
    expect(out.get(mid)).toBe('no_act:facilitator_lane_minted');
    expect(out.get(zid)).toBe('emitted:send');
  });

  it('RED (ceilings): the facilitator\'s act REFUSED by a ceiling or eligibility rule → this lane emits nothing, never a send under another ceiling', async () => {
    const h = harness();
    const [W, X] = [addr(), addr()];
    h.identities.set(W, identityOf(W));
    const ids: string[] = [];
    for (const status of ['farm_capped', 'ineligible']) {
      const s = sig();
      h.chain.set(s, facilitatorSend(s, W, X));
      pointer(s, [{ role: 'buyer', address: W, action_type: 'x402_payment', recorded: true, pe_id: `pe_fac_${status}`, reason: null }]);
      db.store.set(`pe_history/pe_fac_${status}`, { mint_status: status, disposition_reason_code: 'daily_ceiling' });
      ids.push(await h.queue(s, W));
    }
    const out = new Map((await h.run()).outcomes.map((o) => [o.id, o.outcome]));
    for (const id of ids) expect(out.get(id)).toBe('no_act:facilitator_lane_refused_act');
  });

  it('a facilitator act still pending waits; no act for this address (another party) is clear; a refused pointer emits nothing', async () => {
    const h = harness();
    const [W, X] = [addr(), addr()];
    h.identities.set(W, identityOf(W));
    const pendingAct = sig();
    h.chain.set(pendingAct, facilitatorSend(pendingAct, W, X));
    pointer(pendingAct, [{ role: 'buyer', address: W, recorded: true, pe_id: 'pe_fac_pending' }]);
    db.store.set('pe_history/pe_fac_pending', { mint_status: 'pending_review' });
    const otherParty = sig();
    h.chain.set(otherParty, facilitatorSend(otherParty, W, X));
    pointer(otherParty, [{ role: 'seller', address: X, recorded: true, pe_id: 'pe_x' }, { role: 'buyer', address: W, recorded: false, pe_id: null, reason: 'before_identity_fence' }]);
    const refused = sig();
    h.chain.set(refused, facilitatorSend(refused, W, X));
    pointer(refused, [], 'refused');
    const [pid, oid, rid] = [await h.queue(pendingAct, W), await h.queue(otherParty, W), await h.queue(refused, W)];
    const out = new Map((await h.run()).outcomes.map((o) => [o.id, o.outcome]));
    expect(out.get(pid)).toBe('waiting:awaiting_facilitator_lane');
    expect(out.get(oid)).toBe('emitted:send');
    expect(out.get(rid)).toBe('no_act:facilitator_pointer_refused');
  });
});
