/**
 * The MONEY OUTCOME of the Solana chain-record lane, driven through the lane's PRODUCTION emit
 * (`buildSolanaChainRecordEmit`) and the real identity resolver into the REAL `generatePE` and the
 * REAL `recordPEAccrual` over a fake Firestore. Only the chain read is injected: jsonParsed
 * finalized transactions, projected exactly as production projects each leg. Nothing economic is
 * re-implemented — every verdict below is the unchanged seal speaking.
 *
 * GREEN, each beside the RED control that differs from it in one fact:
 * - a verified Solana send, a swap, and a receive from a counterparty the recipient has paid,
 *   seal eligible with PVT > 0, for a person and for an agent;
 * - a first receive from a stranger seals record_only;
 * - a transfer between two Solana addresses of ONE owner (native ↔ proven external), and a person
 *   paying their own linked agent on Solana, seal record_only;
 * - an x402 settlement the facilitator lane already minted never mints again here — and the gate
 *   is load-bearing: the same send emitted past it WOULD mint a second time (another claim kind).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import crypto from 'crypto';
import type { FakeFirestore } from './__test-helpers__/fake-firestore';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
  __esModule: true,
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
jest.mock('./beneficiary', () => ({
  resolveBeneficiary: async () => ({
    linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
  }),
}));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import type { Firestore } from 'firebase-admin/firestore';
import { recordPEAccrual } from '../../pvt-accrual';
import { meterActRow, meterActRows } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { base58Encode, solanaClaimSignature, solanaClaimSubject } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  SOLANA_PROVEN_ADDRESS_SCHEMA,
  createSolanaProofEvidence,
  type SolanaAddressOrigin,
  type SolanaProvenAddressRecord,
} from '../external-address/solana-link';
import { projectSolanaTransaction, hashSolanaTransactionEvidence, type SolanaAgreedTransaction } from '../onchain/solana-economic-discovery';
import {
  FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT,
  FACILITATOR_SOLANA_NETWORK,
  SOLANA_USDC_MINT,
  facilitatorActPeId,
  type SolanaParsedTransaction,
} from './x402-facilitator-settlement';
import {
  buildFacilitatorEmit,
  buildFacilitatorSolanaEmit,
  submitFacilitatorSettlement,
  type FacilitatorLaneDeps,
} from './x402-facilitator-lane';
import {
  SOLANA_COMMERCE_CUT_LINE_MS,
  buildSolanaChainRecordEmit,
  enqueueSolanaChainRecordObservation,
  runSolanaChainRecordDrain,
  solanaChainRecordObservationId,
  solanaChainRecordPeId,
  type SolanaChainRecordDeps,
} from './solana-chain-record-lane';
import { mintOnceClaimCollectionFor, mintOnceClaimDocId } from './mint-once-claim';
import { resolveFacilitatorSolanaIdentity } from './x402-facilitator-lane';

const OWNER = 'human_owner_1';
const H = { wallet: 'hw1', user: OWNER, address: '0xcccc00000000000000000000000000000000000c' };
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
const DAY = Date.UTC(2026, 9, 29, 12, 0, 0);
const PROVEN_SLOT = 470_000_000;
const SLOT = 470_000_500;
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FEE_WALLET = FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT;

const sol = (): string => base58Encode(crypto.randomBytes(32));
const sig = (): string => base58Encode(crypto.randomBytes(64));

let H_SOL = ''; // the person's native Solana address
let H_EXT = ''; // the same person's proven external Solana wallet
let A_SOL = ''; // the agent's Solana address
let STRANGER = '';

function realDeps(): AgentBankDeps {
  return {
    db: mockDb,
    cache: {},
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: (p: Record<string, unknown>) => recordPEAccrual(p as unknown as Parameters<typeof recordPEAccrual>[0]),
  } as unknown as AgentBankDeps;
}

function seedHuman(): void {
  mockDb.store.set(`wallets/${H.wallet}`, {
    id: H.wallet, user_id: H.user, type: 'human', address: H.address,
    native_watcher_registration: createNativeWalletRegistrationFence(1),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(H.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: H.address,
    wallet_id: H.wallet, owner_type: 'human', owner_id: H.user, created_at_ms: 1,
  });
}

function seedAgent(linkedHuman: string | null): void {
  mockDb.store.set(`agent_wallets/${A.wallet}`, {
    id: A.wallet, agent_id: A.agent, address: A.address, platform: 'claude', status: 'active',
    linked_human_user_id: linkedHuman, x402_payment_count: 0,
    native_watcher_registration: createNativeWalletRegistrationFence(1),
  });
  mockDb.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(A.address)}`, {
    schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: A.address,
    wallet_id: A.wallet, owner_type: 'agent', owner_id: A.agent, created_at_ms: 1,
  });
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(A.agent)}`, { wallet_id: A.wallet });
}

function seedProven(address: string, owner: 'agent' | 'human', origin: SolanaAddressOrigin = 'native'): void {
  const evidence = createSolanaProofEvidence({
    challengeId: crypto.randomUUID(), challengeMessage: 'm', signature: sig(), verifiedAtMs: DAY - 86_400_000,
  });
  const record: SolanaProvenAddressRecord = {
    schema_version: SOLANA_PROVEN_ADDRESS_SCHEMA, address, chain: 'solana', network: FACILITATOR_SOLANA_NETWORK,
    owner_type: owner, agent_id: owner === 'agent' ? A.agent : null, user_id: owner === 'human' ? H.user : null,
    wallet_id: owner === 'agent' ? A.wallet : H.wallet, owner_evm_address: owner === 'agent' ? A.address : H.address,
    origin, proven_at_ms: DAY - 86_400_000, proven_at_slot: PROVEN_SLOT, proof_method: 'ed25519',
    signature_hash: evidence.signature_sha256, proof_evidence: evidence, created_at: DAY - 86_400_000,
  };
  mockDb.store.set(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${address}`, { ...record });
}

// --- jsonParsed transactions (what each leg returns) -------------------------------------------

interface RawKey { pubkey: string; signer: boolean }
function raw(signature: string, keys: RawKey[], parts: {
  pre?: number[]; post?: number[]; preTok?: unknown[]; postTok?: unknown[];
  instructions: unknown[]; inner?: unknown[]; fee?: number;
}): SolanaParsedTransaction {
  return {
    slot: SLOT, blockTime: DAY / 1000,
    meta: {
      err: null, fee: parts.fee ?? 5000,
      preBalances: parts.pre ?? keys.map(() => 1_000_000_000),
      postBalances: parts.post ?? keys.map(() => 1_000_000_000),
      preTokenBalances: parts.preTok ?? [], postTokenBalances: parts.postTok ?? [],
      innerInstructions: parts.inner ?? [], logMessages: [], computeUnitsConsumed: 1,
    },
    transaction: { signatures: [signature], message: { accountKeys: keys.map((k) => ({ ...k, writable: true, source: 'transaction' })), instructions: parts.instructions } },
    version: 0,
  } as unknown as SolanaParsedTransaction;
}
const sysIx = (source: string, destination: string, lamports: number) => ({
  program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source, destination, lamports } }, stackHeight: 1,
});
const tokIx = (source: string, destination: string, authority: string, amount: string, mint = SOLANA_USDC_MINT) => ({
  program: 'spl-token', programId: TOKEN,
  parsed: { type: 'transferChecked', info: { source, destination, authority, mint, tokenAmount: { amount, decimals: 6 } } },
});
const bal = (accountIndex: number, owner: string, amount: string, mint = SOLANA_USDC_MINT) => ({
  accountIndex, owner, mint, programId: TOKEN, uiTokenAmount: { amount, decimals: 6, uiAmountString: 'x' },
});

/** A plain SOL transfer `from` → `to`, `from` signing and paying the fee. */
function solTransfer(signature: string, from: string, to: string, lamports = 250_000_000): SolanaParsedTransaction {
  return raw(signature, [{ pubkey: from, signer: true }, { pubkey: to, signer: false }, { pubkey: SYSTEM, signer: false }], {
    pre: [2_000_000_000, 0, 1], post: [2_000_000_000 - lamports - 5000, lamports, 1],
    instructions: [sysIx(from, to, lamports)],
  });
}

