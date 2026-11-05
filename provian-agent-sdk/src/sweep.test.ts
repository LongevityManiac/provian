/**
 * Headless, deterministic tests for the voluntary-rotation balance sweep.
 *
 * No chain is touched: a mock viem `custom` transport answers the RPC set the
 * sweep needs (eth_call balanceOf, eth_getBalance, eth_sendRawTransaction,
 * eth_getTransactionReceipt) with configurable balances, and viem's own
 * parseTransaction decodes the signed raw tx to prove the FULL balance is sent
 * to the NEW address. Fees/gas/nonce are supplied so no estimation RPC fires.
 *
 * RED negative controls (money-path doctrine,) are recorded inline: each
 * correctness claim was observed FAILING under a stated one-line mutation before
 * this suite was committed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  custom,
  getAddress,
  keccak256,
  parseTransaction,
  type Hex,
} from 'viem';
import { sweepErc20ToNewKey, rotateKeyAndSweep } from './sweep';
import { encodeErc20Transfer } from './evm-signer';
import { TOKEN_ALLOWLIST } from './evm-allowlist';
import { generateAgentKeyPair } from './wallet';
import type { RotateKeyConfig } from './wallet';

// anvil/hardhat account #0 — the retired ("old") address whose balance we sweep.
const OLD_PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OLD_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
// A distinct destination (hardhat account #1).
const NEW_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const PVT_ON_BASE = TOKEN_ALLOWLIST.base.PVT.address;
const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const OVERRIDES = { ...FEES, gas: 100_000n, nonce: 0 };

interface MockCall {
  method: string;
  params?: unknown;
}

/** hex-encode a uint256 (bigint) as a 32-byte 0x word. */
function word(n: bigint): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

/**
 * A viem `custom` transport whose PVT balance and native balance are set per
 * test. `balanceThrows` makes the balanceOf read fail (RPC-error path). Records
 * every RPC so we can assert that a doomed broadcast is NOT attempted.
 */
function makeMockTransport(opts: {
  pvtBalance: bigint;
  nativeWei: bigint;
  balanceThrows?: boolean;
}) {
  const calls: MockCall[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return '0x2105'; // 8453 (Base)
        case 'eth_call':
          if (opts.balanceThrows) throw new Error('execution reverted: balanceOf');
          // Only balanceOf is called in these tests.
          return word(opts.pvtBalance);
        case 'eth_getBalance':
          return word(opts.nativeWei);
        case 'eth_getTransactionCount':
          return '0x0';
        case 'eth_estimateGas':
          return '0x186a0'; // 100000
        case 'eth_gasPrice':
          return '0x3b9aca00'; // 1 gwei
        case 'eth_maxPriorityFeePerGas':
          return '0x3b9aca00';
        case 'eth_blockNumber':
          return '0x1';
        case 'eth_getBlockByNumber':
          return { number: '0x1', baseFeePerGas: '0x3b9aca00', timestamp: '0x1', gasLimit: '0x1c9c380' };
        case 'eth_sendRawTransaction':
          return keccak256((params as Hex[])[0]);
        case 'eth_getTransactionReceipt':
          return {
            transactionHash: (params as Hex[])[0],
            status: '0x1',
            blockNumber: '0x1',
            blockHash: '0x' + '1'.repeat(64),
            transactionIndex: '0x0',
            from: OLD_ADDRESS,
            to: PVT_ON_BASE,
            cumulativeGasUsed: '0x186a0',
            gasUsed: '0x186a0',
            contractAddress: null,
            logs: [],
            logsBloom: '0x' + '0'.repeat(512),
            type: '0x2',
            effectiveGasPrice: '0x3b9aca00',
          };
        default:
          throw new Error(`mock transport: unexpected RPC method ${method}`);
      }
    },
  });
  return { transport, calls, getRawTx: () => {
    const c = calls.find((x) => x.method === 'eth_sendRawTransaction');
    return c ? (c.params as Hex[])[0] : undefined;
  } };
}

