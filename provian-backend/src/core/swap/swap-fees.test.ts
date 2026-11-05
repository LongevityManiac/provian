/**
 * swap-fees — the relay's 25 bps swap fee on every route.
 *
 * Fixtures under __fixtures__/ are REAL upstream answers captured 2026-09-25 while proving the fee
 * destinations (docs/wp-runs/SWAP_FEE_ALL_ROUTES_2026-09-25.md). Every verifier is shown passing on
 * the real payload AND failing on a deliberately violating copy of it (the RED control), so none of
 * these guards has only ever been observed green.
 */
import fs from 'fs';
import path from 'path';
import {
  SWAP_FEE_BPS,
  LIFI_FEE_FRACTION,
  LIFI_INTEGRATOR,
  PROVIAN_SOLANA_TREASURY,
  PROVIAN_SOLANA_USDC_FEE_ACCOUNT,
  SOLANA_USDC_MINT,
  SOLANA_WSOL_MINT,
  LIFI_SOLANA_CHAIN_ID,
  JUPITER_PROGRAM_ID,
  SwapFeeError,
  resolveEvmSwapFeeRecipient,
  buildZeroXQuoteQuery,
  verifyZeroXQuoteFee,
  buildLifiQuoteQuery,
  verifyLifiQuoteFee,
  parseJupiterOrderRequest,
  buildJupiterQuoteQuery,
  verifyJupiterQuote,
  buildJupiterSwapBody,
  verifyJupiterTransaction,
  decodeSolanaTransaction,
  encodeSolanaTransaction,
  base58Encode,
  base58Decode32,
  isOnEd25519Curve,
  associatedTokenAddress,
  planJupiterFee,
  parseLookupTableAddresses,
  addFeeAccountCreation,
  SOLANA_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_ATA_PROGRAM_ID,
  SOLANA_MAX_TX_BYTES,
  tokenAccountSize,
  type SolanaMintInfo,
  findSolanaFeeTransfer,
  type DecodedSolanaTx,
  type LifiQuoteView,
} from './swap-fees';
import { PROVIAN_TREASURY, EXPOSED_LEGACY_EOA } from '../config/live-value-recipients';

const fx = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));

const TREASURY = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USER_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const ATTACKER = '0x1111111111111111111111111111111111111111';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const T22 = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'; // PYUSD, a Token-2022 mint
const TREASURY_WSOL = 'Fs42KbAkah3agwXi57LTEeNL1FncDZg3JEce4yJ9eAjd';
const TREASURY_BONK = '7L2gemgzqeMTYvkVFeBQD2m3iwmA3zzseAwjPB57W9ZF';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'; // Token-2022
const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'; // Token-2022
/** The treasury's PYUSD account under the Token-2022 program (@solana/spl-token, 2026-09-25). */
const TREASURY_PYUSD = '7ajFcXZt2Zk5fpkNXdCYX5ykQJfhXd74rd7iHABySmG6';
const PY_HOLDER = 'fr6yQkDmWy6R6pecbUsxXaw6EvRJznZ2HsK5frQgud8';

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SwapFeeError);
    expect((e as SwapFeeError).code).toBe(code);
    return;
  }
  throw new Error(`expected SwapFeeError ${code}, nothing thrown`);
};

describe('rate constants agree', () => {
  it('25 bps everywhere, LI.FI fraction is the same rate', () => {
    expect(SWAP_FEE_BPS).toBe(25);
    expect(Number(LIFI_FEE_FRACTION) * 10_000).toBe(SWAP_FEE_BPS);
    expect(LIFI_INTEGRATOR).toBe('provian');
  });
});

describe('resolveEvmSwapFeeRecipient — pinned to the treasury', () => {
  it('accepts the treasury', () => {
    expect(resolveEvmSwapFeeRecipient({ SWAP_FEE_RECIPIENT: TREASURY })).toBe(TREASURY);
    expect(PROVIAN_TREASURY).toBe(TREASURY.toLowerCase());
  });
  it('RED: unset, a foreign address, and the exposed EOA are all refused', () => {
    expectCode(() => resolveEvmSwapFeeRecipient({}), 'swap_fee_recipient_unset');
    expectCode(() => resolveEvmSwapFeeRecipient({ SWAP_FEE_RECIPIENT: ATTACKER }), 'swap_fee_recipient_not_treasury');
    expect(() => resolveEvmSwapFeeRecipient({ SWAP_FEE_RECIPIENT: EXPOSED_LEGACY_EOA })).toThrow(/exposure/);
  });
});

describe('0x — same-chain EVM', () => {
  const client = {
    chainId: '8453',
    sellToken: ETH,
    buyToken: USDC_BASE,
    sellAmount: '10000000000000000',
    taker: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    slippageBps: '50',
  };

  it('a client request with NO fee comes out fee-bearing', () => {
    const q = buildZeroXQuoteQuery(client, TREASURY);
    expect(q.get('swapFeeRecipient')).toBe(TREASURY);
    expect(q.get('swapFeeBps')).toBe('25');
    expect(q.get('swapFeeToken')).toBe(USDC_BASE);
  });

  it('client fee fields are overwritten or dropped, never honoured', () => {
    const q = buildZeroXQuoteQuery(
      { ...client, swapFeeBps: '0', swapFeeRecipient: ATTACKER, swapFeeToken: ETH, buyTokenPercentageFee: '0', feeRecipient: ATTACKER, buyAmount: '1' },
      TREASURY,
    );
    expect(q.get('swapFeeBps')).toBe('25');
    expect(q.get('swapFeeRecipient')).toBe(TREASURY);
    expect(q.get('swapFeeToken')).toBe(USDC_BASE);
    expect(q.has('buyTokenPercentageFee')).toBe(false);
    expect(q.has('feeRecipient')).toBe(false);
    expect(q.has('buyAmount')).toBe(false);
    expect(q.toString()).not.toContain(ATTACKER.slice(2));
  });

  it('refuses unsupported chains and malformed routing fields', () => {
    expectCode(() => buildZeroXQuoteQuery({ ...client, chainId: '1' }, TREASURY), 'unsupported_chain');
    expectCode(() => buildZeroXQuoteQuery({ ...client, sellAmount: '0' }, TREASURY), 'invalid_request');
    expectCode(() => buildZeroXQuoteQuery({ ...client, taker: undefined }, TREASURY), 'invalid_request');
    expectCode(() => buildZeroXQuoteQuery({ ...client, sellToken: ['a', 'b'] as unknown as string }, TREASURY), 'invalid_request');
  });

  it('verifies the real fee-bearing 0x quote (25 bps of gross, buy token, treasury in calldata)', () => {
    const quote = fx('zerox-quote-with-fee.json');
    const r = verifyZeroXQuoteFee(quote, { buyToken: USDC_BASE, feeRecipient: TREASURY });
    expect(r.feeAmount).toBe(quote.fees.integratorFee.amount);
    expect(r.feeToken).toBe(USDC_BASE.toLowerCase());
  });

  it('RED: a quote without the fee, at the wrong rate, in the wrong token, or paying elsewhere is refused', () => {
    const base = fx('zerox-quote-with-fee.json');
    const noFee = { ...base, fees: { ...base.fees, integratorFee: null, integratorFees: null } };
    expectCode(() => verifyZeroXQuoteFee(noFee, { buyToken: USDC_BASE, feeRecipient: TREASURY }), 'swap_fee_missing');

    const half = { ...base, fees: { ...base.fees, integratorFee: { ...base.fees.integratorFee, amount: String(BigInt(base.fees.integratorFee.amount) / 2n) } } };
    expectCode(() => verifyZeroXQuoteFee(half, { buyToken: USDC_BASE, feeRecipient: TREASURY }), 'swap_fee_wrong_rate');

    const wrongToken = { ...base, fees: { ...base.fees, integratorFee: { ...base.fees.integratorFee, token: ETH } } };
    expectCode(() => verifyZeroXQuoteFee(wrongToken, { buyToken: USDC_BASE, feeRecipient: TREASURY }), 'swap_fee_wrong_token');

    const elsewhere = { ...base, transaction: { ...base.transaction, data: base.transaction.data.toLowerCase().split(TREASURY.toLowerCase().slice(2)).join(ATTACKER.slice(2)) } };
    expectCode(() => verifyZeroXQuoteFee(elsewhere, { buyToken: USDC_BASE, feeRecipient: TREASURY }), 'swap_fee_wrong_recipient');

    expectCode(() => verifyZeroXQuoteFee({ ...base, liquidityAvailable: false }, { buyToken: USDC_BASE, feeRecipient: TREASURY }), 'no_liquidity');
  });
});

