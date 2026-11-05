/**
 * item 12 : the relay verifies that a Solana-source cross-chain
 * transaction ACTUALLY pays the 25 bps Provian fee to the treasury, instead of trusting what the
 * quote's feeSplit declares. A route that pays less is refused for every caller — the app, an
 * SDK, or a direct call — because every LI.FI quote is fetched and checked by this relay route
 * (`routes/swap-proxy.ts` GET /lifi/quote → `verifyLifiQuoteFee`).
 *
 * The population is the 12 live Mayan Swift captures the app guard pins
 * (`src/core/swap/__fixtures__/solana-route-fixtures.json`, captured 2026-09-26/27), each paired
 * with the feeSplit its quote declared. One of them — `10-usdc-to-eth` is a real LI.FI
 * transaction that makes NO fee transfer at all although its quote declares a 50,000 Provian fee.
 * The relay must refuse it on the transaction, not pass it on the declaration.
 */
import fs from 'fs';
import path from 'path';
import {
  verifyLifiQuoteFee,
  decodeSolanaTransaction,
  LIFI_SOLANA_CHAIN_ID,
  LIFI_SOLANA_NATIVE_TOKEN,
  SOLANA_USDC_MINT,
  SwapFeeError,
} from './swap-fees';

interface Capture {
  name: string;
  kind: string;
  expect: 'pass' | 'refuse';
  tx: string;
  fees: { provian: string; lifi: string; treasuryDepositLamports: string; sourceMint: string; sourceAmount: string };
}

const APP_FIXTURES = path.resolve(__dirname, '../../../../src/core/swap/__fixtures__/solana-route-fixtures.json');
const captures: Capture[] = (JSON.parse(fs.readFileSync(APP_FIXTURES, 'utf8')) as { cases: Capture[] }).cases
  .filter((c) => c.kind === 'lifi' && /^lifi mayan \d+-/.test(c.name));

/** The quote exactly as LI.FI declared it: the feeSplit names Provian's and LI.FI's fee. */
function declaredQuote(c: Capture) {
  return {
    estimate: {
      feeCosts: [{
        name: 'LIFI Fixed Fee',
        feeSplit: {
          integratorFee: c.fees.provian,
          lifiFee: c.fees.lifi,
          recipients: [
            { name: 'lifi', type: 'FIXED', fee: c.fees.lifi },
            { name: 'provian', type: 'FIXED', fee: c.fees.provian },
          ],
        },
      }],
    },
    transactionRequest: { data: c.tx },
  };
}

function verify(c: Capture) {
  const native = c.fees.sourceMint === 'native';
  const deposit = BigInt(c.fees.treasuryDepositLamports);
  return verifyLifiQuoteFee(declaredQuote(c), {
    fromChain: LIFI_SOLANA_CHAIN_ID,
    fromAmount: c.fees.sourceAmount,
    fromToken: native ? LIFI_SOLANA_NATIVE_TOKEN : SOLANA_USDC_MINT,
    solanaTx: decodeSolanaTransaction(Buffer.from(c.tx, 'base64')),
    // The native-SOL captures were taken while the Solana treasury held 0 lamports: LI.FI raised
    // its fee transfer to the rent-exempt minimum (fee + deposit).
    ...(native && deposit > 0n ? { emptyTreasuryMinimum: BigInt(c.fees.provian) + deposit } : {}),
  });
}

describe(' item 12: Solana-source LI.FI fees are verified on the transaction, not the declaration', () => {
  it('the population is the 12 live Mayan Swift captures (11 pay the fee, 1 does not)', () => {
    expect(captures).toHaveLength(12);
    expect(captures.filter((c) => c.expect === 'pass')).toHaveLength(11);
    expect(captures.filter((c) => c.expect === 'refuse').map((c) => c.name)).toEqual(['lifi mayan 10-usdc-to-eth']);
  });

  it.each(captures.filter((c) => c.expect === 'pass').map((c) => [c.name, c] as const))(
    '%s: the transaction pays exactly the declared 25 bps Provian fee — accepted',
    (_name, c) => {
      const r = verify(c);
      expect(r.feeAmount).toBe(c.fees.provian);
      expect(r.treasuryDepositLamports).toBe(c.fees.treasuryDepositLamports);
    },
  );

  it('RED: the live 10-usdc-to-eth route DECLARES a 50,000 Provian fee but its transaction pays none — refused', () => {
    const c = captures.find((x) => x.name === 'lifi mayan 10-usdc-to-eth')!;
    // The declaration alone is well-formed: 25 bps of the 20 USDC source amount, assigned to provian.
    expect(c.fees.provian).toBe('50000');
    expect((BigInt(c.fees.sourceAmount) * 25n) / 10_000n).toBe(50000n);
    let err: unknown;
    try { verify(c); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SwapFeeError);
    expect((err as SwapFeeError).code).toBe('swap_fee_wrong_recipient');
  });

  it('RED: a paying capture whose declaration is inflated above what the transaction pays is refused', () => {
    // The transaction pays 50,000; the quote claims 50,001 (still inside the ±1 rate tolerance).
    // Trusting the declaration would pass; the transaction check refuses because the amount differs.
    const c = captures.find((x) => x.name === 'lifi mayan 8453-usdc-to-usdc')!;
    const inflated: Capture = { ...c, fees: { ...c.fees, provian: '50001' } };
    let err: unknown;
    try { verify(inflated); } catch (e) { err = e; }
    expect((err as SwapFeeError).code).toBe('swap_fee_wrong_recipient');
  });
});