describe('sweepErc20ToNewKey', () => {
  it('sweeps the FULL balance to the NEW address (happy path)', async () => {
    const balance = 100_000000000000000000n; // 100 PVT (18 decimals)
    const { transport, calls, getRawTx } = makeMockTransport({ pvtBalance: balance, nativeWei: 10_000_000_000_000_000n });

    const res = await sweepErc20ToNewKey({
      oldPrivateKey: OLD_PRIV,
      newAddress: NEW_ADDRESS,
      token: 'PVT',
      chain: 'base',
      transport,
      ...OVERRIDES,
    });

    expect(res.swept).toBe(true);
    if (!res.swept) throw new Error('unreachable');
    expect(res.amountAtomic).toBe(balance.toString());
    expect(res.oldAddress).toBe(OLD_ADDRESS);
    expect(res.newAddress).toBe(getAddress(NEW_ADDRESS));
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // RED control (mutation: amount = balance / 2n → this decode assertion fails):
    // the signed tx MUST move the full balance to the new address, on the PVT token.
    const raw = getRawTx();
    expect(raw).toBeTruthy();
    const parsed = parseTransaction(raw as Hex);
    expect(getAddress(parsed.to as string)).toBe(getAddress(PVT_ON_BASE));
    expect((parsed.data as string).toLowerCase()).toBe(
      encodeErc20Transfer(getAddress(NEW_ADDRESS), balance).toLowerCase(),
    );
    // It waited for the receipt (so a revert would be caught), then broadcast once.
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(calls.map((c) => c.method)).toContain('eth_getTransactionReceipt');
  });

  it('reports insufficient_gas with the EXACT stranded amount when the old address has no ETH (the Atlas case)', async () => {
    // Population > 0: a real, non-zero PVT balance that the fix must NOT lose.
    const balance = 26_465500000000000000n; // 26.4655 PVT
    const { transport, calls } = makeMockTransport({ pvtBalance: balance, nativeWei: 0n });

    const res = await sweepErc20ToNewKey({
      oldPrivateKey: OLD_PRIV,
      newAddress: NEW_ADDRESS,
      transport,
      ...OVERRIDES,
    });

    expect(res.swept).toBe(false);
    if (res.swept) throw new Error('unreachable');
    expect(res.reason).toBe('insufficient_gas');
    if (res.reason !== 'insufficient_gas') throw new Error('unreachable');
    expect(res.strandedAtomic).toBe(balance.toString());
    expect(res.nativeWei).toBe('0');
    expect(res.oldAddress).toBe(OLD_ADDRESS);

    // RED control (mutation: drop the `nativeWei <= 0n` short-circuit → an
    // eth_sendRawTransaction is attempted): a doomed broadcast MUST NOT be sent,
    // and the balance MUST be reported (not silently swallowed as nothing_to_sweep).
    expect(calls.map((c) => c.method)).not.toContain('eth_sendRawTransaction');
    // The nonzero population was actually evaluated (guards the empty-population trap).
    expect(BigInt(res.strandedAtomic)).toBeGreaterThan(0n);
  });

  it('reports nothing_to_sweep for a zero balance', async () => {
    const { transport, calls } = makeMockTransport({ pvtBalance: 0n, nativeWei: 10n ** 16n });
    const res = await sweepErc20ToNewKey({ oldPrivateKey: OLD_PRIV, newAddress: NEW_ADDRESS, transport, ...OVERRIDES });
    expect(res.swept).toBe(false);
    if (res.swept) throw new Error('unreachable');
    expect(res.reason).toBe('nothing_to_sweep');
    expect(calls.map((c) => c.method)).not.toContain('eth_sendRawTransaction');
  });

  it('a FAILED balance read is sweep_failed/unknown — never a false nothing_to_sweep', async () => {
    const { transport } = makeMockTransport({ pvtBalance: 0n, nativeWei: 0n, balanceThrows: true });
    const res = await sweepErc20ToNewKey({ oldPrivateKey: OLD_PRIV, newAddress: NEW_ADDRESS, transport, ...OVERRIDES });
    expect(res.swept).toBe(false);
    if (res.swept) throw new Error('unreachable');
    // RED control (mutation: `catch { return nothing_to_sweep }` → this fails):
    // an unknown balance must never report "all clear".
    expect(res.reason).not.toBe('nothing_to_sweep');
    expect(res.reason).toBe('sweep_failed');
    if (res.reason !== 'sweep_failed') throw new Error('unreachable');
    expect(res.strandedAtomic).toBe('unknown');
  });

  it('rejects an invalid destination without reading the chain', async () => {
    const { transport, calls } = makeMockTransport({ pvtBalance: 1n, nativeWei: 1n });
    const res = await sweepErc20ToNewKey({ oldPrivateKey: OLD_PRIV, newAddress: '0xnothex', transport, ...OVERRIDES });
    expect(res.swept).toBe(false);
    if (res.swept) throw new Error('unreachable');
    expect(res.reason).toBe('sweep_failed');
    expect(calls).toHaveLength(0);
  });
});