describe('LI.FI — cross-chain', () => {
  const client = {
    fromChain: '8453',
    toChain: String(LIFI_SOLANA_CHAIN_ID),
    fromToken: USDC_BASE,
    toToken: SOLANA_USDC_MINT,
    fromAmount: '20000000',
    fromAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    toAddress: USER_SOL,
    slippage: '0.005',
  };

  it('a client request with NO fee comes out fee-bearing under Provian\'s integrator', () => {
    const q = buildLifiQuoteQuery(client);
    expect(q.get('integrator')).toBe('provian');
    expect(q.get('fee')).toBe('0.0025');
  });

  it('client integrator/fee fields are overwritten, never honoured', () => {
    const q = buildLifiQuoteQuery({ ...client, integrator: 'evil', fee: '0', referrer: ATTACKER });
    expect(q.get('integrator')).toBe('provian');
    expect(q.get('fee')).toBe('0.0025');
    expect(q.has('referrer')).toBe(false);
  });

  it('every quote asks LI.FI only for the bridge the wallet decodes (Mayan Swift) and no DEX leg', () => {
    const sol = buildLifiQuoteQuery({ ...client, fromChain: String(LIFI_SOLANA_CHAIN_ID), toChain: '8453', allowBridges: 'near', allowExchanges: 'all' });
    expect(sol.get('allowBridges')).toBe('mayan');
    expect(sol.get('allowExchanges')).toBe('none');
    // EVM source too (round 2): the client can never widen either list.
    const evm = buildLifiQuoteQuery({ ...client, allowBridges: 'mayanFastMCTP,eco', allowExchanges: '1inch' });
    expect(evm.get('allowBridges')).toBe('mayan');
    expect(evm.get('allowExchanges')).toBe('none');
  });

  it('refuses same-chain requests (0x / Jupiter own those) and unknown chains', () => {
    expectCode(() => buildLifiQuoteQuery({ ...client, toChain: '8453' }), 'same_chain_not_lifi');
    expectCode(() => buildLifiQuoteQuery({ ...client, fromChain: '1' }), 'unsupported_chain');
    expectCode(() => buildLifiQuoteQuery({ ...client, fromAmount: '-5' }), 'invalid_request');
  });

  it('Base ⇄ Arbitrum ⇄ Optimism is a cross-chain route with the same forced fee and Mayan-only parameters; Ethereum mainnet stays refused', () => {
    const evmClient = { ...client, toChain: '42161', toToken: '0x0000000000000000000000000000000000000000', toAddress: client.fromAddress };
    for (const [from, to] of [['8453', '42161'], ['8453', '10'], ['42161', '8453'], ['42161', '10'], ['10', '8453'], ['10', '42161']]) {
      const q = buildLifiQuoteQuery({ ...evmClient, fromChain: from, toChain: to, integrator: 'evil', fee: '0', allowBridges: 'across', allowExchanges: 'all' });
      expect([q.get('fromChain'), q.get('toChain')]).toEqual([from, to]);
      expect(q.get('integrator')).toBe('provian');
      expect(q.get('fee')).toBe('0.0025');
      expect(q.get('allowBridges')).toBe('mayan');
      expect(q.get('allowExchanges')).toBe('none');
    }
    expectCode(() => buildLifiQuoteQuery({ ...evmClient, toChain: '1' }), 'unsupported_chain');
    expectCode(() => buildLifiQuoteQuery({ ...evmClient, fromChain: '1' }), 'unsupported_chain');
  });

  it('the relay\'s fee check accepts every live EVM → EVM quote (25 bps to provian, treasury pair in the calldata) and refuses one without the pair', () => {
    interface Capture { pair: string; extra: boolean; sourceChainId: number; request: Record<string, string>; quote?: LifiQuoteView & { transactionRequest: { data: string } } }
    const file = path.join(__dirname, '../../../../src/core/swap/__fixtures__/evm-evm-route-fixtures.json');
    const caps = (JSON.parse(fs.readFileSync(file, 'utf8')) as { captures: Capture[] }).captures.filter((c) => !c.extra && c.quote);
    expect(caps.length).toBe(24); // every direction × ETH/USDC in and out — never an empty population
    for (const c of caps) {
      const r = verifyLifiQuoteFee(c.quote!, { fromChain: c.sourceChainId, fromAmount: c.request.fromAmount, fromToken: c.request.fromToken });
      expect(BigInt(r.feeAmount)).toBe((BigInt(c.request.fromAmount) * 25n) / 10000n);
      // RED control: the same quote with the treasury pair removed from the calldata is refused.
      const stripped = { ...c.quote!, transactionRequest: { ...c.quote!.transactionRequest, data: c.quote!.transactionRequest.data.toLowerCase().split('086e0f377af1245b8888540f39e99a42a7daf1da').join('00000000000000000000000000000000000dead0') } };
      expectCode(() => verifyLifiQuoteFee(stripped, { fromChain: c.sourceChainId, fromAmount: c.request.fromAmount, fromToken: c.request.fromToken }), 'swap_fee_wrong_recipient');
    }
  });

  it('verifies the real EVM-source quote: 25 bps to provian, LI.FI\'s own fee to lifi, treasury in calldata', () => {
    const quote = fx('lifi-quote-base-usdc-to-solana.json');
    const r = verifyLifiQuoteFee(quote, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE });
    expect(r.feeAmount).toBe('50000'); // 25 bps of 20 USDC
    expect(r.lifiFeeAmount).toBe('50000'); // LI.FI's own fixed 25 bps, separate from ours
  });

  const decode = (q: { transactionRequest: { data: string } }): DecodedSolanaTx =>
    decodeSolanaTransaction(Buffer.from(q.transactionRequest.data, 'base64'));

  it('verifies the real USDC Solana-source quote: a TransferChecked of exactly the fee to the treasury USDC account', () => {
    const quote = fx('lifi-quote-solana-usdc-to-base.json');
    const r = verifyLifiQuoteFee(quote, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_USDC_MINT, solanaTx: decode(quote) });
    expect(r.feeAmount).toBe('50000');
  });

  it('verifies the real native-SOL Solana-source quote: a System transfer of exactly the fee to the Solana treasury', () => {
    const quote = fx('lifi-quote-solana-sol-to-base.json');
    const r = verifyLifiQuoteFee(quote, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '1000000000', fromToken: '11111111111111111111111111111111', solanaTx: decode(quote) });
    expect(r.feeAmount).toBe('2500000'); // 25 bps of 1 SOL
  });

  it('an empty Solana treasury: LI.FI raises its fee transfer to the rent-exempt minimum; the excess is the treasury deposit', () => {
    // Real quote, 0.1 SOL: provian's fee is 250,000 lamports but the treasury address held 0 SOL,
    // so LI.FI transfers 650,240 (the 0-byte rent-exempt minimum) — mainnet simulation: the
    // treasury ends at exactly 650,240.
    const quote = fx('lifi-quote-solana-sol-to-base-small.json');
    const base = { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '100000000', fromToken: '11111111111111111111111111111111', solanaTx: decode(quote) };
    const r = verifyLifiQuoteFee(quote, { ...base, emptyTreasuryMinimum: 650240n });
    expect(r).toMatchObject({ feeAmount: '250000', treasuryDepositLamports: '400240' });
    // A funded treasury gets exactly the fee (the 1 SOL fixture): no deposit.
    const big = fx('lifi-quote-solana-sol-to-base.json');
    expect(verifyLifiQuoteFee(big, { ...base, fromAmount: '1000000000', solanaTx: decode(big) }).treasuryDepositLamports).toBe('0');
  });

  it('RED: the top-up is accepted only when the relay saw an empty treasury, and only at exactly the minimum', () => {
    const quote = fx('lifi-quote-solana-sol-to-base-small.json');
    const base = { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '100000000', fromToken: '11111111111111111111111111111111', solanaTx: decode(quote) };
    expectCode(() => verifyLifiQuoteFee(quote, base), 'swap_fee_wrong_recipient'); // treasury not empty: exact fee only
    expectCode(() => verifyLifiQuoteFee(quote, { ...base, emptyTreasuryMinimum: 700000n }), 'swap_fee_wrong_recipient');
    expectCode(() => verifyLifiQuoteFee(quote, { ...base, emptyTreasuryMinimum: 200000n }), 'swap_fee_wrong_recipient'); // below the fee
  });

  it('RED: the treasury present in the tx but the fee transfer sent elsewhere is refused', () => {
    const quote = fx('lifi-quote-solana-usdc-to-base.json');
    const tx = decode(quote);
    expect(tx.staticKeys).toContain(PROVIAN_SOLANA_TREASURY); // still present (ATA-create owner arg)
    const feeIdx = tx.staticKeys.indexOf(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    const payIx = tx.instructions.findIndex((ix) => ix.data[0] === 12 && ix.accounts[2] === feeIdx);
    expect(payIx).toBeGreaterThan(-1);
    // (a) fee TransferChecked redirected to another writable token account
    const otherIdx = tx.instructions.find((ix, i) => i !== payIx && ix.data[0] === 12)!.accounts[2];
    const redirected: DecodedSolanaTx = {
      ...tx,
      instructions: tx.instructions.map((ix, i) => (i === payIx ? { ...ix, accounts: [ix.accounts[0], ix.accounts[1], otherIdx, ix.accounts[3]] } : ix)),
    };
    expectCode(() => verifyLifiQuoteFee(quote, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_USDC_MINT, solanaTx: redirected }), 'swap_fee_wrong_recipient');
    // (b) fee transfer removed entirely
    const removed: DecodedSolanaTx = { ...tx, instructions: tx.instructions.filter((_, i) => i !== payIx) };
    expectCode(() => verifyLifiQuoteFee(quote, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_USDC_MINT, solanaTx: removed }), 'swap_fee_wrong_recipient');
    // (c) fee transfer of a smaller amount
    const shortData = Uint8Array.from(tx.instructions[payIx].data);
    shortData[1] = 1; shortData[2] = 0; shortData[3] = 0;
    const short: DecodedSolanaTx = { ...tx, instructions: tx.instructions.map((ix, i) => (i === payIx ? { ...ix, data: shortData } : ix)) };
    expectCode(() => verifyLifiQuoteFee(quote, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_USDC_MINT, solanaTx: short }), 'swap_fee_wrong_recipient');
    // (d) native-SOL fee sent to a different wallet
    const nq = fx('lifi-quote-solana-sol-to-base.json');
    const ntx = decode(nq);
    const sysIdx = ntx.staticKeys.indexOf(PROVIAN_SOLANA_TREASURY);
    const pay = ntx.instructions.findIndex((ix) => ix.accounts[1] === sysIdx);
    const nredir: DecodedSolanaTx = { ...ntx, instructions: ntx.instructions.map((ix, i) => (i === pay ? { ...ix, accounts: [ix.accounts[0], 0] } : ix)) };
    expectCode(() => verifyLifiQuoteFee(nq, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '1000000000', fromToken: '11111111111111111111111111111111', solanaTx: nredir }), 'swap_fee_wrong_recipient');
    // (e) a Solana source token other than SOL/USDC is refused
    expectCode(() => verifyLifiQuoteFee(quote, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_WSOL_MINT, solanaTx: tx }), 'unsupported_solana_source');
  });

  it('RED (round 2): a native-SOL fee transfer of the wrong amount is refused', () => {
    const nq = fx('lifi-quote-solana-sol-to-base.json');
    const ntx = decode(nq);
    const sysIdx = ntx.staticKeys.indexOf(PROVIAN_SOLANA_TREASURY);
    const pay = ntx.instructions.findIndex((ix) => ix.accounts[1] === sysIdx);
    expect(pay).toBeGreaterThan(-1);
    const one = Uint8Array.from(ntx.instructions[pay].data);
    one.fill(0, 4, 12);
    one[4] = 1; // 1 lamport instead of 2,500,000
    const short: DecodedSolanaTx = { ...ntx, instructions: ntx.instructions.map((ix, i) => (i === pay ? { ...ix, data: one } : ix)) };
    expectCode(() => verifyLifiQuoteFee(nq, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '1000000000', fromToken: '11111111111111111111111111111111', solanaTx: short }), 'swap_fee_wrong_recipient');
    expect(findSolanaFeeTransfer(ntx, { kind: 'system', destination: PROVIAN_SOLANA_TREASURY, amount: 2500000n })).toBe(true);
    expect(findSolanaFeeTransfer(ntx, { kind: 'system', destination: PROVIAN_SOLANA_TREASURY, amount: 2499999n })).toBe(false);
  });

  it('SPL Transfer (discriminator 3): accepted only for exactly the fee to the treasury USDC account', () => {
    const quote = fx('lifi-quote-solana-usdc-to-base.json');
    const tx = decode(quote);
    const feeIdx = tx.staticKeys.indexOf(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    const payIx = tx.instructions.findIndex((ix) => ix.data[0] === 12 && ix.accounts[2] === feeIdx);
    const otherIdx = tx.instructions.find((ix, i) => i !== payIx && ix.data[0] === 12)!.accounts[2];
    // Re-encode the fee TransferChecked [src, mint, dst, auth] as a plain Transfer [src, dst, auth].
    const asTransfer = (amount: bigint, dst: number): DecodedSolanaTx => {
      const data = new Uint8Array(9);
      data[0] = 3;
      let a = amount;
      for (let i = 1; i <= 8; i++) { data[i] = Number(a & 0xffn); a >>= 8n; }
      const ix = tx.instructions[payIx];
      return { ...tx, instructions: tx.instructions.map((x, i) => (i === payIx ? { ...x, accounts: [ix.accounts[0], dst, ix.accounts[3]], data } : x)) };
    };
    const args = { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_USDC_MINT };
    expect(verifyLifiQuoteFee(quote, { ...args, solanaTx: asTransfer(50000n, feeIdx) }).feeAmount).toBe('50000');
    // RED: wrong amount; RED: right amount to another account (E8WkRW… still a writable key elsewhere)
    expectCode(() => verifyLifiQuoteFee(quote, { ...args, solanaTx: asTransfer(1n, feeIdx) }), 'swap_fee_wrong_recipient');
    const redirected = asTransfer(50000n, otherIdx);
    expect(redirected.staticKeys).toContain(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    expectCode(() => verifyLifiQuoteFee(quote, { ...args, solanaTx: redirected }), 'swap_fee_wrong_recipient');
  });

  it('verifies the real native-ETH EVM-source quote (FeeForwarder pair for a native amount)', () => {
    const quote = fx('lifi-quote-base-eth-to-solana.json');
    const r = verifyLifiQuoteFee(quote, { fromChain: 8453, fromAmount: '10000000000000000', fromToken: '0x0000000000000000000000000000000000000000' });
    expect(r.feeAmount).toBe('25000000000000'); // 25 bps of 0.01 ETH
    expect(r.lifiFeeAmount).toBe('25000000000000');
  });

  it('findSolanaFeeTransfer: exact amount and destination, or nothing', () => {
    const tx = decode(fx('lifi-quote-solana-usdc-to-base.json'));
    expect(findSolanaFeeTransfer(tx, { kind: 'spl', destination: PROVIAN_SOLANA_USDC_FEE_ACCOUNT, amount: 50000n })).toBe(true);
    expect(findSolanaFeeTransfer(tx, { kind: 'spl', destination: PROVIAN_SOLANA_USDC_FEE_ACCOUNT, amount: 49999n })).toBe(false);
    expect(findSolanaFeeTransfer(tx, { kind: 'system', destination: PROVIAN_SOLANA_USDC_FEE_ACCOUNT, amount: 50000n })).toBe(false);
    // the treasury itself is a READ-ONLY key here (ATA owner arg) — never a fee destination
    expect(findSolanaFeeTransfer(tx, { kind: 'spl', destination: PROVIAN_SOLANA_TREASURY, amount: 50000n })).toBe(false);
  });

  it('RED: EVM calldata naming the treasury but with a different fee amount is refused', () => {
    const q = JSON.parse(JSON.stringify(fx('lifi-quote-base-usdc-to-solana.json')));
    const pair = '0'.repeat(24) + TREASURY.toLowerCase().slice(2) + (50000).toString(16).padStart(64, '0');
    expect(q.transactionRequest.data.toLowerCase()).toContain(pair);
    q.transactionRequest.data = q.transactionRequest.data.toLowerCase().replace(pair, '0'.repeat(24) + TREASURY.toLowerCase().slice(2) + (1).toString(16).padStart(64, '0'));
    expectCode(() => verifyLifiQuoteFee(q, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE }), 'swap_fee_wrong_recipient');
  });

  it('RED: no fee, a foreign split recipient, the wrong rate, or calldata not paying the treasury is refused', () => {
    const base = fx('lifi-quote-base-usdc-to-solana.json');
    const clone = () => JSON.parse(JSON.stringify(base));

    const noFee = clone();
    noFee.estimate.feeCosts[0].feeSplit = { lifiFee: '50000', integratorFee: '0', recipients: [{ name: 'lifi', fee: '50000' }] };
    expectCode(() => verifyLifiQuoteFee(noFee, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE }), 'swap_fee_missing');

    const foreign = clone();
    foreign.estimate.feeCosts[0].feeSplit.recipients.push({ name: 'someone', fee: '1' });
    expectCode(() => verifyLifiQuoteFee(foreign, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE }), 'swap_fee_foreign_recipient');

    const wrongRate = clone();
    wrongRate.estimate.feeCosts[0].feeSplit.integratorFee = '20000';
    wrongRate.estimate.feeCosts[0].feeSplit.recipients[1].fee = '20000';
    expectCode(() => verifyLifiQuoteFee(wrongRate, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE }), 'swap_fee_wrong_rate');

    const misassigned = clone();
    misassigned.estimate.feeCosts[0].feeSplit.recipients = [{ name: 'lifi', fee: '100000' }];
    expectCode(() => verifyLifiQuoteFee(misassigned, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE }), 'swap_fee_wrong_recipient');

    const elsewhere = clone();
    elsewhere.transactionRequest.data = elsewhere.transactionRequest.data.toLowerCase().split(TREASURY.toLowerCase().slice(2)).join(ATTACKER.slice(2));
    expectCode(() => verifyLifiQuoteFee(elsewhere, { fromChain: 8453, fromAmount: '20000000', fromToken: USDC_BASE }), 'swap_fee_wrong_recipient');

    const sol = fx('lifi-quote-solana-usdc-to-base.json');
    expectCode(
      () => verifyLifiQuoteFee(sol, { fromChain: LIFI_SOLANA_CHAIN_ID, fromAmount: '20000000', fromToken: SOLANA_USDC_MINT }),
      'lifi_tx_missing',
    );
  });
});

