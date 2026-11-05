/**
 * solana-swap-costs — the SOL a Solana-source swap takes from the wallet, each cost by name.
 *
 * Fixtures are REAL (2026-09-25): the relay's own SOL→BONK transaction for a brand-new wallet and
 * the mainnet simulation the relay ran of it with a simulation-only credit, and a LI.FI
 * SOL→Base transaction with its mainnet simulation (the bridge opens two accounts inside a call).
 * The measured SOL change of each simulation is the ground truth the named costs must add up to.
 */
import fs from 'fs';
import path from 'path';
import {
  decodeSolanaTransaction,
  encodeSolanaTransaction,
  parseLookupTableAddresses,
  PROVIAN_SOLANA_TREASURY,
  SOLANA_SYSTEM_PROGRAM_ID,
  SwapFeeError,
  type DecodedSolanaTx,
} from './swap-fees';
import {
  resolveAccountKeys,
  networkFeeLamports,
  listAccountOpenings,
  closedAccounts,
  categorizeOpening,
  addSimulationFunding,
  depositsFromSimulation,
  summarizeSolanaCosts,
  COMPUTE_BUDGET_PROGRAM_ID,
  type ParsedInnerInstruction,
} from './solana-swap-costs';

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));
const tablesOf = (alts: Record<string, { owner: string; data: string }>) =>
  Object.fromEntries(Object.entries(alts).map(([k, v]) => [k, parseLookupTableAddresses(v.owner, v.data)]));
const inner = (sim: { innerInstructions?: Array<{ instructions: ParsedInnerInstruction[] }> }) =>
  (sim.innerInstructions ?? []).flatMap((g) => g.instructions);
const FUNDER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';
const RENT_MIN = 650240n;

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

describe('the brand-new wallet (relay SOL→BONK, mainnet simulation with a simulation-only credit)', () => {
  const f = fx('sim-sol-to-bonk-fresh-wallet.json');
  const tx = decodeSolanaTransaction(Buffer.from(f.relayTransaction, 'base64'));
  const keys = resolveAccountKeys(tx, tablesOf(f.alts));
  const openings = listAccountOpenings(tx, keys, f.user);

  it('top-level openings: the treasury fee account, the user\'s BONK account, and a temporary wSOL account', () => {
    const byOwnerMint = openings.map((o) => [o.kind, o.owner, o.mint, categorizeOpening(o, f.user)]);
    expect(byOwnerMint).toEqual(expect.arrayContaining([
      ['ata', PROVIAN_SOLANA_TREASURY, WSOL, 'treasury'],
      ['ata', f.user, BONK, 'receiving'],
      ['ata', f.user, WSOL, 'temporary'],
    ]));
    expect(openings).toHaveLength(3);
  });

  it('the named costs add up to exactly what the simulation took from the wallet', () => {
    const deposits = depositsFromSimulation({
      inner: inner(f.simulation), topLevelOpenings: openings, topLevelClosed: closedAccounts(tx, keys), user: f.user,
    });
    const fee = networkFeeLamports(tx, keys);
    // Ground truth: in the funded copy the funder paid the fee, so the user's change + the fee.
    const measured = BigInt(f.credit) - BigInt(f.simulation.accounts[0].lamports) + fee;
    const c = summarizeSolanaCosts({ networkFee: fee, deposits, solSwapped: 10_000_000n, balance: 0n, rentExemptMinimum: RENT_MIN, measuredSpend: measured });
    expect(c).toMatchObject({
      receiving_account_lamports: '1488440',
      treasury_fee_account_lamports: '1488440',
      temporary_account_lamports: '1488440',
      other_accounts_lamports: '0',
      sol_swapped_lamports: '10000000',
      spend_lamports: measured.toString(), // named == measured: nothing unexplained
      sufficient: false,
      measured: true,
    });
    expect(BigInt(c.spend_lamports)).toBe(fee + 10_000_000n + 2n * 1_488_440n);
    // An empty wallet needs the spend plus the refunded wSOL deposit up front.
    expect(c.shortfall_lamports).toBe((BigInt(c.spend_lamports) + 1_488_440n).toString());
    expect(c).toEqual({ ...f.relaySolanaCosts, balance_lamports: '0' });
  });

  it('the network fee is 5000 per signature plus the Compute Budget price × limit, rounded up', () => {
    let price = 0n;
    let limit = 0n;
    for (const ix of tx.instructions) {
      if (keys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) continue;
      const d = Buffer.from(ix.data);
      if (d[0] === 2) limit = BigInt(d.readUInt32LE(1));
      if (d[0] === 3) price = d.readBigUInt64LE(1);
    }
    expect(limit).toBeGreaterThan(0n);
    expect(networkFeeLamports(tx, keys)).toBe(5000n + (price * limit + 999_999n) / 1_000_000n);
    // RED: a price with no limit takes the default 200,000 units per non-budget instruction.
    const noLimit = { ...tx, instructions: tx.instructions.filter((ix) => !(keys[ix.programIdIndex] === COMPUTE_BUDGET_PROGRAM_ID && ix.data[0] === 2)) };
    const others = BigInt(noLimit.instructions.filter((ix) => keys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID).length);
    const units = others * 200_000n > 1_400_000n ? 1_400_000n : others * 200_000n;
    expect(networkFeeLamports(noLimit, keys)).toBe(5000n + (price * units + 999_999n) / 1_000_000n);
  });
});