/** `who` swaps 1 SOL for 150 USDC through Jupiter v6 (inner System + SPL transfers). */
function solToUsdcSwap(signature: string, who: string): SolanaParsedTransaction {
  const [wAta, poolAta, pool] = [sol(), sol(), sol()];
  const P = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  return raw(signature, [
    { pubkey: who, signer: true }, { pubkey: wAta, signer: false }, { pubkey: poolAta, signer: false },
    { pubkey: pool, signer: false }, { pubkey: P, signer: false },
  ], {
    pre: [3_000_000_000, 2_039_280, 2_039_280, 50_000_000_000, 1],
    post: [2_000_000_000 - 5000, 2_039_280, 2_039_280, 51_000_000_000, 1],
    preTok: [bal(1, who, '0'), bal(2, pool, '900000000')],
    postTok: [bal(1, who, '150000000'), bal(2, pool, '750000000')],
    instructions: [{ programId: P, accounts: [], data: 'x', stackHeight: 1 }],
    inner: [{ index: 0, instructions: [sysIx(who, pool, 1_000_000_000), tokIx(poolAta, wAta, pool, '150000000')] }],
  });
}

/** An x402 facilitator settlement: buyer → seller USDC, buyer → fee wallet USDC, fee wallet pays. */
function settlement(signature: string, buyer: string, seller: string): SolanaParsedTransaction {
  const [bAta, sAta, fAta] = [sol(), sol(), sol()];
  return raw(signature, [
    { pubkey: FEE_WALLET, signer: true }, { pubkey: buyer, signer: true },
    { pubkey: bAta, signer: false }, { pubkey: sAta, signer: false }, { pubkey: fAta, signer: false },
  ], {
    pre: [50_000_000, 0, 2_039_280, 2_039_280, 2_039_280], post: [50_000_000 - 5000, 0, 2_039_280, 2_039_280, 2_039_280],
    preTok: [bal(2, buyer, '5000000'), bal(3, seller, '0'), bal(4, FEE_WALLET, '0')],
    postTok: [bal(2, buyer, String(5_000_000 - 1_000_000 - 50)), bal(3, seller, '1000000'), bal(4, FEE_WALLET, '50')],
    instructions: [
      { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: 'x' },
      { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: 'y' },
      tokIx(bAta, sAta, buyer, '1000000'),
      tokIx(bAta, fAta, buyer, '50'),
    ],
  });
}

