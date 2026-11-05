/**
 * Headless, deterministic tests for the agent EVM signer (slice 1).
 *
 * Oracles: viem itself (parseTransaction / recoverTransactionAddress) decodes
 * and verifies the signed raw tx, and ethers (devDependency) cross-checks the
 * ERC-20 calldata. No chain is touched: a mock viem `custom` transport answers
 * the JSON-RPC calls (eth_getTransactionCount / eth_estimateGas /
 * eth_sendRawTransaction) and records them so RPC shaping is asserted directly,
 * mirroring the eth_call pattern in x402-signer.test.ts.
 *
 * Fork / live broadcast (real nonce/gas estimation against a node, real
 * settlement + confirmations, the /v1/bonds-style verified PE) is DEFERRED to a
 * later slice - see the build note. Everything provable without spending funds
 * or running a node is here.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  custom,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem';
import {
  sendTransaction,
  transferToken,
  transferNative,
  encodeErc20Transfer,
  encodeErc20Burn,
  EvmSignerError,
  type EvmWallet,
  type PETransferReport,
} from './evm-signer';
import { TOKEN_ALLOWLIST, CONTRACT_ALLOWLIST } from './evm-allowlist';
import { encryptKeystore, withDecryptedKey, type DecryptedKey } from './keystore';

// Deterministic test key (NOT a real wallet). Same key family as the other SDK
// signer tests; this is the well-known anvil/hardhat account #1.
const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const WALLET: EvmWallet = { privateKeyHex: TEST_PRIV_KEY, address: TEST_ADDRESS };

// A checksummed, NON-allowlisted target (hardhat account #2).
const RANDOM_TARGET = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
// Recipient (hardhat account #1's pair partner).
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// Prefilled fees so the mock doesn't need to model fee estimation; nonce + gas
// are intentionally left out so viem fetches them (we assert those RPCs fire).
const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

interface MockCall {
  method: string;
  params?: unknown;
}

/**
 * A viem `custom` transport that answers the minimal RPC set an EIP-1559
 * sendTransaction needs and records every call. eth_sendRawTransaction captures
 * the signed raw tx and returns its keccak256 as the hash.
 */
let canonicalNonce = 0;
beforeEach(() => { canonicalNonce = 0; });

function makeMockTransport(chainId: number) {
  const calls: MockCall[] = [];
  let lastRawTx: Hex | undefined;
  const toHex = (n: number) => `0x${n.toString(16)}`;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return toHex(chainId);
        case 'eth_getTransactionCount':
          return `0x${canonicalNonce.toString(16)}`;
        case 'eth_estimateGas':
          return '0x186a0'; // 100000
        case 'eth_gasPrice':
          return '0x3b9aca00'; // 1 gwei
        case 'eth_maxPriorityFeePerGas':
          return '0x3b9aca00';
        case 'eth_blockNumber':
          return '0x1';
        case 'eth_sendRawTransaction':
          lastRawTx = (params as Hex[])[0];
          canonicalNonce = Number(parseTransaction(lastRawTx).nonce ?? 0) + 1;
          return keccak256(lastRawTx);
        default:
          throw new Error(`mock transport: unexpected RPC method ${method}`);
      }
    },
  });
  return { transport, calls, getRawTx: () => lastRawTx };
}

describe('encodeErc20Transfer — byte-exact calldata', () => {
  it('matches the hand-built 0xa9059cbb + padded args', () => {
    const data = encodeErc20Transfer(RECIPIENT, 1_000_000n);
    const expected =
      '0xa9059cbb' +
      RECIPIENT.slice(2).toLowerCase().padStart(64, '0') +
      (1_000_000n).toString(16).padStart(64, '0');
    expect(data.toLowerCase()).toBe(expected);
    expect(data.slice(0, 10)).toBe('0xa9059cbb');
    expect(data.length).toBe(2 + 8 + 64 + 64);
  });

  it('matches the ethers oracle', () => {
    const data = encodeErc20Transfer(RECIPIENT, 123_456_789n);
    const iface = new ethers.Interface(['function transfer(address,uint256)']);
    const oracle = iface.encodeFunctionData('transfer', [RECIPIENT, 123_456_789n]);
    expect(data.toLowerCase()).toBe(oracle.toLowerCase());
  });

  it('rejects a malformed recipient and a negative amount', () => {
    expect(() => encodeErc20Transfer('0xnothex', 1n)).toThrow(EvmSignerError);
    expect(() => encodeErc20Transfer(RECIPIENT, -1n)).toThrow(/non-negative/);
  });
});

