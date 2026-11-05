/**
 * burnPvt: the burn is irreversible the moment it is mined. the SDK no longer waits for
 * confirmations on its own RPC — it broadcasts and makes ONE `burn/record` call with
 * `await_finality: true`, and the relay holds that call until the burn reaches Base finality
 * (12 confirmations, its own two-leg check). A refusal that can still clear (a dropped connection,
 * the relay's wait bound, a record already in flight) is retried a bounded number of times; a burn
 * that REVERTED is final; anything else surfaces at once. Anything left pending throws the typed
 * BURN_RECORD_PENDING error carrying the tx hash (a re-record is idempotent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./evm-signer', async (orig) => {
  const actual = await orig<typeof import('./evm-signer')>();
  return { ...actual, sendTransaction: vi.fn(async () => ({ hash: '0x' + 'ab'.repeat(32) })) };
});
vi.mock('./evm-bond', async (orig) => {
  const actual = await orig<typeof import('./evm-bond')>();
  return { ...actual, waitForReceipt: vi.fn(async () => 'success' as const) };
});

import { CommonsInstitutions, BURN_RECORD_BASE_CONFIRMATIONS, ProvianNetworkError } from './commons-institutions';
import { waitForReceipt } from './evm-bond';
import { burnIdForTx } from './presentation';

const PK = '1'.repeat(64);
const TX = '0x' + 'ab'.repeat(32);
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = json(400, { error: 'On-chain PVT burn verification failed', reason: 'insufficient_confirmations: 3/12' });
const recorded = json(200, { burn_id: 'burn_ok', tx_hash: TX, verified: true });

function bankWith(responses: Array<() => Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => (responses.length > 1 ? responses.shift()! : responses[0])());
  const institutions = new CommonsInstitutions({ relayUrl: 'https://relay.test', walletId: 'wallet_aw_x', apiKey: 'pvn_live_x', apiSecret: 'pvns_x', fetch: fetchMock as unknown as typeof fetch });
  return { institutions, fetchMock };
}
const bodyOf = (fetchMock: ReturnType<typeof bankWith>['fetchMock'], i: number) =>
  JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body)) as Record<string, unknown>;

describe('CommonsInstitutions.burnPvt — broadcast, then ONE record the relay holds until the burn is mined ', () => {
  beforeEach(() => { vi.mocked(waitForReceipt).mockClear(); });

  it('by default does NOT wait on the caller RPC and asks the relay to hold the record (await_finality)', async () => {
    const { institutions, fetchMock } = bankWith([recorded]);
    const out = await institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 15n * 10n ** 18n, rpcUrl: 'https://rpc.test', recordRetryDelayMs: 0 });
    expect(out).toEqual({ txHash: TX, burnId: 'burn_ok', verified: true });
    expect(vi.mocked(waitForReceipt)).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0)).toMatchObject({ tx_hash: TX, chain: 'base', amount_atomic: '15000000000000000000', await_finality: true });
  });

  it('an explicit `confirmations` keeps the pre- local wait (opt-in), then records', async () => {
    const { institutions } = bankWith([recorded]);
    await institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 15n * 10n ** 18n, rpcUrl: 'https://rpc.test', confirmations: BURN_RECORD_BASE_CONFIRMATIONS, recordRetryDelayMs: 0 });
    expect(BURN_RECORD_BASE_CONFIRMATIONS).toBe(12);
    expect(vi.mocked(waitForReceipt).mock.calls[0][0].confirmations).toBe(12);
  });

  it('retries a transient verification refusal and returns the burnId once the relay verifies', async () => {
    const { institutions, fetchMock } = bankWith([refusal, refusal, recorded]);
    const out = await institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 15n * 10n ** 18n, rpcUrl: 'https://rpc.test', recordRetryDelayMs: 0 });
    expect(out).toEqual({ txHash: TX, burnId: 'burn_ok', verified: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a relay 5xx and a 409 "already in progress" (the same burn being recorded)', async () => {
    const busy = json(409, { error: 'A record for this burn tx is already in progress' });
    const { institutions, fetchMock } = bankWith([json(503, { error: 'unavailable' }), busy, recorded]);
    const out = await institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 5n * 10n ** 18n, rpcUrl: 'https://rpc.test', recordRetryDelayMs: 0 });
    expect(out.burnId).toBe('burn_ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('RED: a relay that never verifies yields BURN_RECORD_PENDING carrying the tx hash, after exactly recordAttempts tries', async () => {
    const { institutions, fetchMock } = bankWith([refusal]);
    await expect(institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 15n * 10n ** 18n, rpcUrl: 'https://rpc.test', recordAttempts: 4, recordRetryDelayMs: 0 }))
      .rejects.toMatchObject({ code: 'BURN_RECORD_PENDING', message: expect.stringContaining(TX) });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('RED: a burn the relay reports REVERTED (tx_failed) is final — no retry', async () => {
    const reverted = json(400, { error: 'On-chain PVT burn verification failed', reason: 'tx_failed' });
    const { institutions, fetchMock } = bankWith([reverted, recorded]);
    await expect(institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 15n * 10n ** 18n, rpcUrl: 'https://rpc.test', recordRetryDelayMs: 0 }))
      .rejects.toThrow(/reverted on-chain/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('RED: a non-transient relay refusal is thrown immediately with no retry', async () => {
    const conflict = json(409, { error: 'This burn tx was already recorded by a different wallet' });
    const { institutions, fetchMock } = bankWith([conflict, recorded]);
    await expect(institutions.burnPvt({ privateKeyHex: PK, amountAtomic: 15n * 10n ** 18n, rpcUrl: 'https://rpc.test', recordRetryDelayMs: 0 })).rejects.toBeInstanceOf(ProvianNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('CommonsInstitutions.sendBurn — broadcast only', () => {
  beforeEach(() => { vi.mocked(waitForReceipt).mockClear(); });

  it('returns the tx hash and the relay burn id (sha256 of chain:txHash) with no relay call', async () => {
    const { institutions, fetchMock } = bankWith([recorded]);
    const out = await institutions.sendBurn({ privateKeyHex: PK, amountAtomic: 5n * 10n ** 18n, rpcUrl: 'https://rpc.test' });
    expect(out).toEqual({ txHash: TX, burnId: burnIdForTx('base', TX), amountAtomic: '5000000000000000000', chain: 'base' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(waitForReceipt)).not.toHaveBeenCalled();
  });

  it('RED: a non-positive amount is refused before anything is broadcast', async () => {
    const { institutions } = bankWith([recorded]);
    await expect(institutions.sendBurn({ privateKeyHex: PK, amountAtomic: 0n, rpcUrl: 'https://rpc.test' })).rejects.toThrow(/positive/);
  });
});