const chain = new Map<string, SolanaParsedTransaction>();

/** What BOTH legs agree on for `signature`: the production projection of the one chain fixture. */
async function agreed(signature: string): Promise<SolanaAgreedTransaction | null> {
  const tx = chain.get(signature);
  if (!tx) return null;
  const projection = projectSolanaTransaction(JSON.parse(JSON.stringify(tx)));
  return { ...projection, providerOperatorIds: ['alchemy', 'allnodes'], evidenceHash: hashSolanaTransactionEvidence(projection) };
}

function laneDeps(): SolanaChainRecordDeps {
  return {
    db: mockDb as unknown as Firestore,
    env: {},
    readTransaction: agreed,
    emitActPE: buildSolanaChainRecordEmit(realDeps()),
    now: () => DAY + 3_600_000,
  };
}

/** Queue `signature` for each address and drain once. */
async function observe(signature: string, ...addresses: string[]): Promise<Map<string, string>> {
  for (const address of addresses) {
    await enqueueSolanaChainRecordObservation(mockDb as unknown as Firestore, { signature, address, slot: SLOT }, DAY + 3_600_000);
  }
  const report = await runSolanaChainRecordDrain(laneDeps());
  const byId = new Map(report.outcomes.map((o) => [o.id, o.outcome]));
  return new Map(addresses.map((a) => [a, byId.get(solanaChainRecordObservationId(signature, a)) ?? 'not_processed']));
}