describe('encodeErc20Burn — byte-exact calldata (burn-to-present demand side)', () => {
  // The holder-burn the presenter broadcasts to its OWN PVT before presenting.
  // A wrong selector or a mis-encoded amount burns the wrong value (or reverts),
  // so the bytes are pinned two ways: hand-built AND against the ethers oracle.
  it('matches the hand-built 0x42966c68 + padded amount', () => {
    const data = encodeErc20Burn(1_000_000n);
    const expected = '0x42966c68' + (1_000_000n).toString(16).padStart(64, '0');
    expect(data.toLowerCase()).toBe(expected);
    expect(data.slice(0, 10)).toBe('0x42966c68'); // burn(uint256) selector
    expect(data.length).toBe(2 + 8 + 64); // 0x + 4-byte selector + one 32-byte word
  });

  it('matches the ethers oracle for a large 18-dp PVT amount', () => {
    const amount = 1_185_580_000_000_000_000_000n; // 1185.58 PVT atomic
    const data = encodeErc20Burn(amount);
    const iface = new ethers.Interface(['function burn(uint256)']);
    const oracle = iface.encodeFunctionData('burn', [amount]);
    expect(data.toLowerCase()).toBe(oracle.toLowerCase());
  });

  // RED control : the encoder MUST refuse a non-positive burn. A zero or
  // negative burn is never a valid presentation demand; the guard reports it
  // rather than emitting `burn(0)` calldata that would waste gas / mislead.
  it('RED control — rejects a zero or negative burn amount', () => {
    expect(() => encodeErc20Burn(0n)).toThrow(/positive/);
    expect(() => encodeErc20Burn(-5n)).toThrow(EvmSignerError);
    // ...and a positive amount is accepted (so the guard is not refusing everything).
    expect(encodeErc20Burn(1n).slice(0, 10)).toBe('0x42966c68');
  });
});

