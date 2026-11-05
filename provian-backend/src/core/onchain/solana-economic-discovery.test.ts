/**
 * The Solana two-leg reads. Every guard is shown failing (RED) beside the case it lets through.
 * The fixtures are two real finalized mainnet transactions read from two operators: an x402
 * facilitator settlement (version 0) and a program swap (version 1).
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  SOLANA_RPC_ENV,
  SOLANA_RPC_OPERATOR_ENV,
  SOLANA_RPC_SECONDARY_ENV,
  SOLANA_RPC_SECONDARY_OPERATOR_ENV,
  buildSolanaRpcLegs,
  projectSolanaTransaction,
  readAgreedSolanaTransaction,
  readSolanaFinalizedSlotFloor,
  readSolanaSignaturesPage,
  readSolanaTokenAccountsUnion,
  solanaVerifierEndpointConfig,
  type SolanaRpcLeg,
  type SolanaRpcLegs,
} from './solana-economic-discovery';

const FIXTURES = path.join(__dirname, '..', 'pvt', '__fixtures__', 'solana-chain-record');
const load = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
const SETTLEMENT_SIG = 'Dfx2NoSjKRGKP36nvAySdAW1ZQ4asvhnkkQjLhrN7ntLByjgVzajYiEzecHPaJhMfMksgd8AxWr895xSpEwrZ5r';
const SWAP_V1_SIG = '35UkxJanYYiYLMzUaET7Zhq6B7q2ibyNRer5yHqTPJNEiiSFngrsvFwvk1guQ2GeeGzbtbwRDHQZg8SeunwUGTnk';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NO_WAIT = { disagreementRetry: { attempts: 3, delayMs: 0 } };

function legOf(operatorId: string, answer: (method: string, params: readonly unknown[], call: number) => unknown): SolanaRpcLeg & { calls: number } {
  const leg = {
    operatorId,
    calls: 0,
    send: async (method: string, params: readonly unknown[]) => {
      leg.calls += 1;
      return answer(method, params, leg.calls);
    },
  };
  return leg;
}

describe('endpoint configuration — independence is the operator binding', () => {
  const ok = {
    [SOLANA_RPC_ENV]: 'https://solana-mainnet.g.alchemy.com/v2/KEY',
    [SOLANA_RPC_SECONDARY_ENV]: 'https://solana-rpc.publicnode.com',
  };
  it('GREEN: two pinned hosts of two operators', () => {
    expect(solanaVerifierEndpointConfig(ok).identity).toEqual({ primaryOperatorId: 'alchemy', secondaryOperatorId: 'allnodes' });
    expect(buildSolanaRpcLegs(ok).map((l) => l.operatorId)).toEqual(['alchemy', 'allnodes']);
  });
  it('RED: either URL missing refuses (nothing defaults)', () => {
    expect(() => solanaVerifierEndpointConfig({ [SOLANA_RPC_ENV]: ok[SOLANA_RPC_ENV] })).toThrow(/SOLANA_RPC_URL_SECONDARY is not set/);
    expect(() => solanaVerifierEndpointConfig({ [SOLANA_RPC_SECONDARY_ENV]: ok[SOLANA_RPC_SECONDARY_ENV] })).toThrow(/SOLANA_RPC_URL is not set/);
  });
  it('RED: the same host twice refuses', () => {
    expect(() => solanaVerifierEndpointConfig({ ...ok, [SOLANA_RPC_SECONDARY_ENV]: 'https://solana-mainnet.g.alchemy.com/v2/OTHER' }))
      .toThrow(/cannot share the same host/);
  });
  it('RED: two hosts of ONE operator refuse', () => {
    expect(() => solanaVerifierEndpointConfig({ ...ok, [SOLANA_RPC_SECONDARY_ENV]: 'https://solana-devnet.g.alchemy.com/v2/KEY' }))
      .toThrow(/must be independent; both legs are operated by alchemy/);
    expect(() => solanaVerifierEndpointConfig({
      [SOLANA_RPC_ENV]: 'https://rpc.one.example', [SOLANA_RPC_OPERATOR_ENV]: 'acme',
      [SOLANA_RPC_SECONDARY_ENV]: 'https://rpc.two.example', [SOLANA_RPC_SECONDARY_OPERATOR_ENV]: 'ACME',
    })).toThrow(/must be independent/);
  });
  it('RED: an unrecognized host needs its operator declared; GREEN once declared', () => {
    const unknown = { ...ok, [SOLANA_RPC_SECONDARY_ENV]: 'https://rpc.unknown.example' };
    expect(() => solanaVerifierEndpointConfig(unknown)).toThrow(/SOLANA_RPC_SECONDARY_OPERATOR_ID is required/);
    expect(solanaVerifierEndpointConfig({ ...unknown, [SOLANA_RPC_SECONDARY_OPERATOR_ENV]: 'acme' }).identity.secondaryOperatorId).toBe('acme');
  });
  it('RED: a declared operator that contradicts the pinned host refuses', () => {
    expect(() => solanaVerifierEndpointConfig({ ...ok, [SOLANA_RPC_OPERATOR_ENV]: 'helius' })).toThrow(/conflicts with the pinned operator alchemy/);
  });
  it('RED: a non-https endpoint refuses, and no error names a URL path (where a key lives)', () => {
    let message = '';
    try {
      solanaVerifierEndpointConfig({ ...ok, [SOLANA_RPC_ENV]: 'http://solana-mainnet.g.alchemy.com/v2/SECRETKEY' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must use https/);
    expect(message).not.toContain('SECRETKEY');
  });
});

describe('the transaction projection', () => {
  it('projects a real version-0 settlement and a real version-1 program transaction', () => {
    const settlement = projectSolanaTransaction(load('facilitator-settlement-v0.json'));
    expect(settlement).toMatchObject({ signature: SETTLEMENT_SIG, slot: 453466512, version: '0', err: null, fee: '10001' });
    expect(settlement.instructions.map((ix) => ix.type)).toEqual([null, null, 'transferChecked', 'transferChecked', null]);
    expect(settlement.instructions[2].transfer).toMatchObject({ amount: '10000', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    const v1 = projectSolanaTransaction(load('program-swap-v1.json'));
    expect(v1).toMatchObject({ signature: SWAP_V1_SIG, version: '1', err: null });
    expect(v1.instructions.some((ix) => ix.inner.some((inner) => inner.type === 'transferChecked'))).toBe(true);
  });
  it('RED: an unsupported version, a malformed balance, a balance list of the wrong length all throw', () => {
    const v2 = { ...load('facilitator-settlement-v0.json'), version: 2 };
    expect(() => projectSolanaTransaction(v2)).toThrow(/version:2/);
    const bad = clone(load('facilitator-settlement-v0.json')) as { meta: { postTokenBalances: Array<{ uiTokenAmount: { amount: string } }>; preBalances: number[] } };
    bad.meta.postTokenBalances[0].uiTokenAmount.amount = '-5';
    expect(() => projectSolanaTransaction(bad)).toThrow(/postTokenBalances\[0\]\.amount/);
    const short = clone(load('facilitator-settlement-v0.json')) as { meta: { preBalances: number[] } };
    short.meta.preBalances.pop();
    expect(() => projectSolanaTransaction(short)).toThrow(/preBalances/);
  });
  it('an unsafe lamport number is kept as null, never a rounded value', () => {
    const big = clone(load('facilitator-settlement-v0.json')) as { meta: { postBalances: number[] } };
    big.meta.postBalances[7] = 2 ** 60;
    expect(projectSolanaTransaction(big).postLamports[7]).toBeNull();
  });
});

describe('readAgreedSolanaTransaction — two legs, one projection, never a disagreed answer', () => {
  const settlement = load('facilitator-settlement-v0.json');

  it('GREEN: identical replies agree; the result names both operators and an evidence hash', async () => {
    const legs: SolanaRpcLegs = [legOf('op-a', () => clone(settlement)), legOf('op-b', () => clone(settlement))];
    const tx = await readAgreedSolanaTransaction(legs, SETTLEMENT_SIG, NO_WAIT);
    expect(tx).toMatchObject({ signature: SETTLEMENT_SIG, providerOperatorIds: ['op-a', 'op-b'] });
    expect(tx?.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('GREEN: a difference ONLY in provider annotations agrees (outside the projection)', async () => {
    const annotated = clone(settlement) as Record<string, unknown> & {
      meta: Record<string, unknown> & { postTokenBalances: Array<{ uiTokenAmount: Record<string, unknown> }> };
      transaction: { message: { instructions: Array<Record<string, unknown>> } };
    };
    annotated.transactionIndex = 9999;
    annotated.providerNote = 'cached';
    annotated.meta.logMessages = ['different log lines'];
    annotated.meta.computeUnitsConsumed = 1;
    annotated.meta.costUnits = 2;
    annotated.meta.rewards = [{ pubkey: 'x' }];
    annotated.meta.postTokenBalances[0].uiTokenAmount.uiAmountString = 'zero point something';
    annotated.meta.postTokenBalances[0].uiTokenAmount.uiAmount = 123;
    annotated.transaction.message.instructions[0].stackHeight = 7;
    const legs: SolanaRpcLegs = [legOf('op-a', () => clone(settlement)), legOf('op-b', () => annotated)];
    const tx = await readAgreedSolanaTransaction(legs, SETTLEMENT_SIG, NO_WAIT);
    const plain = await readAgreedSolanaTransaction([legOf('op-a', () => clone(settlement)), legOf('op-b', () => clone(settlement))], SETTLEMENT_SIG, NO_WAIT);
    expect(tx?.evidenceHash).toBe(plain?.evidenceHash);
  });

  it('RED: a difference in a projected field (one token amount) is re-polled on both legs, then thrown', async () => {
    const forged = clone(settlement) as { meta: { postTokenBalances: Array<{ uiTokenAmount: { amount: string } }> } };
    forged.meta.postTokenBalances[1].uiTokenAmount.amount = '999999999';
    const a = legOf('op-a', () => clone(settlement));
    const b = legOf('op-b', () => forged);
    await expect(readAgreedSolanaTransaction([a, b], SETTLEMENT_SIG, NO_WAIT)).rejects.toThrow('solana_discovery_rpc_disagreement:transaction');
    expect([a.calls, b.calls]).toEqual([3, 3]);
  });

  it('RED: a projected instruction field (the transfer destination) differing is a disagreement too', async () => {
    const forged = clone(settlement) as { transaction: { message: { instructions: Array<{ parsed?: { info: { destination: string } } }> } } };
    (forged.transaction.message.instructions[2].parsed as { info: { destination: string } }).info.destination = 'G6KmwpVKMm4noC4J2pFEuDPdH86yjDjcUewvaKv7sRXo';
    await expect(readAgreedSolanaTransaction(
      [legOf('op-a', () => clone(settlement)), legOf('op-b', () => forged)], SETTLEMENT_SIG, NO_WAIT,
    )).rejects.toThrow('solana_discovery_rpc_disagreement:transaction');
  });

  it('a transient split (one leg not yet finalized) is absorbed by the re-poll', async () => {
    const a = legOf('op-a', () => clone(settlement));
    const b = legOf('op-b', (_m, _p, call) => (call === 1 ? null : clone(settlement)));
    expect(await readAgreedSolanaTransaction([a, b], SETTLEMENT_SIG, NO_WAIT)).not.toBeNull();
    expect(b.calls).toBe(2);
  });

  it('RED: one leg null against the other\'s transaction, persistently, is a disagreement (never one leg\'s word)', async () => {
    await expect(readAgreedSolanaTransaction(
      [legOf('op-a', () => clone(settlement)), legOf('op-b', () => null)], SETTLEMENT_SIG, NO_WAIT,
    )).rejects.toThrow('solana_discovery_rpc_disagreement:transaction');
  });

  it('both legs null is "not finalized": null', async () => {
    expect(await readAgreedSolanaTransaction([legOf('op-a', () => null), legOf('op-b', () => null)], SETTLEMENT_SIG, NO_WAIT)).toBeNull();
  });

  it('RED: a failed leg propagates at once (no retry, no single-leg answer)', async () => {
    const a = legOf('op-a', () => clone(settlement));
    const b = legOf('op-b', () => { throw new Error('solana_rpc_leg_failed:op-b:getTransaction:http_429'); });
    await expect(readAgreedSolanaTransaction([a, b], SETTLEMENT_SIG, NO_WAIT)).rejects.toThrow('http_429');
    expect(a.calls).toBe(1);
  });

  it('RED: two legs of one operator refuse before any read', async () => {
    const a = legOf('op-a', () => clone(settlement));
    await expect(readAgreedSolanaTransaction([a, legOf('op-a', () => clone(settlement))], SETTLEMENT_SIG, NO_WAIT))
      .rejects.toThrow('solana_discovery_operators_not_independent');
    expect(a.calls).toBe(0);
  });

  it('RED: both legs agreeing on a DIFFERENT transaction than asked is refused', async () => {
    await expect(readAgreedSolanaTransaction(
      [legOf('op-a', () => clone(settlement)), legOf('op-b', () => clone(settlement))], SWAP_V1_SIG, NO_WAIT,
    )).rejects.toThrow('solana_transaction_signature_mismatch');
  });

  it('requests finalized, jsonParsed, and version 1', async () => {
    const seen: unknown[] = [];
    const leg = (id: string) => legOf(id, (_m, params) => { seen.push(params[1]); return clone(settlement); });
    await readAgreedSolanaTransaction([leg('op-a'), leg('op-b')], SETTLEMENT_SIG, NO_WAIT);
    expect(seen[0]).toEqual({ encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 });
  });
});

describe('pointer reads', () => {
  const ADDRESS = '6ruSP2eFqg7tvhBJaa6zzhqdp1n5KJFMNLMYaJvX9pXt';
  it('a signature page is validated and keeps only what discovery reads', async () => {
    const page = await readSolanaSignaturesPage(legOf('op-a', () => [
      { signature: SETTLEMENT_SIG, slot: 453466512, blockTime: 1791173204, err: null, memo: 'x', transactionIndex: 1 },
      { signature: SWAP_V1_SIG, slot: 453466000, blockTime: null, err: { InstructionError: [0, 'x'] } },
    ]), ADDRESS, { before: null, limit: 10 });
    expect(page).toEqual([
      { signature: SETTLEMENT_SIG, slot: 453466512, blockTimeMs: 1791173204000, succeeded: true },
      { signature: SWAP_V1_SIG, slot: 453466000, blockTimeMs: null, succeeded: false },
    ]);
  });
  it('RED: a malformed page, or more entries than asked for, throws', async () => {
    await expect(readSolanaSignaturesPage(legOf('op-a', () => [{ signature: 'nope', slot: 1 }]), ADDRESS, { before: null, limit: 10 }))
      .rejects.toThrow('solana_signatures_invalid:op-a');
    await expect(readSolanaSignaturesPage(legOf('op-a', () => [
      { signature: SETTLEMENT_SIG, slot: 2, blockTime: 1, err: null }, { signature: SWAP_V1_SIG, slot: 1, blockTime: 1, err: null },
    ]), ADDRESS, { before: null, limit: 1 })).rejects.toThrow('solana_signatures_over_limit');
  });
  it('the finalized slot is the LOWER of the two legs; a failed leg propagates', async () => {
    expect(await readSolanaFinalizedSlotFloor([legOf('op-a', () => 500), legOf('op-b', () => 498)])).toBe(498);
    await expect(readSolanaFinalizedSlotFloor([legOf('op-a', () => 500), legOf('op-b', () => { throw new Error('down'); })]))
      .rejects.toThrow('down');
  });
  it('token accounts are the UNION of both legs over both token programs (an omission by one leg is covered)', async () => {
    const T1 = '6UbcjAEYbtnqooVtyD2VYEAjBRMxa5DwHK2sJzcdn3b8';
    const T2 = '6yUiEbPc8uuGh5Sp9mAEeG6Q5me6LziRZGu21Si5uzoX';
    const a = legOf('op-a', (_m, params) => ({ value: (params[1] as { programId: string }).programId.startsWith('Tokenkeg') ? [{ pubkey: T1 }] : [] }));
    const b = legOf('op-b', (_m, params) => ({ value: (params[1] as { programId: string }).programId.startsWith('Tokenz') ? [{ pubkey: T2 }] : [] }));
    expect(await readSolanaTokenAccountsUnion([a, b], ADDRESS)).toEqual([T1, T2].sort());
    expect([a.calls, b.calls]).toEqual([2, 2]);
    await expect(readSolanaTokenAccountsUnion([a, legOf('op-b', () => { throw new Error('down'); })], ADDRESS)).rejects.toThrow('down');
  });
});