describe('a bridge that opens accounts inside a call (LI.FI SOL→Base, mainnet simulation)', () => {
  const f = fx('sim-lifi-sol-to-base.json');
  const quote = fx('lifi-quote-solana-sol-to-base-small.json');
  const tx = decodeSolanaTransaction(Buffer.from(quote.transactionRequest.data, 'base64'));
  const keys = resolveAccountKeys(tx, tablesOf(f.alts));

  it('the top-level instructions alone see none of them; the simulation sees both', () => {
    const openings = listAccountOpenings(tx, keys, f.user);
    expect(openings.filter((o) => categorizeOpening(o, f.user) === 'other')).toHaveLength(0);
    const deposits = depositsFromSimulation({
      inner: inner(f.simulation), topLevelOpenings: openings, topLevelClosed: closedAccounts(tx, keys), user: f.user,
    });
    // The bridge's USDC account for its order (an ATA of the order, not of the user) and the order account.
    expect(deposits.filter((d) => d.category === 'other').map((d) => d.lamports).sort()).toEqual([1_488_440n, 1_732_280n]);
    const c = summarizeSolanaCosts({
      networkFee: networkFeeLamports(tx, keys),
      deposits: [...deposits, { category: 'treasury', lamports: 400_240n }],
      solSwapped: 100_000_000n,
      balance: BigInt(f.preLamports),
      rentExemptMinimum: RENT_MIN,
      measuredSpend: BigInt(f.preLamports) - BigInt(f.simulation.accounts[0].lamports),
    });
    expect(c.other_accounts_lamports).toBe('3220720');
    expect(c.treasury_fee_account_lamports).toBe('400240');
    // This wallet already held a wSOL account the bridge closed, refunding its rent: the measured
    // change is smaller, and the named costs stand (never understated).
    expect(BigInt(c.spend_lamports)).toBeGreaterThan(BigInt(f.preLamports) - BigInt(f.simulation.accounts[0].lamports));
  });
});

describe('summarizeSolanaCosts — the Send screen\'s rule: end at exactly 0 or rent-exempt', () => {
  const base = { networkFee: 5000n, deposits: [], solSwapped: 1_000_000n, rentExemptMinimum: RENT_MIN };
  it('enough: leaves at least the minimum, or exactly 0', () => {
    expect(summarizeSolanaCosts({ ...base, balance: 1_005_000n + RENT_MIN }).sufficient).toBe(true);
    expect(summarizeSolanaCosts({ ...base, balance: 1_005_000n }).sufficient).toBe(true); // exactly 0 left
  });
  it('RED: a remainder between 0 and the minimum is not enough; the shortfall keeps the wallet open', () => {
    const c = summarizeSolanaCosts({ ...base, balance: 1_005_001n });
    expect(c).toMatchObject({ sufficient: false, required_lamports: String(1_005_000n + RENT_MIN), shortfall_lamports: String(RENT_MIN - 1n) });
  });
  it('RED: a refunded deposit must still be held up front', () => {
    const c = summarizeSolanaCosts({ ...base, deposits: [{ category: 'temporary', lamports: 2_000_000n }], balance: 1_005_000n + RENT_MIN });
    expect(c).toMatchObject({ sufficient: false, spend_lamports: '1005000', required_lamports: String(1_005_000n + 2_000_000n) });
  });
  it('a measured spend beyond the named costs is shown as other; a smaller one changes nothing', () => {
    expect(summarizeSolanaCosts({ ...base, balance: 10n ** 12n, measuredSpend: 1_005_000n + 777n }).other_accounts_lamports).toBe('777');
    const lower = summarizeSolanaCosts({ ...base, balance: 10n ** 12n, measuredSpend: 1n });
    expect(lower).toMatchObject({ other_accounts_lamports: '0', spend_lamports: '1005000', measured: true });
    expect(summarizeSolanaCosts({ ...base, balance: 10n ** 12n }).measured).toBe(false);
  });
});