describe('transferToken — ERC-20 transfer to the pinned token contract', () => {
  it('signs an EIP-1559 tx to the token contract, recipient+amount in calldata', async () => {
    const { transport, calls, getRawTx } = makeMockTransport(8453);
    const usdc = TOKEN_ALLOWLIST.base.USDC.address;

    const res = await transferToken(WALLET, {
      token: 'USDC',
      to: RECIPIENT,
      amount: 1_000_000n, // 1 USDC (6 decimals), atomic
      chain: 'base',
      transport,
      ...FEES,
    });

    expect(res.to).toBe(getAddress(usdc)); // tx `to` is the token contract
    expect(res.tokenAddress).toBe(usdc);
    expect(res.recipient).toBe(getAddress(RECIPIENT));
    expect(res.amountAtomic).toBe('1000000');
    expect(res.value).toBe('0');
    expect(res.chainId).toBe(8453);
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // Decode the actual signed raw tx and verify its fields + signer.
    const raw = getRawTx()!;
    const parsed = parseTransaction(raw);
    expect(parsed.type).toBe('eip1559');
    expect(parsed.chainId).toBe(8453);
    expect(parsed.to?.toLowerCase()).toBe(usdc.toLowerCase());
    expect(parsed.value ?? 0n).toBe(0n);
    expect(parsed.data).toBe(encodeErc20Transfer(RECIPIENT, 1_000_000n));
    const signer = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
    expect(getAddress(signer)).toBe(getAddress(TEST_ADDRESS));

    // RPC shaping: nonce + gas were fetched, raw tx was broadcast.
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('eth_getTransactionCount');
    expect(methods).toContain('eth_estimateGas');
    expect(methods).toContain('eth_sendRawTransaction');
  });

  it('accepts a string amount and routes PVT to its pinned address', async () => {
    const { transport, getRawTx } = makeMockTransport(8453);
    const pvt = TOKEN_ALLOWLIST.base.PVT.address;
    const res = await transferToken(WALLET, {
      token: 'PVT',
      to: RECIPIENT,
      amount: '5000000000000000000', // 5 PVT atomic
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(res.tokenAddress).toBe(pvt);
    expect(parseTransaction(getRawTx()!).to?.toLowerCase()).toBe(pvt.toLowerCase());
    expect(res.amountAtomic).toBe('5000000000000000000');
  });

  it('rejects a non-allowlisted token at runtime (no RPC call)', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await expect(
      transferToken(WALLET, {
        // Cast past the compile-time guard to prove the runtime guard holds.
        token: 'DAI' as unknown as 'USDC',
        to: RECIPIENT,
        amount: 1n,
        chain: 'base',
        transport,
        ...FEES,
      }),
    ).rejects.toThrow(/not allowlisted/);
    expect(calls).toHaveLength(0);
  });
});

describe('broadcast preparation — one read each, no eth_fillTransaction', () => {
  it('reads canonical nonce bounds and gas, sends one journaled raw tx, never requests pending state', async () => {
    const { transport, calls, getRawTx } = makeMockTransport(8453);
    await transferNative(WALLET, { to: RANDOM_TARGET, amount: 1n, chain: 'base', transport, ...FEES });
    const methods = calls.map((c) => c.method);
    expect(methods).not.toContain('eth_fillTransaction');
    expect(methods.filter((m) => m === 'eth_getTransactionCount')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'eth_getTransactionCount').map((c) => (c.params as string[])[1])).toEqual(['latest']);
    expect(methods.filter((m) => m === 'eth_estimateGas')).toHaveLength(1);
    expect(methods.filter((m) => m === 'eth_sendRawTransaction')).toHaveLength(1);
    const count = calls.find((c) => c.method === 'eth_getTransactionCount')!;
    expect((count.params as unknown[])[1]).toBe('latest');
    const parsed = parseTransaction(getRawTx()!);
    expect(parsed.type).toBe('eip1559');
    expect(parsed.chainId).toBe(8453);
    expect(parsed.gas).toBe(100_000n);
    expect(parsed.maxFeePerGas).toBe(FEES.maxFeePerGas);
  });
});

