/**
 * the ONE swap rule every lane reads (`wallet-exchange.ts`). Each RED
 * case differs from an adjacent GREEN case in exactly the variable the rule reads
 *.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence } from '../onchain/economic-discovery';
import {
  BASE_SWAP_TARGETS,
  BASE_UNISWAP_ROUTERS,
  VERIFIED_COMMERCE_CUT_LINE_MS,
  WETH_BASE,
  ZEROX_ALLOWANCE_HOLDER_BASE,
  WETH_WITHDRAWAL_TOPIC,
  LIFI_DIAMOND,
  LIFI_TRANSFER_STARTED_TOPIC,
  MULTICHAIN_COMMERCE_CUT_LINE_MS,
  classifyWalletExchange,
  isWalletBridgeSwap,
  usdcLegIsWalletExchange,
} from './wallet-exchange';
import { OUTBOUND_CHAIN_CONFIGS } from './outbound-usdc-watcher';
import { CHAIN_RECORD_SWAP_TARGETS } from './chain-record-watcher';
import { TEST_BLOCK, topicOf, transactionEvidence, transferLog } from './__test-helpers__/base-transaction-evidence';

const WALLET = '0xa11ce00000000000000000000000000000000001';
const SETTLER = '0x5e77100000000000000000000000000000000005';
const STRANGER = '0x5000000000000000000000000000000000000005';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const TX = `0x${'cd'.repeat(32)}`;

function usdcToWethVia0x(over: Partial<Omit<BaseTransactionEvidence, 'evidenceHash'>> = {}) {
  return transactionEvidence({
    transactionHash: TX,
    fromAddress: WALLET,
    toAddress: ZEROX_ALLOWANCE_HOLDER_BASE,
    logs: [
      transferLog(TX, BASE_USDC_ADDRESS, WALLET, SETTLER, 5_000_000n, 1),
      transferLog(TX, WETH_BASE, SETTLER, WALLET, 2_000_000_000_000_000n, 2),
    ],
    ...over,
  });
}

describe('one source for swap targets', () => {
  it('0x AllowanceHolder and the Uniswap routers are the swap targets, read by every lane', () => {
    expect(BASE_SWAP_TARGETS.has(ZEROX_ALLOWANCE_HOLDER_BASE)).toBe(true);
    for (const router of BASE_UNISWAP_ROUTERS) expect(BASE_SWAP_TARGETS.has(router)).toBe(true);
    expect(CHAIN_RECORD_SWAP_TARGETS).toBe(BASE_SWAP_TARGETS);
    expect([...OUTBOUND_CHAIN_CONFIGS.base.dexRouters].sort()).toEqual([...BASE_UNISWAP_ROUTERS].sort());
  });
});

describe('classifyWalletExchange', () => {
  it('GREEN: USDC → WETH through 0x, signed by the wallet, is its exchange (carried by the USDC leg)', () => {
    const verdict = classifyWalletExchange(usdcToWethVia0x(), WALLET);
    expect(verdict).toMatchObject({ exchange: true, carrier: { kind: 'erc20', log: { address: BASE_USDC_ADDRESS } } });
  });

  it('RED: the same transaction signed by someone else is not this wallet\'s exchange', () => {
    expect(classifyWalletExchange(usdcToWethVia0x({ fromAddress: STRANGER }), WALLET))
      .toEqual({ exchange: false, reason: 'sender_not_wallet' });
  });

  it('RED: the same legs to a non-swap target are not an exchange', () => {
    expect(classifyWalletExchange(usdcToWethVia0x({ toAddress: STRANGER }), WALLET))
      .toEqual({ exchange: false, reason: 'not_a_swap_target' });
  });

  it('RED: through 0x but the wallet got back only what it gave is not an exchange', () => {
    const verdict = classifyWalletExchange(usdcToWethVia0x({
      logs: [
        transferLog(TX, BASE_USDC_ADDRESS, WALLET, SETTLER, 5_000_000n, 1),
        transferLog(TX, BASE_USDC_ADDRESS, SETTLER, WALLET, 4_000_000n, 2),
      ],
    }), WALLET);
    expect(verdict).toEqual({ exchange: false, reason: 'swap_without_exchange' });
  });

  it('GREEN: native ETH → DAI is an exchange carried by the native value', () => {
    const verdict = classifyWalletExchange(usdcToWethVia0x({
      valueWei: '1000',
      logs: [transferLog(TX, DAI, SETTLER, WALLET, 7n, 1)],
    }), WALLET);
    expect(verdict).toEqual({ exchange: true, carrier: { kind: 'native', amountWei: 1000n } });
  });

  it('RED: native ETH → WETH is a wrap, not an exchange', () => {
    const verdict = classifyWalletExchange(usdcToWethVia0x({
      valueWei: '1000',
      logs: [transferLog(TX, WETH_BASE, SETTLER, WALLET, 1000n, 1)],
    }), WALLET);
    expect(verdict).toEqual({ exchange: false, reason: 'swap_without_exchange' });
  });

  it('RED: a zero-amount inbound leg exchanges nothing', () => {
    const verdict = classifyWalletExchange(usdcToWethVia0x({
      logs: [
        transferLog(TX, BASE_USDC_ADDRESS, WALLET, SETTLER, 5_000_000n, 1),
        transferLog(TX, WETH_BASE, SETTLER, WALLET, 0n, 2),
      ],
    }), WALLET);
    expect(verdict).toEqual({ exchange: false, reason: 'swap_without_exchange' });
  });
});

describe('usdcLegIsWalletExchange — the USDC watchers\' label', () => {
  const facts = (over: Partial<Parameters<typeof usdcLegIsWalletExchange>[0]> = {}) => ({
    transactionHash: TX,
    blockTimestampMs: VERIFIED_COMMERCE_CUT_LINE_MS,
    transactionSubmitter: WALLET,
    transactionTo: ZEROX_ALLOWANCE_HOLDER_BASE,
    ...over,
  });

  it('GREEN: at the landing, a wallet-signed leg to 0x reads the transaction and finds the exchange', async () => {
    const read = jest.fn(async () => usdcToWethVia0x());
    await expect(usdcLegIsWalletExchange(facts(), WALLET, read)).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith(TX);
  });

  it('RED: one millisecond before the landing it is never a swap by this rule, and nothing is read', async () => {
    const read = jest.fn(async () => usdcToWethVia0x());
    await expect(usdcLegIsWalletExchange(facts({ blockTimestampMs: VERIFIED_COMMERCE_CUT_LINE_MS - 1 }), WALLET, read))
      .resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('RED: a leg the wallet did not submit, or not to a swap target, is decided without a read', async () => {
    const read = jest.fn(async () => usdcToWethVia0x());
    await expect(usdcLegIsWalletExchange(facts({ transactionSubmitter: STRANGER }), WALLET, read)).resolves.toBe(false);
    await expect(usdcLegIsWalletExchange(facts({ transactionTo: STRANGER }), WALLET, read)).resolves.toBe(false);
    await expect(usdcLegIsWalletExchange(facts({ transactionTo: null }), WALLET, read)).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('RED: no reader → throws (the claim stays pending; never a guessed label)', async () => {
    await expect(usdcLegIsWalletExchange(facts(), WALLET, undefined))
      .rejects.toThrow('wallet_exchange_transaction_reader_unavailable');
  });

  it('RED: evidence for another transaction is refused', async () => {
    const other = usdcToWethVia0x({ transactionHash: `0x${'ee'.repeat(32)}` });
    await expect(usdcLegIsWalletExchange(facts(), WALLET, async () => other))
      .rejects.toThrow('wallet_exchange_evidence_mismatch');
  });

  it('RED: a wallet-signed leg to 0x that exchanged nothing is not a swap', async () => {
    const noExchange = usdcToWethVia0x({ logs: [transferLog(TX, BASE_USDC_ADDRESS, WALLET, SETTLER, 5n, 1)] });
    await expect(usdcLegIsWalletExchange(facts(), WALLET, async () => noExchange)).resolves.toBe(false);
  });
});

describe('a swap INTO native ETH (review r1 defect 3): recognised by the WETH unwrap that pays it', () => {
  const ROUTER = [...BASE_UNISWAP_ROUTERS][0];
  const withdrawal = (src: string, wad: bigint, logIndex: number) => ({
    address: WETH_BASE,
    topics: [WETH_WITHDRAWAL_TOPIC, topicOf(src)],
    data: `0x${wad.toString(16).padStart(64, '0')}`,
    blockNumber: TEST_BLOCK,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex,
    removed: false,
  });
  const toEth = (given: string, logs: ReturnType<typeof withdrawal>[]) => transactionEvidence({
    transactionHash: TX, fromAddress: WALLET, toAddress: ROUTER,
    logs: [transferLog(TX, given, WALLET, SETTLER, 5_000_000n, 1), ...logs],
  });

  it('GREEN: USDC → ETH through a Uniswap router (the router unwraps WETH) is an exchange', () => {
    expect(classifyWalletExchange(toEth(BASE_USDC_ADDRESS, [withdrawal(ROUTER, 10n ** 15n, 2)]), WALLET))
      .toMatchObject({ exchange: true, carrier: { kind: 'erc20', log: { address: BASE_USDC_ADDRESS } } });
  });
  it('GREEN: DAI → ETH through 0x is an exchange', () => {
    const ev = transactionEvidence({
      transactionHash: TX, fromAddress: WALLET, toAddress: ZEROX_ALLOWANCE_HOLDER_BASE,
      logs: [transferLog(TX, DAI, WALLET, SETTLER, 7n, 1), withdrawal(SETTLER, 3n, 2)],
    });
    expect(classifyWalletExchange(ev, WALLET).exchange).toBe(true);
  });
  it('RED: the same legs without the unwrap are no exchange', () => {
    expect(classifyWalletExchange(toEth(BASE_USDC_ADDRESS, []), WALLET).exchange).toBe(false);
  });
  it('RED: giving WETH and unwrapping it is an unwrap, not an exchange', () => {
    expect(classifyWalletExchange(toEth(WETH_BASE, [withdrawal(ROUTER, 10n, 2)]), WALLET).exchange).toBe(false);
  });
  it('RED: the wallet\'s own unwrap, or a zero unwrap, does not count', () => {
    expect(classifyWalletExchange(toEth(BASE_USDC_ADDRESS, [withdrawal(WALLET, 10n, 2)]), WALLET).exchange).toBe(false);
    expect(classifyWalletExchange(toEth(BASE_USDC_ADDRESS, [withdrawal(ROUTER, 0n, 2)]), WALLET).exchange).toBe(false);
  });
  it('RED: a Withdrawal-shaped event from a contract other than WETH does not count', () => {
    const fake = { ...withdrawal(ROUTER, 10n, 2), address: '0x7777777777777777777777777777777777777777' };
    expect(classifyWalletExchange(toEth(BASE_USDC_ADDRESS, [fake]), WALLET).exchange).toBe(false);
  });
});

describe('a USDC leg into the LI.FI Diamond (the USDC watchers\' label from the multichain landing)', () => {
  const facts = (over: Partial<Parameters<typeof usdcLegIsWalletExchange>[0]> = {}) => ({
    transactionHash: TX,
    blockTimestampMs: MULTICHAIN_COMMERCE_CUT_LINE_MS,
    transactionSubmitter: WALLET,
    transactionTo: LIFI_DIAMOND,
    ...over,
  });
  const bridge = (withEvent: boolean) => transactionEvidence({
    transactionHash: TX,
    fromAddress: WALLET,
    toAddress: LIFI_DIAMOND,
    blockTimestampMs: MULTICHAIN_COMMERCE_CUT_LINE_MS,
    logs: [
      transferLog(TX, BASE_USDC_ADDRESS, WALLET, LIFI_DIAMOND, 5_000_000n, 1),
      ...(withEvent ? [{ ...transferLog(TX, LIFI_DIAMOND, WALLET, WALLET, 1n, 2), topics: [LIFI_TRANSFER_STARTED_TOPIC], data: '0x' }] : []),
    ],
  });

  it('GREEN: the Diamond\'s transfer-started event makes the USDC bridge a swap', async () => {
    await expect(usdcLegIsWalletExchange(facts(), WALLET, async () => bridge(true))).resolves.toBe(true);
    expect(isWalletBridgeSwap(bridge(true), WALLET)).toBe(true);
  });

  it('RED: without the event, a USDC leg into the Diamond with nothing back is not a swap', async () => {
    await expect(usdcLegIsWalletExchange(facts(), WALLET, async () => bridge(false))).resolves.toBe(false);
    expect(isWalletBridgeSwap(bridge(false), WALLET)).toBe(false);
  });

  it('RED: before the multichain landing a Diamond leg is decided without a read', async () => {
    const read = jest.fn(async () => bridge(true));
    await expect(usdcLegIsWalletExchange(facts({ blockTimestampMs: MULTICHAIN_COMMERCE_CUT_LINE_MS - 1 }), WALLET, read)).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