describe('addSimulationFunding — the simulation-only credit', () => {
  const f = fx('sim-sol-to-bonk-fresh-wallet.json');
  const tx = decodeSolanaTransaction(Buffer.from(f.relayTransaction, 'base64'));
  const tables = tablesOf(f.alts);
  const resolvedIxs = (t: DecodedSolanaTx) => {
    const k = resolveAccountKeys(t, tables);
    return t.instructions.map((ix) => ({ p: k[ix.programIdIndex], a: ix.accounts.map((i) => k[i]), d: Buffer.from(ix.data).toString('hex') }));
  };

  it('funder at index 0 pays the fee; the user stays a writable signer; every original instruction is unchanged', () => {
    const out = decodeSolanaTransaction(encodeSolanaTransaction(addSimulationFunding(tx, FUNDER, 123n)));
    expect(out.staticKeys.slice(0, 2)).toEqual([FUNDER, f.user]);
    expect(out.header.numRequiredSignatures).toBe(tx.header.numRequiredSignatures + 1);
    expect(out.isWritable(0) && out.isWritable(1)).toBe(true);
    const ixs = resolvedIxs(out);
    expect(ixs[0]).toEqual({ p: SOLANA_SYSTEM_PROGRAM_ID, a: [FUNDER, f.user], d: '02000000' + '7b00000000000000' });
    expect(ixs.slice(1)).toEqual(resolvedIxs(tx));
    for (let i = 0; i < tx.staticKeys.length; i++) expect(out.isWritable(i + 1)).toBe(tx.isWritable(i));
  });

  it('appends the System Program when the message lacks it, shifting loaded keys past it', () => {
    const k = resolveAccountKeys(tx, tables);
    const sysIdx = tx.staticKeys.indexOf(SOLANA_SYSTEM_PROGRAM_ID);
    expect(sysIdx).toBeGreaterThan(-1);
    // Build a message without System: drop the instructions that use it and the key itself.
    const users = (ix: DecodedSolanaTx['instructions'][number]) => ix.programIdIndex === sysIdx || ix.accounts.includes(sysIdx);
    const kept = tx.instructions.filter((ix) => !users(ix));
    const down = (i: number) => (i > sysIdx ? i - 1 : i);
    const noSys: DecodedSolanaTx = {
      ...tx,
      staticKeys: tx.staticKeys.filter((_, i) => i !== sysIdx),
      header: { ...tx.header, numReadonlyUnsigned: tx.header.numReadonlyUnsigned - 1 },
      instructions: kept.map((ix) => ({ ...ix, programIdIndex: down(ix.programIdIndex), accounts: ix.accounts.map(down) })),
    };
    const before = resolvedIxs(noSys);
    expect(before).toEqual(kept.map((ix) => ({ p: k[ix.programIdIndex], a: ix.accounts.map((i) => k[i]), d: Buffer.from(ix.data).toString('hex') })));
    const out = decodeSolanaTransaction(encodeSolanaTransaction(addSimulationFunding(noSys, FUNDER, 1n)));
    expect(out.staticKeys[out.staticKeys.length - 1]).toBe(SOLANA_SYSTEM_PROGRAM_ID);
    expect(resolvedIxs(out).slice(1)).toEqual(before);
  });

  it('RED: a funder already in the transaction is refused (the key would be loaded twice)', () => {
    expectCode(() => addSimulationFunding(tx, f.user, 1n), 'solana_tx_malformed');
    expectCode(() => addSimulationFunding(tx, tx.staticKeys[3], 1n), 'solana_tx_malformed');
  });
});