describe('Jupiter — same-chain Solana', () => {
  const order = { inputMint: SOLANA_WSOL_MINT, outputMint: SOLANA_USDC_MINT, amount: '100000000', slippageBps: 50, userPublicKey: USER_SOL };
  const mintInfo = (program: string, extensions: string[] = []): SolanaMintInfo => ({ program, extensions, defaultFrozen: false });
  const classic = (...mints: string[]) => Object.fromEntries(mints.map((m) => [m, mintInfo(SOLANA_TOKEN_PROGRAM_ID)]));
  /** Mint info as the relay reads it: the real jsonParsed PYUSD / USDG / BONK mint accounts. */
  const realMints = (): Record<string, SolanaMintInfo> => {
    const raw = fx('solana-mints-pyusd-usdg-bonk.json') as Array<{ owner: string; data: { parsed: { info: { extensions?: Array<{ extension: string }> } } } }>;
    const [py, ug, bonk] = raw.map((a) => mintInfo(a.owner, (a.data.parsed.info.extensions ?? []).map((e) => e.extension)));
    return { [PYUSD]: py, [USDG]: ug, [BONK]: bonk };
  };

  it('any two different Solana mints, positive amounts, bounded slippage', () => {
    expect(parseJupiterOrderRequest(order)).toEqual(order);
    expect(parseJupiterOrderRequest({ ...order, inputMint: BONK, outputMint: JUP })).toEqual({ ...order, inputMint: BONK, outputMint: JUP });
    expectCode(() => parseJupiterOrderRequest({ ...order, outputMint: SOLANA_WSOL_MINT }), 'unsupported_pair');
    expectCode(() => parseJupiterOrderRequest({ ...order, outputMint: '0xabc' }), 'unsupported_pair');
    expectCode(() => parseJupiterOrderRequest({ ...order, outputMint: '1111' }), 'unsupported_pair');
    expectCode(() => parseJupiterOrderRequest({ ...order, amount: '0' }), 'invalid_request');
    expectCode(() => parseJupiterOrderRequest({ ...order, slippageBps: 9000 }), 'invalid_request');
    expectCode(() => parseJupiterOrderRequest({ ...order, userPublicKey: '0xabc' }), 'invalid_request');
  });

  it('associatedTokenAddress matches @solana/web3.js findProgramAddressSync, including low bumps', () => {
    // [owner, mint, ATA, bump] computed with @solana/web3.js 1.98 on 2026-09-25. Bumps below 255 only
    // derive correctly when every on-curve candidate above them is skipped, so these vectors fail
    // if isOnEd25519Curve ever answers "off curve" for a point that is on it (RED control).
    const vectors: Array<[string, string, string, number]> = [
      [PROVIAN_SOLANA_TREASURY, SOLANA_USDC_MINT, 'E8WkRWFrrpJH2nvVDB3jTnLrRJQqpCT8qftV4vU7QQkB', 253],
      [PROVIAN_SOLANA_TREASURY, SOLANA_WSOL_MINT, 'Fs42KbAkah3agwXi57LTEeNL1FncDZg3JEce4yJ9eAjd', 254],
      [PROVIAN_SOLANA_TREASURY, BONK, '7L2gemgzqeMTYvkVFeBQD2m3iwmA3zzseAwjPB57W9ZF', 254],
      [PROVIAN_SOLANA_TREASURY, JUP, '2gPM8dFTCNb8ZaiD5YPLymyMQphaqLwhgWpnCpjycv4M', 255],
      [PROVIAN_SOLANA_TREASURY, '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', 'CQ86yQ8qkWKjdExYk1bye1bKpvSYT7a3rywuU2yAqd1Q', 249],
      [USER_SOL, SOLANA_WSOL_MINT, '8LjUgMjzZuHj8VdyxzkmLLQVmW4C3gd56md1nLd76TNW', 255],
      [USER_SOL, BONK, '5hpfC9VBxVcoW9opCnM2PqR6YWRLBzrBpabJTZnwwNiw', 254],
      ['DtztybUJ3MAnSyNw24Ab2cEGfzPXcSsLtQ6MKZHPEtqM', SOLANA_USDC_MINT, '2SzK2C3o3QwrM8xXAmYKimsXyejPPuJVFRA6s8BV4BHb', 252],
      ['EDtvqjJt6vSDcz2gbK6WdRzFsg28wPeSdjkjKguRp7YL', SOLANA_USDC_MINT, '572P64SDSED4dG9v6xT9sPLPELMahUouhccrfE4yvJw1', 250],
    ];
    for (const [owner, mint, ata] of vectors) {
      expect(associatedTokenAddress(owner, mint)).toBe(ata);
      expect(isOnEd25519Curve(base58Decode32(ata))).toBe(false); // a PDA is off the curve
    }
    expect(vectors.filter((v) => v[3] < 255).length).toBeGreaterThanOrEqual(6);
    // Token-2022: the same PDA with the Token-2022 program as the middle seed.
    expect(associatedTokenAddress(PROVIAN_SOLANA_TREASURY, PYUSD, SOLANA_TOKEN_2022_PROGRAM_ID)).toBe(TREASURY_PYUSD);
    expect(associatedTokenAddress(PROVIAN_SOLANA_TREASURY, PYUSD)).not.toBe(TREASURY_PYUSD);
    // Wallet addresses are ed25519 public keys: on the curve (the other half of the control).
    for (const k of [PROVIAN_SOLANA_TREASURY, USER_SOL, 'DtztybUJ3MAnSyNw24Ab2cEGfzPXcSsLtQ6MKZHPEtqM']) {
      expect(isOnEd25519Curve(base58Decode32(k))).toBe(true);
    }
  });

  it('fee mint: USDC, else SOL, else the input, else the output — any SPL mint, into the treasury account', () => {
    const TK = SOLANA_TOKEN_PROGRAM_ID;
    expect(planJupiterFee(order, classic(SOLANA_WSOL_MINT, SOLANA_USDC_MINT)))
      .toEqual({ feeMint: SOLANA_USDC_MINT, feeAccount: PROVIAN_SOLANA_USDC_FEE_ACCOUNT, tokenProgram: TK });
    expect(planJupiterFee({ ...order, inputMint: BONK, outputMint: SOLANA_USDC_MINT }, classic(BONK, SOLANA_USDC_MINT)).feeMint).toBe(SOLANA_USDC_MINT);
    expect(planJupiterFee({ ...order, inputMint: SOLANA_WSOL_MINT, outputMint: BONK }, classic(SOLANA_WSOL_MINT, BONK)))
      .toEqual({ feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_WSOL, tokenProgram: TK });
    expect(planJupiterFee({ ...order, inputMint: JUP, outputMint: SOLANA_WSOL_MINT }, classic(JUP, SOLANA_WSOL_MINT)).feeMint).toBe(SOLANA_WSOL_MINT);
    expect(planJupiterFee({ ...order, inputMint: BONK, outputMint: JUP }, classic(BONK, JUP)))
      .toEqual({ feeMint: BONK, feeAccount: TREASURY_BONK, tokenProgram: TK });
    // Token-2022 : the order is unchanged — a Token-2022 input takes the fee,
    // into the treasury's Token-2022 account (derived with the Token-2022 program).
    const m = realMints();
    expect(planJupiterFee({ ...order, inputMint: PYUSD, outputMint: USDG }, m))
      .toEqual({ feeMint: PYUSD, feeAccount: TREASURY_PYUSD, tokenProgram: SOLANA_TOKEN_2022_PROGRAM_ID });
    expect(planJupiterFee({ ...order, inputMint: PYUSD, outputMint: BONK }, m).feeMint).toBe(PYUSD);
    expect(planJupiterFee({ ...order, inputMint: BONK, outputMint: PYUSD }, m).feeMint).toBe(BONK);
    // A skipped candidate (its new treasury account would be frozen) moves to the next in order.
    expect(planJupiterFee({ ...order, inputMint: PYUSD, outputMint: USDG }, m, new Set([PYUSD])).feeMint).toBe(USDG);
  });

  it('RED: a mint no SPL token program owns is refused; with every candidate skipped, the pair is refused', () => {
    const m = realMints();
    expectCode(() => planJupiterFee({ ...order, inputMint: BONK, outputMint: JUP }, { [BONK]: mintInfo(SOLANA_TOKEN_PROGRAM_ID), [JUP]: mintInfo('11111111111111111111111111111111') }), 'unsupported_mint');
    expectCode(() => planJupiterFee({ ...order, inputMint: BONK, outputMint: JUP }, { [BONK]: mintInfo(SOLANA_TOKEN_PROGRAM_ID) }), 'unsupported_mint');
    expectCode(() => planJupiterFee({ ...order, inputMint: PYUSD, outputMint: USDG }, m, new Set([PYUSD, USDG])), 'unsupported_pair');
  });

  it('Token-2022 account size from the mint extensions: PYUSD = 187 bytes, as created on mainnet', () => {
    const m = realMints();
    expect(tokenAccountSize(m[BONK])).toBe(165);
    // 165 base + 1 type + ImmutableOwner (4) + TransferFeeAmount (4+8) + TransferHookAccount (4+1)
    expect(tokenAccountSize(m[PYUSD])).toBe(187);
    expect(tokenAccountSize(m[USDG])).toBe(187);
    expect(tokenAccountSize(mintInfo(SOLANA_TOKEN_2022_PROGRAM_ID))).toBe(170);
    expect(tokenAccountSize(mintInfo(SOLANA_TOKEN_2022_PROGRAM_ID, ['nonTransferable', 'pausableConfig', 'metadataPointer']))).toBe(178);
  });

  it('RED: an unrecognised Token-2022 extension or a non-token program is refused rather than sized', () => {
    expectCode(() => tokenAccountSize(mintInfo(SOLANA_TOKEN_2022_PROGRAM_ID, ['someFutureExtension'])), 'unsupported_mint');
    expectCode(() => tokenAccountSize(mintInfo(SOLANA_TOKEN_2022_PROGRAM_ID, ['unparseableExtension'])), 'unsupported_mint');
    // An inherited property name is not a known extension (own keys only).
    expectCode(() => tokenAccountSize(mintInfo(SOLANA_TOKEN_2022_PROGRAM_ID, ['toString'])), 'unsupported_mint');
    expectCode(() => tokenAccountSize(mintInfo('11111111111111111111111111111111')), 'unsupported_mint');
  });

  it('a Token-2022 fee account asks Jupiter for the V2 route instruction; a classic one does not', () => {
    const m = realMints();
    const t22Order = { ...order, inputMint: PYUSD, outputMint: USDG };
    expect(buildJupiterQuoteQuery(t22Order, planJupiterFee(t22Order, m)).get('instructionVersion')).toBe('V2');
    expect(buildJupiterQuoteQuery(order, planJupiterFee(order, classic(SOLANA_WSOL_MINT, SOLANA_USDC_MINT))).has('instructionVersion')).toBe(false);
    // The real Token-2022 order: the fee is 25 bps of the input, into the treasury PYUSD account.
    const q = fx('jupiter-quote-pyusd-to-usdg.json');
    expect(verifyJupiterQuote(q, { ...t22Order, amount: q.inAmount }, PYUSD)).toEqual({ feeAmount: '25000', feeSide: 'input' });
    expect(() => verifyJupiterTransaction(fx('jupiter-swap-pyusd-to-usdg.json').swapTransaction, PY_HOLDER, TREASURY_PYUSD)).not.toThrow();
  });

  it('a client order carrying platformFeeBps=0 / its own feeAccount still quotes and swaps at 25 bps to the treasury account', () => {
    const parsed = parseJupiterOrderRequest({ ...order, platformFeeBps: 0, feeAccount: USER_SOL } as Record<string, unknown>);
    const plan = planJupiterFee(parsed, classic(SOLANA_WSOL_MINT, SOLANA_USDC_MINT));
    const q = buildJupiterQuoteQuery(parsed, plan);
    expect(q.get('platformFeeBps')).toBe('25');
    expect(q.get('swapMode')).toBe('ExactIn');
    expect([...q.keys()].sort()).toEqual(['amount', 'inputMint', 'outputMint', 'platformFeeBps', 'slippageBps', 'swapMode']);
    const body = buildJupiterSwapBody({ some: 'quote' }, parsed.userPublicKey, plan.feeAccount);
    expect(body.feeAccount).toBe(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
  });

  it('fee on the output side is exactly platformFee.amount; on the input side floor(in × 25 / 10 000)', () => {
    const quote = fx('jupiter-quote-sol-to-usdc.json');
    expect(verifyJupiterQuote(quote, order, SOLANA_USDC_MINT)).toEqual({ feeAmount: quote.platformFee.amount, feeSide: 'output' });
    const u2s = { ...order, inputMint: SOLANA_USDC_MINT, outputMint: SOLANA_WSOL_MINT, amount: '20000000' };
    const q2 = { inputMint: SOLANA_USDC_MINT, outputMint: SOLANA_WSOL_MINT, inAmount: '20000000', outAmount: '165065524', swapMode: 'ExactIn', platformFee: { amount: '413698', feeBps: 25 } };
    expect(verifyJupiterQuote(q2, u2s, SOLANA_USDC_MINT)).toEqual({ feeAmount: '50000', feeSide: 'input' });
    // Non-USDC pairs (real quotes): SOL→BONK and BONK→JUP take it from the input, JUP→SOL from the output.
    const sb = fx('jupiter-quote-sol-to-bonk.json');
    expect(verifyJupiterQuote(sb, { ...order, inputMint: SOLANA_WSOL_MINT, outputMint: BONK, amount: sb.inAmount }, SOLANA_WSOL_MINT))
      .toEqual({ feeAmount: '250000', feeSide: 'input' });
    const bj = fx('jupiter-quote-bonk-to-jup.json');
    expect(verifyJupiterQuote(bj, { ...order, inputMint: BONK, outputMint: JUP, amount: bj.inAmount }, BONK))
      .toEqual({ feeAmount: '12500000000', feeSide: 'input' });
    const js = fx('jupiter-quote-jup-to-sol.json');
    expect(verifyJupiterQuote(js, { ...order, inputMint: JUP, outputMint: SOLANA_WSOL_MINT, amount: js.inAmount }, SOLANA_WSOL_MINT))
      .toEqual({ feeAmount: js.platformFee.amount, feeSide: 'output' });
  });

  it('RED: a quote without the 25 bps fee, not matching the order, or a fee mint outside the pair, is refused', () => {
    const quote = fx('jupiter-quote-sol-to-usdc.json');
    expectCode(() => verifyJupiterQuote({ ...quote, platformFee: null }, order, SOLANA_USDC_MINT), 'swap_fee_missing');
    expectCode(() => verifyJupiterQuote({ ...quote, platformFee: { amount: '1', feeBps: 0 } }, order, SOLANA_USDC_MINT), 'swap_fee_missing');
    expectCode(() => verifyJupiterQuote({ ...quote, inAmount: '1' }, order, SOLANA_USDC_MINT), 'jupiter_quote_mismatch');
    expectCode(() => verifyJupiterQuote({ ...quote, swapMode: 'ExactOut' }, order, SOLANA_USDC_MINT), 'jupiter_quote_mismatch');
    expectCode(() => verifyJupiterQuote(quote, order, BONK), 'swap_fee_wrong_recipient');
  });

  it('verifies real Jupiter transactions: user pays, fee account is a writable key of the Jupiter instruction', () => {
    const cases: Array<[string, string]> = [
      ['jupiter-swap-sol-to-usdc.json', PROVIAN_SOLANA_USDC_FEE_ACCOUNT],
      ['jupiter-swap-usdc-to-sol.json', PROVIAN_SOLANA_USDC_FEE_ACCOUNT],
      ['jupiter-swap-sol-to-bonk.json', TREASURY_WSOL],
      ['jupiter-swap-bonk-to-jup.json', TREASURY_BONK],
      ['jupiter-swap-jup-to-sol.json', TREASURY_WSOL],
    ];
    for (const [f, feeAccount] of cases) {
      const { swapTransaction } = fx(f);
      expect(() => verifyJupiterTransaction(swapTransaction, USER_SOL, feeAccount)).not.toThrow();
      // Round-trip: the encoder reproduces Jupiter's bytes exactly (unsigned: blank signatures).
      const raw = Buffer.from(swapTransaction, 'base64');
      expect(Buffer.from(encodeSolanaTransaction(decodeSolanaTransaction(raw))).equals(raw)).toBe(true);
    }
  });

  it('RED: a transaction paying a different fee account, or paid by someone else, is refused', () => {
    const { swapTransaction } = fx('jupiter-swap-sol-to-usdc.json');
    expectCode(() => verifyJupiterTransaction(swapTransaction, PROVIAN_SOLANA_TREASURY, PROVIAN_SOLANA_USDC_FEE_ACCOUNT), 'jupiter_tx_wrong_payer');
    expectCode(() => verifyJupiterTransaction(swapTransaction, USER_SOL, TREASURY_WSOL), 'swap_fee_wrong_recipient');
    // Rewrite the fee-account key bytes to a different 32-byte key: the fee now goes elsewhere.
    const raw = Buffer.from(swapTransaction, 'base64');
    const tx = decodeSolanaTransaction(raw);
    const hex = raw.toString('hex');
    const feeHex = Buffer.from(base58DecodeForTest(PROVIAN_SOLANA_USDC_FEE_ACCOUNT)).toString('hex');
    expect(hex).toContain(feeHex);
    const swapped = Buffer.from(hex.replace(feeHex, 'ab'.repeat(32)), 'hex').toString('base64');
    expect(decodeSolanaTransaction(Buffer.from(swapped, 'base64')).staticKeys).not.toContain(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    expectCode(() => verifyJupiterTransaction(swapped, USER_SOL, PROVIAN_SOLANA_USDC_FEE_ACCOUNT), 'swap_fee_wrong_recipient');
    expect(tx.staticKeys[0]).toBe(USER_SOL);
    expectCode(() => verifyJupiterTransaction('bm90IGEgdHg=', USER_SOL, PROVIAN_SOLANA_USDC_FEE_ACCOUNT), 'jupiter_tx_malformed');
  });

  describe('creating the treasury fee account inside the swap', () => {
    const TK = SOLANA_TOKEN_PROGRAM_ID;
    const cases: Array<[string, string, string, string, string]> = [
      ['sol-to-bonk', SOLANA_WSOL_MINT, TREASURY_WSOL, TK, USER_SOL],
      ['bonk-to-jup', BONK, TREASURY_BONK, TK, USER_SOL],
      ['jup-to-sol', SOLANA_WSOL_MINT, TREASURY_WSOL, TK, USER_SOL],
      ['pyusd-to-usdg', PYUSD, TREASURY_PYUSD, SOLANA_TOKEN_2022_PROGRAM_ID, PY_HOLDER],
    ];
    const tablesOf = (name: string): Record<string, string[]> => {
      const alts = fx(`jupiter-alts-${name}.json`) as Record<string, { owner: string; data: string }>;
      return Object.fromEntries(Object.entries(alts).map(([k, v]) => [k, parseLookupTableAddresses(v.owner, v.data)]));
    };
    /** Every account of every instruction, as keys (static or loaded through a table). */
    const resolved = (tx: DecodedSolanaTx, tables: Record<string, string[]>) => {
      const all = [...tx.staticKeys];
      for (const kind of ['w', 'r'] as const) {
        for (const l of tx.lookups) for (const i of kind === 'w' ? l.writableIndexes : l.readonlyIndexes) all.push(tables[l.tableKey][i]);
      }
      return {
        all,
        ixs: tx.instructions.map((ix) => ({ program: all[ix.programIdIndex], accounts: ix.accounts.map((a) => all[a]), data: Buffer.from(ix.data).toString('hex') })),
      };
    };

    it.each(cases)('%s: a CreateIdempotent of the treasury account is prepended; every original instruction is unchanged', (name, feeMint, feeAccount, tokenProgram, user) => {
      const { swapTransaction } = fx(`jupiter-swap-${name}.json`);
      const tables = tablesOf(name);
      const before = decodeSolanaTransaction(Buffer.from(swapTransaction, 'base64'));
      expect(before.lookups.length).toBeGreaterThan(0); // exercises the loaded-key index shift
      const out = addFeeAccountCreation(swapTransaction, tables, { userPublicKey: user, feeMint, feeAccount, tokenProgram });
      const after = decodeSolanaTransaction(Buffer.from(out, 'base64'));
      const appended = after.staticKeys.length - before.staticKeys.length;
      expect(appended).toBeGreaterThan(0); // the treasury is never already a key: the shift is real
      expect(after.header.numReadonlyUnsigned).toBe(before.header.numReadonlyUnsigned + appended);
      expect(after.lookups).toEqual(before.lookups);
      expect(Buffer.from(out, 'base64').length).toBeLessThanOrEqual(SOLANA_MAX_TX_BYTES);

      const b = resolved(before, tables);
      const a = resolved(after, tables);
      expect(a.ixs[0]).toEqual({
        program: SOLANA_ATA_PROGRAM_ID,
        accounts: [user, feeAccount, PROVIAN_SOLANA_TREASURY, feeMint, '11111111111111111111111111111111', tokenProgram],
        data: '01',
      });
      expect(a.ixs.slice(1)).toEqual(b.ixs);
      // Every account keeps its writability; the new keys are read-only.
      for (let i = 0; i < b.all.length; i++) {
        const j = a.all.indexOf(b.all[i]);
        expect(after.isWritable(j)).toBe(before.isWritable(i));
      }
      for (const k of after.staticKeys.slice(before.staticKeys.length)) expect(after.isWritable(a.all.indexOf(k))).toBe(false);
      expect(new Set(a.all).size).toBe(a.all.length); // no key loaded twice
      expect(() => verifyJupiterTransaction(out, user, feeAccount)).not.toThrow();
    });

    it('RED: a fee account that is not the treasury account for the fee mint is refused', () => {
      const { swapTransaction } = fx('jupiter-swap-sol-to-bonk.json');
      const tables = tablesOf('sol-to-bonk');
      const TK = SOLANA_TOKEN_PROGRAM_ID;
      expectCode(() => addFeeAccountCreation(swapTransaction, tables, { userPublicKey: USER_SOL, feeMint: BONK, feeAccount: TREASURY_WSOL, tokenProgram: TK }), 'swap_fee_wrong_recipient');
      expectCode(() => addFeeAccountCreation(swapTransaction, tables, { userPublicKey: USER_SOL, feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_BONK, tokenProgram: TK }), 'swap_fee_wrong_recipient');
      expectCode(() => addFeeAccountCreation(swapTransaction, tables, { userPublicKey: PROVIAN_SOLANA_TREASURY, feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_WSOL, tokenProgram: TK }), 'jupiter_tx_wrong_payer');
      // The fee account is derived under the fee mint's own program: the wrong program is refused.
      expectCode(() => addFeeAccountCreation(swapTransaction, tables, { userPublicKey: USER_SOL, feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_WSOL, tokenProgram: SOLANA_TOKEN_2022_PROGRAM_ID }), 'swap_fee_wrong_recipient');
      expectCode(() => addFeeAccountCreation(swapTransaction, tables, { userPublicKey: USER_SOL, feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_WSOL, tokenProgram: '11111111111111111111111111111111' }), 'swap_fee_wrong_recipient');
      const py = fx('jupiter-swap-pyusd-to-usdg.json').swapTransaction;
      expectCode(() => addFeeAccountCreation(py, tablesOf('pyusd-to-usdg'), { userPublicKey: PY_HOLDER, feeMint: PYUSD, feeAccount: TREASURY_PYUSD, tokenProgram: TK }), 'swap_fee_wrong_recipient');
    });

    it('RED: missing or foreign lookup tables, and a transaction with no room, are refused', () => {
      const { swapTransaction } = fx('jupiter-swap-sol-to-bonk.json');
      const args = { userPublicKey: USER_SOL, feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_WSOL, tokenProgram: SOLANA_TOKEN_PROGRAM_ID };
      expectCode(() => addFeeAccountCreation(swapTransaction, {}, args), 'jupiter_tx_malformed');
      const alts = fx('jupiter-alts-sol-to-bonk.json') as Record<string, { owner: string; data: string }>;
      const [k, v] = Object.entries(alts)[0];
      expectCode(() => parseLookupTableAddresses(SOLANA_TOKEN_PROGRAM_ID, v.data), 'jupiter_tx_malformed');
      expectCode(() => parseLookupTableAddresses(v.owner, Buffer.from('short').toString('base64')), 'jupiter_tx_malformed');
      expectCode(() => addFeeAccountCreation(swapTransaction, { ...tablesOf('sol-to-bonk'), [k]: [] }, args), 'jupiter_tx_malformed');
      // Pad one instruction until the transaction nearly fills a packet: no room left → refused.
      const tx = decodeSolanaTransaction(Buffer.from(swapTransaction, 'base64'));
      const size = encodeSolanaTransaction(tx).length;
      const padded = { ...tx, instructions: tx.instructions.map((ix, i) => (i === 0 ? { ...ix, data: new Uint8Array(ix.data.length + (SOLANA_MAX_TX_BYTES - size) - 4) } : ix)) };
      const full = Buffer.from(encodeSolanaTransaction(padded)).toString('base64');
      expect(Buffer.from(full, 'base64').length).toBeLessThanOrEqual(SOLANA_MAX_TX_BYTES);
      expectCode(() => addFeeAccountCreation(full, tablesOf('sol-to-bonk'), args), 'jupiter_tx_too_large');
    });
  });

  it('base58 round-trips the pinned keys (the decoder reads keys correctly)', () => {
    for (const k of [PROVIAN_SOLANA_USDC_FEE_ACCOUNT, PROVIAN_SOLANA_TREASURY, SOLANA_WSOL_MINT, JUPITER_PROGRAM_ID, '11111111111111111111111111111111']) {
      expect(base58Encode(base58DecodeForTest(k))).toBe(k);
      expect(Buffer.from(base58Decode32(k)).equals(Buffer.from(base58DecodeForTest(k)))).toBe(true);
    }
  });
});

function base58DecodeForTest(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  while (out.length < 32) out.unshift(0);
  return Uint8Array.from(out);
}
