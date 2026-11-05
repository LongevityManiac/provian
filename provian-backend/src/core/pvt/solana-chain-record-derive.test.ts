/**
 * The pure Solana derivation. Every GREEN case sits beside the RED case that differs from it in
 * one fact. Two cases run on real finalized mainnet transactions (projected exactly as production
 * projects them); the rest on minimal hand-built projections.
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { base58Encode } from '../external-address/solana-keys';
import {
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  projectSolanaTransaction,
  type SolanaProjectedInstruction,
  type SolanaProjectedTransaction,
} from '../onchain/solana-economic-discovery';
import {
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_INCINERATOR,
  SOLANA_USDC_MINT_ADDRESS,
  SOLANA_WRAPPED_SOL_MINT,
  deriveSolanaChainRecordAct,
  solanaHoldingDeltas,
} from './solana-chain-record-derive';
import {
  SOLANA_JUPITER_V6_PROGRAM,
  SOLANA_MAYAN_SWIFT_V2_PROGRAM,
} from './solana-chain-record-derive';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
import { provianSolanaServiceWallets } from '../external-address/solana-link';
import { FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT } from './x402-facilitator-settlement';

const FIXTURES = path.join(__dirname, '__fixtures__', 'solana-chain-record');
const fixture = (name: string): SolanaProjectedTransaction =>
  projectSolanaTransaction(JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));

const addr = (): string => base58Encode(crypto.randomBytes(32));
const sig = (): string => base58Encode(crypto.randomBytes(64));
const SERVICE = provianSolanaServiceWallets({});
const CTX = { excludedCounterparties: SERVICE };
const NONE = { excludedCounterparties: new Set<string>() };

interface TokenRow { account: string; mint: string; owner: string | null; pre: string | null; post: string | null; postOwner?: string | null }
interface Build {
  keys: string[];
  signers: string[];
  pre?: Record<string, number>;
  post?: Record<string, number>;
  tokens?: TokenRow[];
  ixs: Array<SolanaProjectedInstruction & { inner?: SolanaProjectedInstruction[] }>;
  fee?: number;
  err?: string | null;
  signature?: string;
}

function build(b: Build): SolanaProjectedTransaction {
  const keys = [...b.keys];
  for (const t of b.tokens ?? []) if (!keys.includes(t.account)) keys.push(t.account);
  const fee = b.fee ?? 5000;
  // An unspecified post balance follows the System transfers the instructions make (and the fee).
  const moved = new Map<string, number>();
  for (const ix of b.ixs.flatMap((outer) => [outer, ...(outer.inner ?? [])])) {
    if (ix.programId !== SOLANA_SYSTEM_PROGRAM || ix.transfer === null) continue;
    const n = Number(ix.transfer.amount);
    moved.set(ix.transfer.source, (moved.get(ix.transfer.source) ?? 0) - n);
    moved.set(ix.transfer.destination, (moved.get(ix.transfer.destination) ?? 0) + n);
  }
  const lam = (m: Record<string, number> | undefined, post: boolean) => keys.map((k, i) => String(
    m?.[k] ?? (b.pre?.[k] ?? 1_000_000_000) + (post ? (moved.get(k) ?? 0) - (i === 0 ? fee : 0) : 0),
  ));
  const rows = (which: 'pre' | 'post') => (b.tokens ?? [])
    .filter((t) => t[which] !== null)
    .map((t) => ({
      accountIndex: keys.indexOf(t.account), mint: t.mint,
      owner: which === 'post' && t.postOwner !== undefined ? t.postOwner : t.owner,
      amount: t[which] as string,
    }));
  return {
    signature: b.signature ?? sig(),
    slot: 400_000_000,
    blockTimeMs: Date.UTC(2026, 9, 29),
    version: '0',
    err: b.err ?? null,
    fee: String(fee),
    accountKeys: keys.map((pubkey) => ({ pubkey, signer: b.signers.includes(pubkey), writable: true })),
    preLamports: lam(b.pre, false),
    postLamports: lam(b.post, true),
    preTokenBalances: rows('pre'),
    postTokenBalances: rows('post'),
    instructions: b.ixs.map((ix) => ({ ...ix, inner: ix.inner ?? [] })),
  };
}

const sysTransfer = (source: string, destination: string, lamports: number): SolanaProjectedInstruction => ({
  programId: SOLANA_SYSTEM_PROGRAM, type: 'transfer',
  transfer: { source, destination, authority: null, mint: null, amount: String(lamports) },
});
const splTransfer = (source: string, destination: string, amount: string, mint: string | null, authority: string): SolanaProjectedInstruction => ({
  programId: SOLANA_TOKEN_PROGRAM, type: mint === null ? 'transfer' : 'transferChecked',
  transfer: { source, destination, authority, mint, amount },
});
const program = (programId: string, inner: SolanaProjectedInstruction[] = []) => ({ programId, type: null, transfer: null, inner });
const computeBudget = { programId: SOLANA_COMPUTE_BUDGET_PROGRAM, type: null, transfer: null };

describe('real transactions', () => {
  const settlement = fixture('facilitator-settlement-v0.json');
  const BUYER = '6ruSP2eFqg7tvhBJaa6zzhqdp1n5KJFMNLMYaJvX9pXt';
  const SELLER = '4Jxy9nbNxjsNnwrEyGePnXkVrGJWmPQKeLccL3zuR2K2';

  it('a facilitator settlement: the buyer (signer) sends to the seller\'s OWNER, keyed on the payment instruction', () => {
    expect(deriveSolanaChainRecordAct(settlement, BUYER, CTX)).toEqual({
      status: 'act',
      act: expect.objectContaining({
        actionType: 'send', counterparty: SELLER, instructionIndex: 2, leg: 'spl', mint: SOLANA_USDC_MINT_ADDRESS,
        assetSymbol: 'USDC', amountAtomic: '10000', canonicalEventId: `solana:${settlement.signature}:2`,
      }),
    });
  });
  it('the seller (not a signer, not even in the account keys) receives from the buyer, on the same instruction', () => {
    expect(settlement.accountKeys.some((k) => k.pubkey === SELLER)).toBe(false);
    expect(deriveSolanaChainRecordAct(settlement, SELLER, CTX)).toEqual({
      status: 'act',
      act: expect.objectContaining({ actionType: 'receive', counterparty: BUYER, instructionIndex: 2, amountAtomic: '10000' }),
    });
  });
  it('the fee wallet (fee payer, a signer) derives nothing: it neither sent nor exchanged', () => {
    expect(deriveSolanaChainRecordAct(settlement, FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT, CTX))
      .toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('EXCLUSION: without the payment, the buyer\'s only transfer is the fee to Provian\'s wallet — no act; RED: unexcluded it would be a send', () => {
    const feeOnly = { ...settlement, instructions: settlement.instructions.filter((_, i) => i !== 2) };
    expect(deriveSolanaChainRecordAct(feeOnly, BUYER, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
    expect(deriveSolanaChainRecordAct(feeOnly, BUYER, NONE)).toMatchObject({
      status: 'act', act: { actionType: 'send', counterparty: FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT },
    });
  });
  it('NET DIRECTION: a real version-1 arbitrage round trip (SOL out to a pool and back, net SOL up) is neither a swap nor a send', () => {
    const v1 = fixture('program-swap-v1.json');
    const signer = v1.accountKeys[0].pubkey;
    // Its only net change is SOL UP: nothing fell, so it is not a swap ...
    expect([...solanaHoldingDeltas(v1, signer)]).toEqual([[null, 14140n]]);
    // ... and it runs through Jupiter: a venue call in which no known asset fell derives nothing.
    expect(deriveSolanaChainRecordAct(v1, signer, CTX)).toEqual({ status: 'no_act', reason: 'venue_no_known_asset_sold' });
  });
  it('RED (the net-direction rule bites, not something else): the same transfer with the SOL NOT coming back is a send', () => {
    const [W, X] = [addr(), addr()];
    const out = build({ keys: [W, X], signers: [W], pre: { [W]: 2_000 + 5000, [X]: 0 }, post: { [W]: 1_000, [X]: 1_000 }, ixs: [sysTransfer(W, X, 1_000)] });
    expect(deriveSolanaChainRecordAct(out, W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: X } });
    const back = build({
      keys: [W, X], signers: [W], pre: { [W]: 2_000 + 5000, [X]: 0 }, post: { [W]: 2_000, [X]: 0 },
      ixs: [sysTransfer(W, X, 1_000), sysTransfer(X, W, 1_000)],
    });
    expect(deriveSolanaChainRecordAct(back, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
});

describe('send', () => {
  it('GREEN: a signed System transfer of SOL to another address is a native send', () => {
    const [W, X] = [addr(), addr()];
    const t = build({ keys: [W, X, SOLANA_SYSTEM_PROGRAM], signers: [W], ixs: [computeBudget, sysTransfer(W, X, 25_000)] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({
      status: 'act', act: { actionType: 'send', counterparty: X, leg: 'native', mint: null, assetSymbol: 'SOL', amountAtomic: '25000', instructionIndex: 1 },
    });
  });
  it('RED: the same transfer when W did not sign is not W\'s send (and not a receive: it left W)', () => {
    const [W, X, P] = [addr(), addr(), addr()];
    const t = build({ keys: [P, W, X], signers: [P], ixs: [sysTransfer(W, X, 25_000)] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_receive' });
  });
  it('RED: a zero-amount transfer is never an act', () => {
    const [W, X] = [addr(), addr()];
    const t = build({ keys: [W, X], signers: [W], ixs: [sysTransfer(W, X, 0)] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('GREEN: an SPL transfer from W\'s token account; the counterparty is the destination\'s OWNER, not its token account', () => {
    const [W, X, wAta, xAta] = [addr(), addr(), addr(), addr()];
    const MINT = BONK;
    const t = build({
      keys: [W, wAta, xAta], signers: [W],
      tokens: [{ account: wAta, mint: MINT, owner: W, pre: '100', post: '40' }, { account: xAta, mint: MINT, owner: X, pre: '0', post: '60' }],
      ixs: [splTransfer(wAta, xAta, '60', null, W)],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({
      status: 'act', act: { actionType: 'send', counterparty: X, leg: 'spl', mint: MINT, assetSymbol: 'BONK', amountAtomic: '60' },
    });
  });
  it('RED (Unknown = Block): the same transfer in a mint the wallet does not hold is never an act', () => {
    const [W, X, wAta, xAta, JUNK] = [addr(), addr(), addr(), addr(), addr()];
    const t = build({
      keys: [W, wAta, xAta], signers: [W],
      tokens: [{ account: wAta, mint: JUNK, owner: W, pre: '100', post: '40' }, { account: xAta, mint: JUNK, owner: X, pre: '0', post: '60' }],
      ixs: [splTransfer(wAta, xAta, '60', null, W)],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('RED: a transfer between two token accounts W owns is not a send', () => {
    const [W, a1, a2, MINT] = [addr(), addr(), addr(), addr()];
    const t = build({
      keys: [W, a1, a2], signers: [W],
      tokens: [{ account: a1, mint: MINT, owner: W, pre: '100', post: '40' }, { account: a2, mint: MINT, owner: W, pre: '0', post: '60' }],
      ixs: [splTransfer(a1, a2, '60', MINT, W)],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('RED: to the incinerator or the System program is never a send', () => {
    const W = addr();
    for (const sink of [SOLANA_INCINERATOR, SOLANA_SYSTEM_PROGRAM]) {
      const t = build({ keys: [W, sink], signers: [W], ixs: [sysTransfer(W, sink, 10)] });
      expect(deriveSolanaChainRecordAct(t, W, NONE)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
    }
  });
  it('Unknown = Block: a token account whose owner differs between pre and post, or a mint the instruction contradicts, is never an act', () => {
    const [W, X, wAta, xAta, OTHER] = [addr(), addr(), addr(), addr(), addr()];
    const MINT = BONK;
    const shifted = build({
      keys: [W, wAta, xAta], signers: [W],
      tokens: [{ account: wAta, mint: MINT, owner: W, pre: '100', post: '40' }, { account: xAta, mint: MINT, owner: X, postOwner: addr(), pre: '0', post: '60' }],
      ixs: [splTransfer(wAta, xAta, '60', MINT, W)],
    });
    expect(deriveSolanaChainRecordAct(shifted, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
    const lying = build({
      keys: [W, wAta, xAta], signers: [W],
      tokens: [{ account: wAta, mint: MINT, owner: W, pre: '100', post: '40' }, { account: xAta, mint: MINT, owner: X, pre: '0', post: '60' }],
      ixs: [splTransfer(wAta, xAta, '60', OTHER, W)],
    });
    expect(deriveSolanaChainRecordAct(lying, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
    // control: the honest version of the same transfer is a send
    const honest = { ...lying, instructions: [{ ...splTransfer(wAta, xAta, '60', MINT, W), inner: [] }] };
    expect(deriveSolanaChainRecordAct(honest, W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: X } });
  });
  it('a failed transaction is never an act', () => {
    const [W, X] = [addr(), addr()];
    const t = build({ keys: [W, X], signers: [W], ixs: [sysTransfer(W, X, 10)], err: '{"InstructionError":[0,"Custom"]}' });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'transaction_failed' });
  });
});

describe('swap', () => {
  it('GREEN: through Jupiter, SOL fell (beyond the fee) and USDC rose → a swap keyed on the Jupiter instruction, which is the counterparty', () => {
    const [W, POOL, wAta, poolAta] = [addr(), addr(), addr(), addr()];
    const P = SOLANA_JUPITER_V6_PROGRAM;
    const t = build({
      keys: [W, wAta, poolAta, POOL, SOLANA_COMPUTE_BUDGET_PROGRAM, P], signers: [W],
      pre: { [W]: 2_000_000_000 }, post: { [W]: 1_000_000_000 - 5000 },
      tokens: [
        { account: wAta, mint: SOLANA_USDC_MINT_ADDRESS, owner: W, pre: '0', post: '150000000' },
        { account: poolAta, mint: SOLANA_USDC_MINT_ADDRESS, owner: POOL, pre: '900000000', post: '750000000' },
      ],
      ixs: [computeBudget, program(P, [sysTransfer(W, POOL, 1_000_000_000), splTransfer(poolAta, wAta, '150000000', SOLANA_USDC_MINT_ADDRESS, POOL)])],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({
      status: 'act',
      act: {
        actionType: 'swap', counterparty: P, instructionIndex: 1, leg: 'native', mint: null, amountAtomic: '1000000000',
        swap: { programId: P, sold: { mint: null, amountAtomic: '1000000000' }, bought: { mint: SOLANA_USDC_MINT_ADDRESS, amountAtomic: '150000000' } },
      },
    });
  });
  it('RED: only the network fee left W and USDC arrived → nothing fell, not a swap (the fee is netted out)', () => {
    const [W, X, wAta, xAta] = [addr(), addr(), addr(), addr()];
    const t = build({
      keys: [W, wAta, xAta], signers: [W], pre: { [W]: 1_000_000_000 }, post: { [W]: 1_000_000_000 - 5000 },
      tokens: [
        { account: wAta, mint: SOLANA_USDC_MINT_ADDRESS, owner: W, pre: '0', post: '5' },
        { account: xAta, mint: SOLANA_USDC_MINT_ADDRESS, owner: X, pre: '5', post: '0' },
      ],
      ixs: [splTransfer(xAta, wAta, '5', SOLANA_USDC_MINT_ADDRESS, X)],
    });
    expect([...solanaHoldingDeltas(t, W)]).toEqual([[SOLANA_USDC_MINT_ADDRESS, 5n]]);
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('RED: wrapping SOL into W\'s own wrapped-SOL account is not an exchange (and not a send)', () => {
    const [W, wsolAta] = [addr(), addr()];
    const t = build({
      keys: [W, wsolAta], signers: [W],
      pre: { [W]: 3_000_000_000, [wsolAta]: 2_039_280 }, post: { [W]: 2_000_000_000 - 5000, [wsolAta]: 1_002_039_280 },
      tokens: [{ account: wsolAta, mint: SOLANA_WRAPPED_SOL_MINT, owner: W, pre: '0', post: '1000000000' }],
      ixs: [sysTransfer(W, wsolAta, 1_000_000_000), { programId: SOLANA_TOKEN_PROGRAM, type: 'syncNative', transfer: null }],
    });
    expect(solanaHoldingDeltas(t, W).size).toBe(0);
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('RED: rent paid into W\'s OWN new token account is not SOL that fell (a claim is not an exchange)', () => {
    const [W, newAta, DIST, distAta, P] = [addr(), addr(), addr(), addr(), addr()];
    const MINT = BONK;
    const t = build({
      keys: [W, newAta, distAta, P], signers: [W],
      pre: { [W]: 1_000_000_000, [newAta]: 0 }, post: { [W]: 1_000_000_000 - 2_039_280 - 5000, [newAta]: 2_039_280 },
      tokens: [
        { account: newAta, mint: MINT, owner: W, pre: null, post: '77' },
        { account: distAta, mint: MINT, owner: DIST, pre: '1000', post: '923' },
      ],
      ixs: [program(P, [splTransfer(distAta, newAta, '77', MINT, DIST)])],
    });
    expect([...solanaHoldingDeltas(t, W)]).toEqual([[MINT, 77n]]);
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('RED: two parties exchanging directly (no venue) is not a swap: each signer derives the send of its own outbound leg', () => {
    const [W, X, wA, xA, wB, xB] = [addr(), addr(), addr(), addr(), addr(), addr()];
    const [MA, MB] = [BONK, WIF];
    const t = build({
      keys: [W, X, wA, xA, wB, xB], signers: [W, X],
      tokens: [
        { account: wA, mint: MA, owner: W, pre: '10', post: '0' }, { account: xA, mint: MA, owner: X, pre: '0', post: '10' },
        { account: xB, mint: MB, owner: X, pre: '20', post: '0' }, { account: wB, mint: MB, owner: W, pre: '0', post: '20' },
      ],
      ixs: [splTransfer(xB, wB, '20', MB, X), splTransfer(wA, xA, '10', MA, W)],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: X, instructionIndex: 1, mint: MA } });
    expect(deriveSolanaChainRecordAct(t, X, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: W, instructionIndex: 0, mint: MB } });
  });
  it('RED (the fake swap): a 1-lamport send plus a self-minted junk token is a 1-lamport send, never a swap', () => {
    const [W, X, wJunk, JUNK] = [addr(), addr(), addr(), addr()];
    const t = build({
      keys: [W, X, wJunk], signers: [W], pre: { [W]: 1_000_000_000, [X]: 0 }, post: { [W]: 1_000_000_000 - 1 - 5000, [X]: 1 },
      tokens: [{ account: wJunk, mint: JUNK, owner: W, pre: '0', post: '1000000' }],
      ixs: [sysTransfer(W, X, 1), { programId: SOLANA_TOKEN_PROGRAM, type: 'mintTo', transfer: null }],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: X, amountAtomic: '1' } });
    expect((deriveSolanaChainRecordAct(t, W, CTX) as { act: { swap?: unknown } }).act.swap).toBeUndefined();
  });
  it('RED: a Jupiter call that buys a token the wallet does not hold derives nothing (as a router call does on Base); GREEN: the same buying WIF is a swap', () => {
    const [W, POOL, wAta, poolAta, JUNK] = [addr(), addr(), addr(), addr(), addr()];
    const mk = (mint: string) => build({
      keys: [W, wAta, poolAta, POOL, SOLANA_JUPITER_V6_PROGRAM], signers: [W],
      pre: { [W]: 2_000_000_000 }, post: { [W]: 1_000_000_000 - 5000 },
      tokens: [
        { account: wAta, mint, owner: W, pre: '0', post: '150' },
        { account: poolAta, mint, owner: POOL, pre: '900', post: '750' },
      ],
      ixs: [program(SOLANA_JUPITER_V6_PROGRAM, [sysTransfer(W, POOL, 1_000_000_000), splTransfer(poolAta, wAta, '150', mint, POOL)])],
    });
    expect(deriveSolanaChainRecordAct(mk(JUNK), W, CTX)).toEqual({ status: 'no_act', reason: 'venue_no_known_asset_bought' });
    expect(deriveSolanaChainRecordAct(mk(WIF), W, CTX)).toMatchObject({
      status: 'act', act: { actionType: 'swap', counterparty: SOLANA_JUPITER_V6_PROGRAM, swap: { bought: { mint: WIF, amountAtomic: '150' } } },
    });
  });
  it('GREEN: a Mayan bridge order that takes W\'s USDC is a cross-chain swap with no bought leg on Solana; RED: an unknown program is not a venue', () => {
    const [W, VAULT, wAta, vAta, OTHER_PROGRAM] = [addr(), addr(), addr(), addr(), addr()];
    const mk = (programId: string) => build({
      keys: [W, wAta, vAta, VAULT, programId], signers: [W],
      tokens: [
        { account: wAta, mint: SOLANA_USDC_MINT_ADDRESS, owner: W, pre: '500', post: '0' },
        { account: vAta, mint: SOLANA_USDC_MINT_ADDRESS, owner: VAULT, pre: '0', post: '500' },
      ],
      ixs: [program(programId, [splTransfer(wAta, vAta, '500', SOLANA_USDC_MINT_ADDRESS, W)])],
    });
    expect(deriveSolanaChainRecordAct(mk(SOLANA_MAYAN_SWIFT_V2_PROGRAM), W, CTX)).toMatchObject({
      status: 'act',
      act: { actionType: 'swap', counterparty: SOLANA_MAYAN_SWIFT_V2_PROGRAM, mint: SOLANA_USDC_MINT_ADDRESS, swap: { bought: null } },
    });
    expect(deriveSolanaChainRecordAct(mk(OTHER_PROGRAM), W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: VAULT } });
  });
  it('RED (bridge): an unknown-mint deposit into a Mayan order, with the order\'s rent paid in lamports, is never a swap (rent is not a deposit)', () => {
    const [W, ORDER, wAta, escrow, JUNK] = [addr(), addr(), addr(), addr(), addr()];
    const t = build({
      keys: [W, ORDER, wAta, escrow, SOLANA_MAYAN_SWIFT_V2_PROGRAM], signers: [W],
      pre: { [W]: 1_000_000_000, [ORDER]: 0 }, post: { [W]: 1_000_000_000 - 2_039_280 - 5000, [ORDER]: 2_039_280 },
      tokens: [
        { account: wAta, mint: JUNK, owner: W, pre: '1000000', post: '0' },
        { account: escrow, mint: JUNK, owner: ORDER, pre: '0', post: '1000000' },
      ],
      ixs: [program(SOLANA_MAYAN_SWIFT_V2_PROGRAM, [sysTransfer(W, ORDER, 2_039_280), splTransfer(wAta, escrow, '1000000', JUNK, W)])],
    });
    const d = deriveSolanaChainRecordAct(t, W, CTX);
    expect(d.status === 'act' ? d.act.actionType : d.reason).not.toBe('swap');
  });
  it('RED (bridge): a Mayan instruction that moves nothing of W\'s does not turn W\'s unrelated 1-lamport send into a swap', () => {
    const [W, X] = [addr(), addr()];
    const t = build({
      keys: [W, X, SOLANA_MAYAN_SWIFT_V2_PROGRAM], signers: [W], pre: { [W]: 1_000_000, [X]: 0 }, post: { [W]: 1_000_000 - 1 - 5000, [X]: 1 },
      ixs: [program(SOLANA_MAYAN_SWIFT_V2_PROGRAM), sysTransfer(W, X, 1)],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send', counterparty: X, amountAtomic: '1' } });
  });
  it('GREEN (bridge): SOL bridged as wrapped SOL from W\'s own wrapped-SOL account into the order is a cross-chain swap of SOL', () => {
    const [W, ORDER, wsol, escrow] = [addr(), addr(), addr(), addr()];
    const t = build({
      keys: [W, wsol, escrow, ORDER, SOLANA_MAYAN_SWIFT_V2_PROGRAM], signers: [W],
      pre: { [W]: 3_000_000_000, [wsol]: 2_039_280, [escrow]: 2_039_280 },
      post: { [W]: 2_000_000_000 - 5000, [wsol]: 2_039_280, [escrow]: 1_002_039_280 },
      tokens: [
        { account: wsol, mint: SOLANA_WRAPPED_SOL_MINT, owner: W, pre: '0', post: '0' },
        { account: escrow, mint: SOLANA_WRAPPED_SOL_MINT, owner: ORDER, pre: '0', post: '1000000000' },
      ],
      ixs: [sysTransfer(W, wsol, 1_000_000_000), program(SOLANA_MAYAN_SWIFT_V2_PROGRAM, [splTransfer(wsol, escrow, '1000000000', SOLANA_WRAPPED_SOL_MINT, W)])],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({
      status: 'act', act: { actionType: 'swap', counterparty: SOLANA_MAYAN_SWIFT_V2_PROGRAM, mint: null, amountAtomic: '1000000000', swap: { bought: null } },
    });
  });
  it('Unknown = Block: a lamport balance W needs that is not a safe integer throws (never guessed)', () => {
    const [W, X] = [addr(), addr()];
    const t = build({ keys: [W, X], signers: [W], ixs: [sysTransfer(W, X, 1)] });
    const unsafe = { ...t, preLamports: [null, ...t.preLamports.slice(1)] };
    expect(() => deriveSolanaChainRecordAct(unsafe, W, CTX)).toThrow('solana_derivation_lamports_unsafe');
    // control: an unsafe balance on an account W does not hold is never read
    const elsewhere = { ...t, preLamports: [t.preLamports[0], null] };
    expect(deriveSolanaChainRecordAct(elsewhere, W, CTX)).toMatchObject({ status: 'act', act: { actionType: 'send' } });
  });
});

describe('receive', () => {
  it('GREEN: an SPL transfer into W\'s existing token account from a stranger; W is not in the transaction at all', () => {
    const [W, X, wAta, xAta] = [addr(), addr(), addr(), addr()];
    const MINT = BONK;
    const t = build({
      keys: [X, xAta, wAta], signers: [X],
      tokens: [{ account: xAta, mint: MINT, owner: X, pre: '9', post: '2' }, { account: wAta, mint: MINT, owner: W, pre: '0', post: '7' }],
      ixs: [splTransfer(xAta, wAta, '7', MINT, X)],
    });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({
      status: 'act', act: { actionType: 'receive', counterparty: X, amountAtomic: '7', mint: MINT, instructionIndex: 0 },
    });
  });
  it('an inner transfer into W is keyed on the top-level instruction that ran it', () => {
    const [W, X, P] = [addr(), addr(), addr()];
    const t = build({ keys: [X, W, P], signers: [X], ixs: [computeBudget, program(P, [sysTransfer(X, W, 42)])] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({
      status: 'act', act: { actionType: 'receive', counterparty: X, instructionIndex: 1, innerIndex: 0, canonicalEventId: `solana:${t.signature}:1` },
    });
  });
  it('RED: a transaction W signed never derives a receive', () => {
    const [W, X] = [addr(), addr()];
    const t = build({ keys: [W, X], signers: [W, X], ixs: [sysTransfer(X, W, 42)] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_leg' });
  });
  it('RED: a receive FROM a Provian service wallet is excluded; GREEN: unexcluded it would be a receive', () => {
    const [W] = [addr()];
    const service = [...SERVICE][0];
    const t = build({ keys: [service, W], signers: [service], ixs: [sysTransfer(service, W, 42)] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toEqual({ status: 'no_act', reason: 'no_qualifying_receive' });
    expect(deriveSolanaChainRecordAct(t, W, NONE)).toMatchObject({ status: 'act', act: { actionType: 'receive', counterparty: service } });
  });
  it('a stranger\'s inbound is skipped past an excluded one to the first that qualifies', () => {
    const [W, X] = [addr(), addr()];
    const service = [...SERVICE][0];
    const t = build({ keys: [service, X, W], signers: [service, X], ixs: [sysTransfer(service, W, 1), sysTransfer(X, W, 2)] });
    expect(deriveSolanaChainRecordAct(t, W, CTX)).toMatchObject({ status: 'act', act: { counterparty: X, instructionIndex: 1, amountAtomic: '2' } });
  });
});
