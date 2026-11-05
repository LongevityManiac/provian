/**
 * follow-up — the MONEY OUTCOME of a SOLANA facilitator settlement, driven through the
 * PRODUCTION Solana emit (`buildFacilitatorSolanaEmit`) into the REAL `generatePE` and the REAL
 * `recordPEAccrual` over a fake Firestore. Only the chain read is injected (a jsonParsed finalized
 * transaction). Nothing economic is re-implemented here.
 *
 * the operator’s spec: every settlement is a relay-witnessed PE for both buyer and seller under the
 * existing pricing and mint-once rules. A Solana party is a Provian identity only through an
 * ed25519 proof in `solana_proven_addresses`, from the proof's slot forward. Every GREEN case ships
 * beside the RED control that differs from it in one fact.
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
import { generatePE } from '../agent-bank/pe-utils';
import { actRecorded, meterActRow, meterActRows } from './__test-helpers__/meter-acts';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import {
  FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT,
  FACILITATOR_SOLANA_NETWORK,
  SOLANA_USDC_MINT,
  facilitatorActPeId,
  type FacilitatorSettlementClaim,
  type SolanaParsedTransaction,
} from './x402-facilitator-settlement';
import {
  FACILITATOR_SETTLEMENTS_COLLECTION,
  buildFacilitatorEmit,
  buildFacilitatorSolanaEmit,
  processFacilitatorSettlement,
  submitFacilitatorSettlement,
  type FacilitatorLaneDeps,
} from './x402-facilitator-lane';
import { base58Encode, solanaClaimSignature, solanaClaimSubject } from '../external-address/solana-keys';
import {
  SOLANA_PROVEN_ADDRESSES_COLLECTION,
  SOLANA_PROVEN_ADDRESS_SCHEMA,
  createSolanaProofEvidence,
  type SolanaProvenAddressRecord,
} from '../external-address/solana-link';
import { COUNTERPARTY_PAIRS_COLLECTION, counterpartyPairDocId } from '../meter/counterparty-pairs';
import { mintOnceClaimCollectionFor, mintOnceClaimDocId } from './mint-once-claim';
import { reserveActivityMintCaps } from './activity-mint-limits';

const OWNER = 'human_owner_1';
const H = { wallet: 'hw1', user: OWNER, address: '0xcccc00000000000000000000000000000000000c' };
const A = { wallet: 'wA', agent: 'agentA', address: '0xaaaa00000000000000000000000000000000000a' };
const FEE_WALLET = FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const DAY = Date.UTC(2026, 9, 4, 12, 0, 0);
const PROVEN_SLOT = 300_000_000;
const SETTLE_SLOT = 300_000_500;

const sol = (): string => base58Encode(crypto.randomBytes(32));
const sig = (): string => base58Encode(crypto.randomBytes(64));

/** A's Solana address (an agent's), H's (a person's), and a stranger's. Fresh per test. */
let A_SOL = '';
let H_SOL = '';
let STRANGER_SOL = '';