describe('rotateKeyAndSweep', () => {
  const oldKeyPair = generateAgentKeyPair();
  const newKeyPair = generateAgentKeyPair();
  const config: RotateKeyConfig = {
    relayUrl: 'https://api.provian.ai',
    walletId: 'wallet_aw_test-uuid',
    oldPrivateKey: oldKeyPair.privateKey,
    newPrivateKey: newKeyPair.privateKey,
    apiKey: 'pvn_live_abcdef1234567890',
    apiSecret: `pvns_${'a'.repeat(64)}`,
  };
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  beforeEach(() => {
    mockFetch.mockReset();
    // anchor GET → 404 (no escrow), rotate POST → 200 with the new address.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/recovery-anchor')) {
        return { ok: false, status: 404, json: async () => ({ error: 'no_recovery_escrow' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          wallet_id: config.walletId,
          old_address: oldKeyPair.address,
          new_address: newKeyPair.address,
          api_key: 'pvn_live_' + 'b'.repeat(32),
          api_secret: `pvns_${'b'.repeat(64)}`,
          rotated_at: 1_800_000_000_000,
        }),
      };
    });
  });

  it('rotates THEN sweeps, returning both the new credentials and the sweep outcome', async () => {
    const balance = 500_000000000000000000n; // 500 PVT
    const { transport } = makeMockTransport({ pvtBalance: balance, nativeWei: 10n ** 16n });

    const res = await rotateKeyAndSweep(config, { transport });

    // Rotation is authoritative and intact.
    expect(res.newAddress).toBe(newKeyPair.address);
    expect(res.apiKey).toBe('pvn_live_' + 'b'.repeat(32));
    // Sweep moved the balance to the rotated address.
    expect(res.sweep.swept).toBe(true);
    if (!res.sweep.swept) throw new Error('unreachable');
    expect(res.sweep.amountAtomic).toBe(balance.toString());
    expect(res.sweep.newAddress).toBe(getAddress(newKeyPair.address));
  });

  it('a sweep failure NEVER undoes the rotation (fail-closed)', async () => {
    // The sweep read fails, but the rotation already succeeded and must stand.
    const { transport } = makeMockTransport({ pvtBalance: 0n, nativeWei: 0n, balanceThrows: true });

    const res = await rotateKeyAndSweep(config, { transport });

    // RED control (mutation: `await rotateKey; return { ...rotation, sweep: await sweep }`
    // WITHOUT the sweep being fail-closed — i.e. let sweep throw — makes this reject):
    // rotateKeyAndSweep must still resolve with the rotation credentials.
    expect(res.newAddress).toBe(newKeyPair.address);
    expect(res.apiKey).toBe('pvn_live_' + 'b'.repeat(32));
    expect(res.sweep.swept).toBe(false);
    if (res.sweep.swept) throw new Error('unreachable');
    expect(res.sweep.reason).toBe('sweep_failed');
  });
});