function sealed(peId: string): Record<string, unknown> {
  const row = meterActRow(mockDb.store, peId);
  if (!row) throw new Error(`no metered act for ${peId}`);
  return row;
}
const minted = (peId: string): boolean => {
  const row = sealed(peId);
  return row.mint_status === 'eligible' && (row.estimatedPVT as number) > 0;
};
const peOf = (actionType: 'send' | 'swap' | 'receive', address: string, signature: string, ix: number): string =>
  solanaChainRecordPeId(actionType, address, `solana:${signature}:${ix}`);

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY + 3_600_000);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  [H_SOL, H_EXT, A_SOL, STRANGER] = [sol(), sol(), sol(), sol()];
  seedHuman();
  seedAgent('someone_else'); // a different owner: A and H are not the same owner
  seedProven(H_SOL, 'human', 'native');
  seedProven(H_EXT, 'human', 'external');
  seedProven(A_SOL, 'agent', 'native');
});
afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('Solana chain-record lane — the money outcome through the real seal', () => {
  it('the cut line is the landing day', () => {
    expect(SOLANA_COMMERCE_CUT_LINE_MS).toBe(Date.UTC(2026, 9, 29, 0, 0, 0));
    expect(DAY).toBeGreaterThan(SOLANA_COMMERCE_CUT_LINE_MS);
  });

  it('GREEN: a person\'s verified SOL send to a stranger mints at the financial base, on the person\'s chain, under the Solana claim', async () => {
    const s = sig();
    chain.set(s, solTransfer(s, H_SOL, STRANGER));
    expect((await observe(s, H_SOL)).get(H_SOL)).toBe('emitted:send');
    const pe = peOf('send', H_SOL, s, 0);
    expect(sealed(pe)).toMatchObject({ actionType: 'send', userId: OWNER, mint_status: 'eligible' });
    expect(minted(pe)).toBe(true);
    const factors = (sealed(pe).economic_snapshot as { recordTimeFactors: Record<string, unknown> }).recordTimeFactors;
    expect(factors).toMatchObject({ witnessClass: 'chain_witnessed', independentOriginCount: 1 });
    expect(mockDb.store.has(`${mintOnceClaimCollectionFor('financial_settlement')}/${mintOnceClaimDocId('financial_settlement',
      solanaClaimSubject(H_SOL) as string, `${solanaClaimSignature(s) as string}:0`)}`)).toBe(true);
  });

  it('GREEN: an agent\'s SOL→USDC swap mints', async () => {
    const s = sig();
    chain.set(s, solToUsdcSwap(s, A_SOL));
    expect((await observe(s, A_SOL)).get(A_SOL)).toBe('emitted:swap');
    const pe = peOf('swap', A_SOL, s, 0);
    expect(sealed(pe)).toMatchObject({ actionType: 'swap', userId: A.agent });
    expect(minted(pe)).toBe(true);
  });

  it('GREEN: a receive from a counterparty the recipient has PAID mints; RED: a first receive from a stranger records only', async () => {
    // The person pays STRANGER first (the pair is recorded by the seal, keyed on the exact base58).
    const out = sig();
    chain.set(out, solTransfer(out, H_SOL, STRANGER));
    await observe(out, H_SOL);
    const back = sig();
    chain.set(back, solTransfer(back, STRANGER, H_SOL, 100_000_000));
    expect((await observe(back, H_SOL)).get(H_SOL)).toBe('emitted:receive');
    expect(minted(peOf('receive', H_SOL, back, 0))).toBe(true);

    const other = sol();
    const unsolicited = sig();
    chain.set(unsolicited, solTransfer(unsolicited, other, H_SOL, 100_000_000));
    expect((await observe(unsolicited, H_SOL)).get(H_SOL)).toBe('emitted:receive');
    const row = sealed(peOf('receive', H_SOL, unsolicited, 0));
    expect(row).toMatchObject({ actionType: 'receive', mint_disposition: 'record_only', estimatedPVT: 0 });
  });

  it('one transfer between two watched parties: the sender\'s send and the recipient\'s receive are separate acts of separate actors', async () => {
    // A (agent) has paid H before, so H's receive from A is authored.
    const first = sig();
    chain.set(first, solTransfer(first, H_SOL, A_SOL));
    await observe(first, H_SOL);
    const s = sig();
    chain.set(s, solTransfer(s, A_SOL, H_SOL, 10_000_000));
    const out = await observe(s, A_SOL, H_SOL);
    expect(out.get(A_SOL)).toBe('emitted:send');
    expect(out.get(H_SOL)).toBe('emitted:receive');
    expect(minted(peOf('send', A_SOL, s, 0))).toBe(true);
    expect(minted(peOf('receive', H_SOL, s, 0))).toBe(true);
    expect(peOf('send', A_SOL, s, 0)).not.toBe(peOf('receive', H_SOL, s, 0));
  });

  it('two SIGNERS exchanging through one Jupiter instruction each derive a swap on it: two actors, two PEs, two mints', async () => {
    const s = sig();
    const [hA, aA, hB, aB] = [sol(), sol(), sol(), sol()];
    const [MA, MB, P] = ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'];
    chain.set(s, raw(s, [
      { pubkey: H_SOL, signer: true }, { pubkey: A_SOL, signer: true },
      { pubkey: hA, signer: false }, { pubkey: aA, signer: false }, { pubkey: hB, signer: false }, { pubkey: aB, signer: false },
      { pubkey: P, signer: false },
    ], {
      pre: [2_000_000_000, 2_000_000_000, 1, 1, 1, 1, 1], post: [2_000_000_000 - 5000, 2_000_000_000, 1, 1, 1, 1, 1],
      preTok: [bal(2, H_SOL, '10', MA), bal(3, A_SOL, '0', MA), bal(4, H_SOL, '0', MB), bal(5, A_SOL, '20', MB)],
      postTok: [bal(2, H_SOL, '0', MA), bal(3, A_SOL, '10', MA), bal(4, H_SOL, '20', MB), bal(5, A_SOL, '0', MB)],
      instructions: [{ programId: P, accounts: [], data: 'x' }],
      inner: [{ index: 0, instructions: [tokIx(hA, aA, H_SOL, '10', MA), tokIx(aB, hB, A_SOL, '20', MB)] }],
    }));
    const out = await observe(s, H_SOL, A_SOL);
    expect(out.get(H_SOL)).toBe('emitted:swap');
    expect(out.get(A_SOL)).toBe('emitted:swap');
    const hPe = peOf('swap', H_SOL, s, 0);
    const aPe = peOf('swap', A_SOL, s, 0);
    expect(hPe).not.toBe(aPe);
    expect(sealed(hPe)).toMatchObject({ userId: OWNER, actionType: 'swap' });
    expect(sealed(aPe)).toMatchObject({ userId: A.agent, actionType: 'swap' });
    expect(minted(hPe) && minted(aPe)).toBe(true);
  });

  it('RED (same-owner fence): native → the same person\'s proven external Solana wallet seals record_only', async () => {
    const s = sig();
    chain.set(s, solTransfer(s, H_SOL, H_EXT));
    expect((await observe(s, H_SOL)).get(H_SOL)).toBe('emitted:send');
    expect(sealed(peOf('send', H_SOL, s, 0))).toMatchObject({
      actionType: 'send', mint_disposition: 'record_only', disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
  });

  it('RED (same-owner fence): a person paying their OWN linked agent on Solana seals record_only; control: linked elsewhere, the same send mints', async () => {
    seedAgent(OWNER);
    const s = sig();
    chain.set(s, solTransfer(s, H_SOL, A_SOL));
    await observe(s, H_SOL);
    expect(sealed(peOf('send', H_SOL, s, 0))).toMatchObject({ mint_disposition: 'record_only', estimatedPVT: 0 });
    seedAgent('someone_else');
    const s2 = sig();
    chain.set(s2, solTransfer(s2, H_SOL, A_SOL));
    await observe(s2, H_SOL);
    expect(minted(peOf('send', H_SOL, s2, 0))).toBe(true);
  });

  it('RED (no lowercased key ever authors a receive): a pair recorded under the lowercased base58 does not', async () => {
    mockDb.store.set(`counterparty_pairs_v1/${H.user}__${STRANGER.toLowerCase()}`, {
      actor_id: H.user, counterparty: STRANGER.toLowerCase(), outbound_count: 1, last_outbound_at_ms: 1,
    });
    const s = sig();
    chain.set(s, solTransfer(s, STRANGER, H_SOL));
    await observe(s, H_SOL);
    expect(minted(peOf('receive', H_SOL, s, 0))).toBe(false);
  });

  it('REPLAY: the same signature observed twice and drained again seals one PE and mints once', async () => {
    const s = sig();
    chain.set(s, solTransfer(s, H_SOL, STRANGER));
    await observe(s, H_SOL);
    await observe(s, H_SOL);
    // even the emit run again directly returns the sealed PE (deterministic id + block time)
    const tx = await agreed(s);
    const identity = await resolveFacilitatorSolanaIdentity(mockDb as unknown as Firestore, H_SOL);
    const { deriveSolanaChainRecordAct } = await import('./solana-chain-record-derive');
    const d = deriveSolanaChainRecordAct(tx as SolanaAgreedTransaction, H_SOL, { excludedCounterparties: new Set() });
    if (d.status !== 'act' || identity === null) throw new Error('setup');
    await buildSolanaChainRecordEmit(realDeps())({
      identity, act: d.act, tx: tx as SolanaAgreedTransaction & { blockTimeMs: number }, counterpartyFenceAddress: STRANGER, signerFenceAddress: null,
    });
    expect(meterActRows(mockDb.store).filter((r) => r.mint_status === 'eligible')).toHaveLength(1);
  });
});

describe('cross-lane mint-once — an x402 settlement the facilitator lane minted never mints again here', () => {
  function facilitatorDeps(): FacilitatorLaneDeps {
    return {
      db: mockDb as unknown as Firestore,
      env: {},
      verifyBaseTransaction: async () => { throw new Error('not used'); },
      getSolanaTransaction: async (s) => (chain.has(s) ? JSON.parse(JSON.stringify(chain.get(s))) as SolanaParsedTransaction : null),
      emit: buildFacilitatorEmit(realDeps()),
      emitSolana: buildFacilitatorSolanaEmit(realDeps()),
      now: () => DAY + 3_600_000,
    };
  }
  const claimOf = (s: string, buyer: string, seller: string) => ({
    chain: 'solana' as const, txHash: s, buyer, seller, asset: SOLANA_USDC_MINT, amount: '1000000', fee: '50', scheme: 'svm_exact' as const,
  });

  it('before the facilitator reports, both parties wait; once it has minted both acts, this lane emits nothing', async () => {
    // The seller (H) has paid the buyer (A) before, so the facilitator's receive is authored.
    mockDb.store.set(`counterparty_pairs_v1/${H.user}__${A.address}`, { actor_id: H.user, counterparty: A.address, outbound_count: 1, last_outbound_at_ms: 1 });
    const s = sig();
    chain.set(s, settlement(s, A_SOL, H_SOL));
    const early = await observe(s, A_SOL, H_SOL);
    expect(early.get(A_SOL)).toBe('waiting:awaiting_facilitator_lane');
    expect(early.get(H_SOL)).toBe('waiting:awaiting_facilitator_lane');

    expect(await submitFacilitatorSettlement(facilitatorDeps(), claimOf(s, A_SOL, H_SOL))).toMatchObject({ status: 'recorded' });
    expect(minted(facilitatorActPeId('solana', s, 'buyer'))).toBe(true);
    expect(minted(facilitatorActPeId('solana', s, 'seller'))).toBe(true);

    // Let the waiting observations come due again, then drain.
    for (const a of [A_SOL, H_SOL]) {
      await mockDb.collection('solana_chain_record_observations').doc(solanaChainRecordObservationId(s, a)).update({ next_attempt_at_ms: 0 });
    }
    const report = await runSolanaChainRecordDrain(laneDeps());
    const byId = new Map(report.outcomes.map((o) => [o.id, o.outcome]));
    expect(byId.get(solanaChainRecordObservationId(s, A_SOL))).toBe('no_act:facilitator_lane_minted');
    expect(byId.get(solanaChainRecordObservationId(s, H_SOL))).toBe('no_act:facilitator_lane_minted');
    expect(meterActRows(mockDb.store).filter((r) => r.mint_status === 'eligible')).toHaveLength(2);
  });

  it('RED (the gate is load-bearing): past it, the buyer\'s send of the SAME settlement would mint a second time', async () => {
    const s = sig();
    chain.set(s, settlement(s, A_SOL, H_SOL));
    await submitFacilitatorSettlement(facilitatorDeps(), claimOf(s, A_SOL, H_SOL));
    expect(minted(facilitatorActPeId('solana', s, 'buyer'))).toBe(true);
    const tx = await agreed(s) as SolanaAgreedTransaction & { blockTimeMs: number };
    const identity = await resolveFacilitatorSolanaIdentity(mockDb as unknown as Firestore, A_SOL);
    const { deriveSolanaChainRecordAct } = await import('./solana-chain-record-derive');
    const d = deriveSolanaChainRecordAct(tx, A_SOL, { excludedCounterparties: new Set([FEE_WALLET]) });
    if (d.status !== 'act' || identity === null) throw new Error('setup');
    expect(d.act).toMatchObject({ actionType: 'send', counterparty: H_SOL, instructionIndex: 2 });
    const { peId } = await buildSolanaChainRecordEmit(realDeps())({
      identity, act: d.act, tx, counterpartyFenceAddress: H.address, signerFenceAddress: null,
    });
    // A different claim kind (financial settlement vs the x402 claim): it mints. Only the gate stops it.
    expect(minted(peId)).toBe(true);
  });
});