function realDeps(): AgentBankDeps {
  return {
    db: mockDb,
    cache: {},
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: (p: Record<string, unknown>) => recordPEAccrual(
      p as unknown as Parameters<typeof recordPEAccrual>[0],
    ),
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
  mockDb.store.set(`${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(A.agent)}`, {
    wallet_id: A.wallet,
  });
}

/** Write a VALID registry record, exactly the shape the ed25519 proof writes. */
function seedProven(address: string, owner: 'agent' | 'human', provenAtSlot = PROVEN_SLOT): void {
  const evidence = createSolanaProofEvidence({
    challengeId: crypto.randomUUID(), challengeMessage: 'm', signature: sig(), verifiedAtMs: DAY - 86_400_000,
  });
  const record: SolanaProvenAddressRecord = {
    schema_version: SOLANA_PROVEN_ADDRESS_SCHEMA,
    address,
    chain: 'solana',
    network: FACILITATOR_SOLANA_NETWORK,
    owner_type: owner,
    agent_id: owner === 'agent' ? A.agent : null,
    user_id: owner === 'human' ? H.user : null,
    wallet_id: owner === 'agent' ? A.wallet : H.wallet,
    owner_evm_address: owner === 'agent' ? A.address : H.address,
    origin: 'native',
    proven_at_ms: DAY - 86_400_000,
    proven_at_slot: provenAtSlot,
    proof_method: 'ed25519',
    signature_hash: evidence.signature_sha256,
    proof_evidence: evidence,
    created_at: DAY - 86_400_000,
  };
  mockDb.store.set(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${address}`, { ...record });
}

/** The seller (H) has paid the buyer (A)'s owner before, so its receive is not unsolicited. */
function sellerHasDealtWithBuyer(): void {
  mockDb.store.set(`${COUNTERPARTY_PAIRS_COLLECTION}/${counterpartyPairDocId(H.user, A.address)}`, {
    actor_id: H.user, counterparty: A.address, outbound_count: 1, last_outbound_at_ms: 1,
  });
}

interface TxOpts { readonly slot?: number; readonly paymentIx?: boolean; readonly amount?: string }

/**
 * A finalized facilitator settlement, jsonParsed: two compute-budget instructions, the buyer's
 * `transferChecked` to the seller (index 2), and the buyer's fee `transferChecked` to the fee wallet.
 */
function settlementTx(signature: string, buyer: string, seller: string, opts: TxOpts = {}): SolanaParsedTransaction {
  const amount = opts.amount ?? '1000000';
  const fee = '50';
  const [buyerAta, sellerAta, feeAta] = [sol(), sol(), sol()];
  const bal = (accountIndex: number, owner: string, value: string) => ({
    accountIndex, owner, mint: SOLANA_USDC_MINT, uiTokenAmount: { amount: value },
  });
  const transfer = (source: string, destination: string, value: string) => ({
    programId: TOKEN_PROGRAM, program: 'spl-token',
    parsed: { type: 'transferChecked', info: { source, destination, mint: SOLANA_USDC_MINT, authority: buyer, tokenAmount: { amount: value, decimals: 6 } } },
  });
  return {
    slot: opts.slot ?? SETTLE_SLOT,
    blockTime: DAY / 1000,
    meta: {
      err: null,
      preTokenBalances: [bal(2, buyer, '5000000'), bal(3, seller, '0'), bal(4, FEE_WALLET, '0')],
      postTokenBalances: [bal(2, buyer, String(5_000_000 - Number(amount) - 50)), bal(3, seller, amount), bal(4, FEE_WALLET, fee)],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: FEE_WALLET, signer: true }, { pubkey: buyer, signer: true },
          { pubkey: buyerAta }, { pubkey: sellerAta }, { pubkey: feeAta },
        ],
        instructions: [
          { programId: COMPUTE_BUDGET, parsed: null },
          { programId: COMPUTE_BUDGET, parsed: null },
          ...(opts.paymentIx === false ? [] : [transfer(buyerAta, sellerAta, amount)]),
          transfer(buyerAta, feeAta, fee),
        ],
      },
    },
  };
}

const chain = new Map<string, SolanaParsedTransaction>();

function claimOf(signature: string, buyer: string, seller: string, amount = '1000000'): FacilitatorSettlementClaim {
  return { chain: 'solana', txHash: signature, buyer, seller, asset: SOLANA_USDC_MINT, amount, fee: '50', scheme: 'svm_exact' };
}

function laneDeps(over: Partial<FacilitatorLaneDeps> = {}): FacilitatorLaneDeps {
  return {
    db: mockDb as unknown as Firestore,
    env: {},
    verifyBaseTransaction: async () => { throw new Error('not used'); },
    getSolanaTransaction: async (s) => chain.get(s) ?? null,
    emit: buildFacilitatorEmit(realDeps()),
    emitSolana: buildFacilitatorSolanaEmit(realDeps()),
    now: () => DAY + 3_600_000,
    ...over,
  };
}

function settle(buyer: string, seller: string, opts: TxOpts = {}): { signature: string; claim: FacilitatorSettlementClaim } {
  const signature = sig();
  chain.set(signature, settlementTx(signature, buyer, seller, opts));
  return { signature, claim: claimOf(signature, buyer, seller, opts.amount) };
}

function sealed(peId: string): Record<string, unknown> {
  const row = meterActRow(mockDb.store, peId);
  if (!row) throw new Error(`no metered act for ${peId}`);
  return row;
}

function minted(peId: string): boolean {
  const row = sealed(peId);
  return row.mint_status === 'eligible' && (row.estimatedPVT as number) > 0;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(DAY + 3_600_000);
  mockDb.store.clear();
  mockDb.ops.length = 0;
  chain.clear();
  A_SOL = sol();
  H_SOL = sol();
  STRANGER_SOL = sol();
  seedHuman();
  seedAgent('someone_else'); // a different owner: A and H are not the same owner
  seedProven(A_SOL, 'agent');
  seedProven(H_SOL, 'human');
  sellerHasDealtWithBuyer();
});

afterEach(() => { jest.spyOn(Date, 'now').mockRestore(); });

describe('B1 Solana — a facilitator settlement is a witnessed PE for buyer and seller', () => {
  it('GREEN: the buyer\'s x402_payment and the seller\'s receive seal on their OWNERS\' chains and mint', async () => {
    const { signature, claim } = settle(A_SOL, H_SOL);
    const outcome = await processFacilitatorSettlement(laneDeps(), claim);
    expect(outcome).toMatchObject({
      status: 'recorded',
      acts: [
        { role: 'buyer', recorded: true, action_type: 'x402_payment', pe_id: facilitatorActPeId('solana', signature, 'buyer') },
        { role: 'seller', recorded: true, action_type: 'receive', pe_id: facilitatorActPeId('solana', signature, 'seller') },
      ],
    });
    const buyer = sealed(facilitatorActPeId('solana', signature, 'buyer'));
    const seller = sealed(facilitatorActPeId('solana', signature, 'seller'));
    expect(buyer).toMatchObject({ actionType: 'x402_payment', userId: A.agent, mint_status: 'eligible' });
    expect(seller).toMatchObject({ actionType: 'receive', userId: OWNER, mint_status: 'eligible' });
    expect(buyer.estimatedPVT as number).toBeGreaterThan(0);
    expect(seller.estimatedPVT as number).toBeGreaterThan(0);
    // Existing pricing, same as Base: the counterparty is one independent chain-witnessed origin
    // (Base: `evm:<counterparty>`; Solana: `solana:<counterparty>`), and the act is chain-witnessed.
    const factors = (row: Record<string, unknown>) =>
      (row.economic_snapshot as { recordTimeFactors: Record<string, unknown> }).recordTimeFactors;
    expect(factors(buyer)).toMatchObject({ independentOriginCount: 1, witnessClass: 'chain_witnessed' });
    expect(factors(seller)).toMatchObject({ independentOriginCount: 1, witnessClass: 'chain_witnessed' });
    // Both acts are keyed on the Solana facts in the claim store — the exact bytes, never lowercased base58.
    expect(mockDb.store.has(`${mintOnceClaimCollectionFor('x402')}/${mintOnceClaimDocId('x402',
      solanaClaimSubject(A_SOL) as string, solanaClaimSignature(signature) as string)}`)).toBe(true);
    expect(mockDb.store.has(`${mintOnceClaimCollectionFor('financial_settlement')}/${mintOnceClaimDocId('financial_settlement',
      solanaClaimSubject(H_SOL) as string, `${solanaClaimSignature(signature) as string}:2`)}`)).toBe(true);
    // The agent that paid is credited its x402 payment, as a native EVM payer is.
    expect((mockDb.store.get(`agent_wallets/${A.wallet}`) as { x402_payment_count: number }).x402_payment_count).toBe(1);
  });

  it('an UNPROVEN Solana address is not a Provian identity: no act for it; the proven party still mints', async () => {
    const { signature, claim } = settle(A_SOL, STRANGER_SOL);
    const outcome = await processFacilitatorSettlement(laneDeps(), claim);
    expect(outcome).toMatchObject({
      status: 'recorded',
      acts: [
        { role: 'buyer', recorded: true },
        { role: 'seller', recorded: false, reason: 'not_a_provian_identity', pe_id: null },
      ],
    });
    expect(actRecorded(mockDb.store, facilitatorActPeId('solana', signature, 'seller'))).toBe(false);
    // Paying a stranger's Solana address mints, as paying a stranger's EVM address does on Base.
    expect(minted(facilitatorActPeId('solana', signature, 'buyer'))).toBe(true);
  });

  it('paying a stranger\'s Solana address records the pair, so the stranger paying back mints the receive', async () => {
    const paid = settle(H_SOL, STRANGER_SOL);
    await processFacilitatorSettlement(laneDeps(), paid.claim);
    expect(minted(facilitatorActPeId('solana', paid.signature, 'buyer'))).toBe(true);
    // The pair is keyed on the raw base58 address, exactly as the receive back will name it.
    expect(mockDb.store.get(`${COUNTERPARTY_PAIRS_COLLECTION}/${counterpartyPairDocId(H.user, STRANGER_SOL)}`))
      .toMatchObject({ actor_id: H.user, counterparty: STRANGER_SOL });
    const back = settle(STRANGER_SOL, H_SOL);
    const outcome = await processFacilitatorSettlement(laneDeps(), back.claim);
    expect(outcome).toMatchObject({ status: 'recorded', acts: [{ role: 'buyer', recorded: false }, { role: 'seller', recorded: true, action_type: 'receive' }] });
    expect(minted(facilitatorActPeId('solana', back.signature, 'seller'))).toBe(true);
  });

  it('RED (still bites on Solana): a stranger the seller never paid buys, and the receive records only', async () => {
    const { signature, claim } = settle(STRANGER_SOL, H_SOL);
    await processFacilitatorSettlement(laneDeps(), claim);
    const seller = sealed(facilitatorActPeId('solana', signature, 'seller'));
    expect(seller).toMatchObject({ actionType: 'receive', userId: OWNER });
    expect(minted(facilitatorActPeId('solana', signature, 'seller'))).toBe(false);
    // A pair to a DIFFERENT address, or to the same address lowercased (a different base58 key), never authors it.
    mockDb.store.set(`${COUNTERPARTY_PAIRS_COLLECTION}/${H.user}__${STRANGER_SOL.toLowerCase()}`, {
      actor_id: H.user, counterparty: STRANGER_SOL.toLowerCase(), outbound_count: 1, last_outbound_at_ms: 1,
    });
    const again = settle(STRANGER_SOL, H_SOL);
    await processFacilitatorSettlement(laneDeps(), again.claim);
    expect(minted(facilitatorActPeId('solana', again.signature, 'seller'))).toBe(false);
  });

  it('RED (the identity requirement still bites): a counterparty that is not an address caps the x402_payment', async () => {
    const capped = await reserveActivityMintCaps(mockDb as unknown as Firestore, {
      peId: 'pe_ctrl_1', userId: A.agent, actionType: 'x402_payment', counterpartyAddress: 'not-an-address', timestampMs: DAY,
    });
    expect(capped).toMatchObject({ capped: true, reason: 'unverifiable_counterparty' });
    const solana = await reserveActivityMintCaps(mockDb as unknown as Firestore, {
      peId: 'pe_ctrl_2', userId: A.agent, actionType: 'x402_payment', counterpartyAddress: STRANGER_SOL, timestampMs: DAY,
    });
    expect(solana).toMatchObject({ capped: false });
    expect(solana.reservation?.counterparty).toBe(STRANGER_SOL); // kept exactly, never lowercased
  });

  it('FENCE: a settlement in the proof\'s own slot seals nothing; one slot later seals', async () => {
    const before = settle(A_SOL, H_SOL, { slot: PROVEN_SLOT });
    const outcome = await processFacilitatorSettlement(laneDeps(), before.claim);
    expect(outcome).toMatchObject({
      status: 'recorded',
      acts: [
        { role: 'buyer', recorded: false, reason: 'before_identity_fence' },
        { role: 'seller', recorded: false, reason: 'before_identity_fence' },
      ],
    });
    expect(actRecorded(mockDb.store, facilitatorActPeId('solana', before.signature, 'buyer'))).toBe(false);
    expect(actRecorded(mockDb.store, facilitatorActPeId('solana', before.signature, 'seller'))).toBe(false);

    const after = settle(A_SOL, H_SOL, { slot: PROVEN_SLOT + 1 });
    await processFacilitatorSettlement(laneDeps(), after.claim);
    expect(minted(facilitatorActPeId('solana', after.signature, 'buyer'))).toBe(true);
    expect(minted(facilitatorActPeId('solana', after.signature, 'seller'))).toBe(true);
  });

  it('REPLAY: the same settlement reported twice and re-run seals the same two PEs and mints once each', async () => {
    const { signature, claim } = settle(A_SOL, H_SOL);
    const first = await submitFacilitatorSettlement(laneDeps(), claim);
    const second = await submitFacilitatorSettlement(laneDeps(), claim);
    const third = await processFacilitatorSettlement(laneDeps(), claim);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(meterActRows(mockDb.store).filter((r) => r.mint_status === 'eligible')).toHaveLength(2);
    expect(mockDb.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/solana:${signature}`)).toMatchObject({ status: 'recorded' });
    expect((mockDb.store.get(`agent_wallets/${A.wallet}`) as { x402_payment_count: number }).x402_payment_count).toBe(1);
  });

  it('MINT-ONCE is real, not only the deterministic id: a SECOND witness of the same Solana settlement earns 0', async () => {
    const { signature, claim } = settle(A_SOL, H_SOL);
    await processFacilitatorSettlement(laneDeps(), claim);
    const deps = realDeps();
    const base = {
      walletId: A.wallet, agentId: A.agent, actorAddress: A_SOL, ownerType: 'agent' as const, walletAddress: A_SOL,
      counterpartyAddress: H.address, awaitAccrual: true, timestampOverride: DAY,
    };
    // Another lane's x402_payment for the SAME (payer, signature).
    await generatePE(deps, {
      ...base, actionType: 'x402_payment', peIdOverride: 'pe_second_witness_buyer',
      metadata: { verified: true, payer: A_SOL, settlementTxHash: signature, chain_verified: true, tx_hash: signature },
      observedCanonicalEventId: `solana:${signature}:2`,
    });
    expect(sealed('pe_second_witness_buyer')).toMatchObject({ actionType: 'x402_payment', estimatedPVT: 0 });
    // RED control: the same second lane on a DIFFERENT settlement signature mints.
    const other = sig();
    await generatePE(deps, {
      ...base, actionType: 'x402_payment', peIdOverride: 'pe_other_settlement_buyer',
      metadata: { verified: true, payer: A_SOL, settlementTxHash: other, chain_verified: true, tx_hash: other },
      observedCanonicalEventId: `solana:${other}:2`,
    });
    expect(minted('pe_other_settlement_buyer')).toBe(true);

    // The seller's financial-settlement claim, the same way.
    const sellerBase = {
      walletId: H.wallet, agentId: H.user, actorAddress: H_SOL, ownerType: 'human' as const, walletAddress: H_SOL,
      counterpartyAddress: A.address, awaitAccrual: true, timestampOverride: DAY, actionType: 'receive',
    };
    await generatePE(deps, {
      ...sellerBase, peIdOverride: 'pe_second_witness_seller',
      metadata: { verified: true, tx_hash: signature }, observedCanonicalEventId: `solana:${signature}:2`,
    });
    expect(sealed('pe_second_witness_seller')).toMatchObject({ actionType: 'receive', estimatedPVT: 0 });
    // RED control: another instruction of the same transaction is another event, and mints.
    await generatePE(deps, {
      ...sellerBase, peIdOverride: 'pe_other_instruction_seller',
      metadata: { verified: true, tx_hash: signature }, observedCanonicalEventId: `solana:${signature}:3`,
    });
    expect(minted('pe_other_instruction_seller')).toBe(true);
  });

  it('RED (same-owner fence): a person paying their OWN linked agent on Solana records both sides at 0', async () => {
    seedAgent(OWNER); // the agent is linked to H: one beneficial owner
    const { signature, claim } = settle(H_SOL, A_SOL);
    await processFacilitatorSettlement(laneDeps(), claim);
    expect(sealed(facilitatorActPeId('solana', signature, 'buyer'))).toMatchObject({
      actionType: 'x402_payment', userId: OWNER, mint_disposition: 'record_only',
      disposition_reason_code: 'self_or_shared_beneficial_ownership', estimatedPVT: 0,
    });
    expect(sealed(facilitatorActPeId('solana', signature, 'seller'))).toMatchObject({
      actionType: 'receive', userId: A.agent, mint_disposition: 'record_only', estimatedPVT: 0,
    });
  });

  it('control (fence not blanket): link the agent to someone else and the SAME Solana payment mints', async () => {
    seedAgent('someone_else');
    const { signature, claim } = settle(H_SOL, A_SOL);
    await processFacilitatorSettlement(laneDeps(), claim);
    expect(minted(facilitatorActPeId('solana', signature, 'buyer'))).toBe(true);
  });

  it('RED (Unknown = Block): a settlement whose payment instruction cannot be identified is refused, nothing sealed', async () => {
    const { signature, claim } = settle(A_SOL, H_SOL, { paymentIx: false });
    // The balances still balance (the verifier reads deltas), but no instruction anchors the seller's act.
    const outcome = await processFacilitatorSettlement(laneDeps(), claim);
    expect(outcome).toEqual({ status: 'refused', reason: 'payment_instruction_unresolvable' });
    expect(actRecorded(mockDb.store, facilitatorActPeId('solana', signature, 'buyer'))).toBe(false);
    expect(actRecorded(mockDb.store, facilitatorActPeId('solana', signature, 'seller'))).toBe(false);
  });

  it('a registry record that does not bind is never guessed past: the pointer stays pending', async () => {
    mockDb.store.set(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${A_SOL}`, { address: A_SOL, owner_type: 'agent' });
    const { claim } = settle(A_SOL, H_SOL);
    const outcome = await processFacilitatorSettlement(laneDeps(), claim);
    expect(outcome).toMatchObject({ status: 'pending' });
    expect(meterActRows(mockDb.store)).toHaveLength(0);
  });
});