describe('transferNative — bare ETH value send to any address', () => {
  it('signs a value tx with no calldata to an arbitrary recipient', async () => {
    const { transport, getRawTx } = makeMockTransport(8453);
    const res = await transferNative(WALLET, {
      to: RANDOM_TARGET, // not allowlisted, but native sends are allowed anywhere
      amount: 10_000_000_000_000_000n, // 0.01 ETH
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(res.to).toBe(getAddress(RANDOM_TARGET));
    expect(res.value).toBe('10000000000000000');
    expect(res.data).toBe('0x');

    const parsed = parseTransaction(getRawTx()!);
    expect(parsed.to?.toLowerCase()).toBe(RANDOM_TARGET.toLowerCase());
    expect(parsed.value).toBe(10_000_000_000_000_000n);
    expect(parsed.data ?? '0x').toBe('0x');
    const signer = await recoverTransactionAddress({ serializedTransaction: getRawTx()! as `0x02${string}` });
    expect(getAddress(signer)).toBe(getAddress(TEST_ADDRESS));
  });
});

describe('per-chain coverage — Arbitrum + Optimism', () => {
  for (const [chain, chainId] of [
    ['arbitrum', 42161],
    ['optimism', 10],
  ] as const) {
    it(`signs a USDC transfer with the correct chainId + pinned address on ${chain}`, async () => {
      const { transport, getRawTx } = makeMockTransport(chainId);
      const usdc = TOKEN_ALLOWLIST[chain].USDC.address;
      const res = await transferToken(WALLET, {
        token: 'USDC',
        to: RECIPIENT,
        amount: 1_000_000n,
        chain,
        transport,
        ...FEES,
      });
      expect(res.chainId).toBe(chainId);
      expect(res.tokenAddress).toBe(usdc);
      const parsed = parseTransaction(getRawTx()!);
      expect(parsed.chainId).toBe(chainId);
      expect(parsed.to?.toLowerCase()).toBe(usdc.toLowerCase());
      expect(parsed.data).toBe(encodeErc20Transfer(RECIPIENT, 1_000_000n));
      const signer = await recoverTransactionAddress({ serializedTransaction: getRawTx()! as `0x02${string}` });
      expect(getAddress(signer)).toBe(getAddress(TEST_ADDRESS));
    });
  }

  it('signs a native send on optimism with the correct chainId', async () => {
    const { transport, getRawTx } = makeMockTransport(10);
    const res = await transferNative(WALLET, {
      to: RECIPIENT,
      amount: 1_000n,
      chain: 'optimism',
      transport,
      ...FEES,
    });
    expect(res.chainId).toBe(10);
    expect(parseTransaction(getRawTx()!).chainId).toBe(10);
  });
});

describe('sendTransaction — allowlist guardrail', () => {
  it('blocks a non-allowlisted target by default, before any RPC', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await expect(
      sendTransaction(WALLET, {
        to: RANDOM_TARGET,
        data: '0xdeadbeef',
        chain: 'base',
        transport,
        ...FEES,
      }),
    ).rejects.toThrow(/not allowlisted/);
    await expect(
      sendTransaction(WALLET, { to: RANDOM_TARGET, data: '0xdeadbeef', chain: 'base', transport, ...FEES }),
    ).rejects.toThrow(EvmSignerError);
    expect(calls).toHaveLength(0); // guard short-circuits before the network
  });

  it('proceeds when the CALLER sets allowUnlistedTarget:true', async () => {
    const { transport, getRawTx } = makeMockTransport(8453);
    const res = await sendTransaction(WALLET, {
      to: RANDOM_TARGET,
      data: '0xdeadbeef',
      value: '0',
      chain: 'base',
      allowUnlistedTarget: true,
      transport,
      ...FEES,
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parseTransaction(getRawTx()!).data).toBe('0xdeadbeef');
  });

  it('allows an allowlisted contract target (BondPool) without the opt-out', async () => {
    const { transport } = makeMockTransport(8453);
    const res = await sendTransaction(WALLET, {
      to: CONTRACT_ALLOWLIST.base.BondPool, // live Base BondPool (Pass-3), allowlisted
      data: '0x',
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('sendTransaction — unlimited-approve guard', () => {
  const USDC = TOKEN_ALLOWLIST.base.USDC.address; // allowlisted, so the target guard passes
  const PVT = TOKEN_ALLOWLIST.base.PVT.address;
  const MAX_UINT256 = 2n ** 256n - 1n;
  const approveCalldata = (amount: bigint) =>
    '0x095ea7b3' +
    RANDOM_TARGET.slice(2).toLowerCase().padStart(64, '0') +
    amount.toString(16).padStart(64, '0');

  it('rejects an effectively-unlimited approve (MAX_UINT256) by default, before any RPC', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await expect(
      sendTransaction(WALLET, { to: USDC, data: approveCalldata(MAX_UINT256), chain: 'base', transport, ...FEES }),
    ).rejects.toThrow(/unlimited/i);
    await expect(
      sendTransaction(WALLET, { to: USDC, data: approveCalldata(MAX_UINT256), chain: 'base', transport, ...FEES }),
    ).rejects.toThrow(EvmSignerError);
    expect(calls).toHaveLength(0); // guard short-circuits before the network
  });

  it('rejects the "unlimited" values dapps actually request — uint160-max (Permit2 style), uint128-max, 2^200 — not only MAX_UINT256', async () => {
    // RED control (2026-10-17): under the former 2^200 ceiling every one of these signed as "bounded".
    const { transport, calls } = makeMockTransport(8453);
    for (const amount of [2n ** 160n - 1n, 2n ** 128n - 1n, 2n ** 200n, 2n ** 96n + 1n]) {
      await expect(
        sendTransaction(WALLET, { to: USDC, data: approveCalldata(amount), chain: 'base', transport, ...FEES }),
      ).rejects.toThrow(/unlimited/i);
    }
    expect(calls).toHaveLength(0);
  });

  it('allows a bounded approve (under the ceiling) without the opt-out', async () => {
    const { transport, getRawTx } = makeMockTransport(8453);
    const res = await sendTransaction(WALLET, {
      to: USDC,
      data: approveCalldata(1_000n * 10n ** 18n),
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parseTransaction(getRawTx()!).data?.slice(0, 10)).toBe('0x095ea7b3');
  });

  it('proceeds on a MAX approve when the CALLER sets allowUnlimitedApprove:true', async () => {
    const { transport } = makeMockTransport(8453);
    const res = await sendTransaction(WALLET, {
      to: USDC,
      data: approveCalldata(MAX_UINT256),
      chain: 'base',
      allowUnlimitedApprove: true,
      transport,
      ...FEES,
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("does not misfire on the bond flow's bounded grossed-up approve (~773 PVT)", async () => {
    const { transport } = makeMockTransport(8453);
    const res = await sendTransaction(WALLET, {
      to: PVT,
      data: approveCalldata(773_195_876_288_659_793_815n), // the real postBond deposit
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // WS8: the guard must be symmetric — increaseAllowance(spender, MAX) and an
  // EIP-2612 permit(.., MAX, ..) grant the same unbounded spend as approve(MAX).
  const word = (v: bigint) => v.toString(16).padStart(64, '0');
  const spenderWord = RANDOM_TARGET.slice(2).toLowerCase().padStart(64, '0');
  const increaseAllowanceCalldata = (amount: bigint) => '0x39509351' + spenderWord + word(amount);
  const permitCalldata = (value: bigint) =>
    '0xd505accf' +
    spenderWord + // owner
    spenderWord + // spender
    word(value) + // value (word #3 — the guard reads this)
    word(0n) + // deadline
    word(27n) + // v
    '0'.repeat(64) + // r
    '0'.repeat(64); // s

  it('rejects an effectively-unlimited increaseAllowance, before any RPC', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await expect(
      sendTransaction(WALLET, { to: USDC, data: increaseAllowanceCalldata(MAX_UINT256), chain: 'base', transport, ...FEES }),
    ).rejects.toThrow(/unlimited .*increaseAllowance/i);
    expect(calls).toHaveLength(0);
  });

  it('allows a bounded increaseAllowance', async () => {
    const { transport } = makeMockTransport(8453);
    const res = await sendTransaction(WALLET, {
      to: USDC,
      data: increaseAllowanceCalldata(1_000n * 10n ** 18n),
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects an effectively-unlimited EIP-2612 permit, before any RPC', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await expect(
      sendTransaction(WALLET, { to: USDC, data: permitCalldata(MAX_UINT256), chain: 'base', transport, ...FEES }),
    ).rejects.toThrow(/unlimited .*permit/i);
    expect(calls).toHaveLength(0);
  });

  it('allows a bounded permit and honors the allowUnlimitedApprove opt-out for an unlimited one', async () => {
    const { transport } = makeMockTransport(8453);
    const bounded = await sendTransaction(WALLET, {
      to: USDC,
      data: permitCalldata(500n * 10n ** 6n),
      chain: 'base',
      transport,
      ...FEES,
    });
    expect(bounded.hash).toMatch(/^0x[0-9a-f]{64}$/);

    const optedOut = await sendTransaction(WALLET, {
      to: USDC,
      data: permitCalldata(MAX_UINT256),
      chain: 'base',
      allowUnlimitedApprove: true,
      transport,
      ...FEES,
    });
    expect(optedOut.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('key + signer safety', () => {
  it('rejects when wallet.address does not match the signing key', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await expect(
      transferNative(
        { privateKeyHex: TEST_PRIV_KEY, address: RANDOM_TARGET }, // wrong address
        { to: RECIPIENT, amount: 1n, chain: 'base', transport, ...FEES },
      ),
    ).rejects.toThrow(/does not match/);
    expect(calls).toHaveLength(0);
  });

  it('requires an rpcUrl or transport to broadcast', async () => {
    await expect(
      transferNative(WALLET, { to: RECIPIENT, amount: 1n, chain: 'base', ...FEES }),
    ).rejects.toThrow(/rpcUrl or transport/);
  });

  it('rejects an unsupported chain', async () => {
    const { transport } = makeMockTransport(8453);
    await expect(
      transferNative(WALLET, {
        to: RECIPIENT,
        amount: 1n,
        chain: 'ethereum' as unknown as 'base',
        transport,
        ...FEES,
      }),
    ).rejects.toThrow(/unsupported chain/);
  });
});

describe('PE reporting — best-effort, self-asserted', () => {
  it('invokes reportPE with the agent_token_transfer shape after broadcast', async () => {
    const { transport } = makeMockTransport(8453);
    const reports: PETransferReport[] = [];
    const res = await transferToken(WALLET, {
      token: 'USDC',
      to: RECIPIENT,
      amount: 2_000_000n,
      chain: 'base',
      transport,
      ...FEES,
      reportPE: (r) => {
        reports.push(r);
      },
    });
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report.actionType).toBe('agent_token_transfer');
    expect(report.success).toBe(true);
    expect(report.metadata.tx_hash).toBe(res.hash);
    expect(report.metadata.token).toBe('USDC');
    expect(report.metadata.recipient).toBe(getAddress(RECIPIENT));
    expect(report.metadata.amount_atomic).toBe('2000000');
    // The signer no longer stamps a verification claim - the recording
    // endpoint (CommonsInstitutions.recordTransfer -> /transfer/record) is the authority.
    expect(report.metadata.self_asserted).toBeUndefined();
    expect(report.metadata.verified).toBeUndefined();
    expect(report.description.length).toBeGreaterThan(20);
  });

  it('uses agent_native_transfer for native sends', async () => {
    const { transport } = makeMockTransport(8453);
    const reports: PETransferReport[] = [];
    await transferNative(WALLET, {
      to: RECIPIENT,
      amount: 5n,
      chain: 'base',
      transport,
      ...FEES,
      reportPE: (r) => reports.push(r),
    });
    expect(reports[0].actionType).toBe('agent_native_transfer');
    expect(reports[0].metadata.amount_wei).toBe('5');
  });

  it('does NOT fail the transfer when reportPE throws (best-effort)', async () => {
    const { transport } = makeMockTransport(8453);
    const res = await transferToken(WALLET, {
      token: 'USDC',
      to: RECIPIENT,
      amount: 1n,
      chain: 'base',
      transport,
      ...FEES,
      reportPE: () => {
        throw new Error('relay down');
      },
    });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // WS8-SDK (b): maybeReport must NEVER stamp a verified claim. A verified PE is
  // produced ONLY by the relay's on-chain re-verification path
  // (CommonsInstitutions.recordTransfer -> /transfer/record). Cover all three signer
  // surfaces, including a general sendTransaction.
  it('never stamps verified (or self_asserted) on the report for any signer surface', async () => {
    const { transport } = makeMockTransport(8453);
    const reports: PETransferReport[] = [];
    const push = (r: PETransferReport) => { reports.push(r); };

    await transferToken(WALLET, { token: 'USDC', to: RECIPIENT, amount: 1n, chain: 'base', transport, ...FEES, reportPE: push });
    await transferNative(WALLET, { to: RECIPIENT, amount: 1n, chain: 'base', transport, ...FEES, reportPE: push });
    await sendTransaction(WALLET, {
      to: TOKEN_ALLOWLIST.base.USDC.address, // allowlisted
      data: encodeErc20Transfer(RECIPIENT, 1n),
      chain: 'base',
      transport,
      ...FEES,
      reportPE: push,
    });

    expect(reports).toHaveLength(3);
    for (const r of reports) {
      expect(r.metadata.verified).toBeUndefined();
      expect(r.metadata.self_asserted).toBeUndefined();
    }
  });
});

// WS8-SDK (a): the opt-in waitForReceipt is OFF by default - the signer returns
// on BROADCAST, not on confirmation. Assert the receipt RPC fires only when the
// caller sets waitForReceipt:true.
describe('waitForReceipt opt-in — broadcast vs confirmed', () => {
  it('does NOT poll for a receipt by default (broadcast-only)', async () => {
    const { transport, calls } = makeMockTransport(8453);
    await transferNative(WALLET, { to: RECIPIENT, amount: 1n, chain: 'base', transport, ...FEES });
    expect(calls.map((c) => c.method)).toContain('eth_sendRawTransaction');
    expect(calls.map((c) => c.method)).not.toContain('eth_getTransactionReceipt');
  });

  it('polls for a receipt when waitForReceipt:true is set', async () => {
    // Mock that returns a mined receipt so waitForTransactionReceipt resolves.
    const calls: MockCall[] = [];
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        calls.push({ method, params });
        switch (method) {
          case 'eth_chainId': return '0x2105'; // 8453
          case 'eth_getTransactionCount': return `0x${canonicalNonce.toString(16)}`;
          case 'eth_estimateGas': return '0x186a0';
          case 'eth_blockNumber': return '0x1';
          case 'eth_sendRawTransaction': canonicalNonce = Number(parseTransaction((params as Hex[])[0]).nonce ?? 0) + 1; return keccak256((params as Hex[])[0]);
          case 'eth_getTransactionReceipt':
            return {
              transactionHash: (params as Hex[])[0],
              status: '0x1',
              blockNumber: '0x1',
              blockHash: '0x' + '1'.repeat(64),
              transactionIndex: '0x0',
              from: TEST_ADDRESS,
              to: RECIPIENT,
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
    const res = await transferNative(WALLET, { to: RECIPIENT, amount: 1n, chain: 'base', transport, waitForReceipt: true, ...FEES });
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calls.map((c) => c.method)).toContain('eth_getTransactionReceipt');
  });

  // Audit Pass-3 #8/#27: a tx can MINE and still REVERT. With waitForReceipt:true
  // the signer must READ receipt.status and REJECT a reverted tx BEFORE reporting
  // a PE — never resolve success + emit a success:true self-asserted PE for a
  // value transfer that moved nothing. Cover all three write surfaces.
  function makeRevertedReceiptTransport() {
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        switch (method) {
          case 'eth_chainId': return '0x2105'; // 8453
          case 'eth_getTransactionCount': return `0x${canonicalNonce.toString(16)}`;
          case 'eth_estimateGas': return '0x186a0';
          case 'eth_blockNumber': return '0x1';
          case 'eth_sendRawTransaction': canonicalNonce = Number(parseTransaction((params as Hex[])[0]).nonce ?? 0) + 1; return keccak256((params as Hex[])[0]);
          case 'eth_getTransactionReceipt':
            return {
              transactionHash: (params as Hex[])[0],
              status: '0x0', // REVERTED (mined, but moved nothing)
              blockNumber: '0x1',
              blockHash: '0x' + '1'.repeat(64),
              transactionIndex: '0x0',
              from: TEST_ADDRESS,
              to: RECIPIENT,
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
    return transport;
  }

  it('rejects a mined-but-REVERTED tx with TX_REVERTED and emits NO success PE (all three surfaces)', async () => {
    const usdc = TOKEN_ALLOWLIST.base.USDC.address;
    for (const call of [
      (rp: PETransferReport[]) => transferNative(WALLET, { to: RECIPIENT, amount: 1n, chain: 'base', transport: makeRevertedReceiptTransport(), waitForReceipt: true, ...FEES, reportPE: (r) => rp.push(r) }),
      (rp: PETransferReport[]) => transferToken(WALLET, { token: 'USDC', to: RECIPIENT, amount: 1n, chain: 'base', transport: makeRevertedReceiptTransport(), waitForReceipt: true, ...FEES, reportPE: (r) => rp.push(r) }),
      (rp: PETransferReport[]) => sendTransaction(WALLET, { to: usdc, data: encodeErc20Transfer(RECIPIENT, 1n), chain: 'base', transport: makeRevertedReceiptTransport(), waitForReceipt: true, ...FEES, reportPE: (r) => rp.push(r) }),
    ]) {
      const reports: PETransferReport[] = [];
      await expect(call(reports)).rejects.toThrow(/reverted/i);
      // The PE reporter must NOT have fired — no success:true PE for a revert.
      expect(reports).toHaveLength(0);
    }
  });

  it('reverted-tx rejection carries the EvmSignerError TX_REVERTED code', async () => {
    await expect(
      transferNative(WALLET, { to: RECIPIENT, amount: 1n, chain: 'base', transport: makeRevertedReceiptTransport(), waitForReceipt: true, ...FEES }),
    ).rejects.toMatchObject({ code: 'TX_REVERTED' });
  });
});

describe('withDecryptedKey — key lifetime confinement', () => {
  const PASS = 'test-passphrase-123';
  // Low scrypt cost for test speed.
  const keystore = encryptKeystore({
    privateKey: TEST_PRIV_KEY,
    address: TEST_ADDRESS,
    publicKey: '00'.repeat(64),
    walletId: 'wallet_aw_test',
    passphrase: PASS,
    // Minimum in-bounds scrypt cost (F34 floor is N=1024); still sub-ms for tests.
    kdfParams: { N: 1024, r: 1, p: 1 },
  });

  it('passes the decrypted key to the callback and returns its result', async () => {
    const out = await withDecryptedKey(keystore, PASS, (key) => {
      expect(key.privateKey).toBe(TEST_PRIV_KEY.slice(2).toLowerCase());
      expect(key.address).toBe(TEST_ADDRESS);
      return 'callback-result';
    });
    expect(out).toBe('callback-result');
  });

  it('drops its key reference after the callback', async () => {
    let captured: DecryptedKey | undefined;
    await withDecryptedKey(keystore, PASS, (key) => {
      captured = key;
    });
    expect(captured!.privateKey).toBe(''); // reference cleared in finally
  });

  it('feeds the key straight into the signer (the canonical usage)', async () => {
    const { transport, getRawTx } = makeMockTransport(8453);
    const res = await withDecryptedKey(keystore, PASS, (key) =>
      transferNative(
        { privateKeyHex: key.privateKey, address: key.address },
        { to: RECIPIENT, amount: 7n, chain: 'base', transport, ...FEES },
      ),
    );
    expect(res.value).toBe('7');
    const signer = await recoverTransactionAddress({ serializedTransaction: getRawTx()! as `0x02${string}` });
    expect(getAddress(signer)).toBe(getAddress(TEST_ADDRESS));
  });

  it('clears the reference even when the callback throws', async () => {
    let captured: DecryptedKey | undefined;
    await expect(
      withDecryptedKey(keystore, PASS, (key) => {
        captured = key;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(captured!.privateKey).toBe('');
  });
});
