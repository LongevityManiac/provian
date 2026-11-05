/**
 * Solana swap costs — the SOL a Solana-source swap transaction takes from the user's wallet, each
 * cost under its own name, read from the transaction the relay is about to return.
 *
 * the standing rule : before a user confirms a swap starting on Solana, the swap screen
 * shows the SOL it needs — the network fee, the user's own receiving account when it has to be
 * opened, and the treasury fee-account deposit when the swap opens one (the user pays it, not
 * Provian) — and says exactly how much SOL is missing instead of letting the swap fail on the
 * network.
 *
 * The transaction's top-level instructions name every account it opens and who pays for it:
 * - an Associated Token Account program Create / CreateIdempotent funded by the user opens a
 * token account whose deposit is the rent-exempt minimum for its size, less any lamports
 * already at that address (0 when the account already exists: the create is a no-op);
 * - a System Program CreateAccount / CreateAccountWithSeed funded by the user moves the stated
 * lamports into a new account.
 * A token account the same transaction closes back to the user (Jupiter's temporary wrapped-SOL
 * account) is refunded; its deposit is needed only while the transaction runs.
 *
 * The node also requires the fee payer to end rent-exempt or empty: after the swap the wallet
 * must hold exactly 0 SOL or at least the rent-exempt minimum for a 0-byte account (the same rule
 * the Send screen applies).
 */

import {
  PROVIAN_SOLANA_TREASURY,
  SOLANA_ATA_PROGRAM_ID,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_IDS,
  SwapFeeError,
  base58Decode32,
  type DecodedSolanaTx,
} from './swap-fees';

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

/** Base fee per required signature. */
export const SOLANA_LAMPORTS_PER_SIGNATURE = 5000n;

/** Per-instruction compute limit a transaction gets when it sets a unit price but no limit. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const MAX_UNITS = 1_400_000n;

/**
 * Every account key of the message in index order: static keys, then every lookup table's
 * writable entries, then every lookup table's readonly entries.
 */
export function resolveAccountKeys(tx: DecodedSolanaTx, lookupTables: Record<string, string[]>): string[] {
  const keys = [...tx.staticKeys];
  for (const kind of ['writable', 'readonly'] as const) {
    for (const l of tx.lookups) {
      const table = lookupTables[l.tableKey];
      if (!table) throw new SwapFeeError('solana_tx_malformed', 'lookup table contents missing');
      for (const i of kind === 'writable' ? l.writableIndexes : l.readonlyIndexes) {
        if (i >= table.length) throw new SwapFeeError('solana_tx_malformed', 'lookup table index out of range');
        keys.push(table[i]);
      }
    }
  }
  return keys;
}

function u32(d: Uint8Array, at: number): number {
  return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16)) + d[at + 3] * 0x1000000;
}

function u64(d: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
}

/**
 * The network fee this transaction pays: 5000 lamports per required signature plus the priority
 * fee its Compute Budget instructions set (unit price in micro-lamports × unit limit, rounded up).
 */
export function networkFeeLamports(tx: DecodedSolanaTx, keys: string[]): bigint {
  let price = 0n;
  let limit: bigint | null = null;
  let others = 0n;
  for (const ix of tx.instructions) {
    if (keys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM_ID) {
      others += 1n;
      continue;
    }
    const d = ix.data;
    if (d[0] === 2 && d.length >= 5) limit = BigInt(u32(d, 1));
    else if (d[0] === 3 && d.length >= 9) price = u64(d, 1);
  }
  const units = limit ?? (others * DEFAULT_UNITS_PER_INSTRUCTION > MAX_UNITS ? MAX_UNITS : others * DEFAULT_UNITS_PER_INSTRUCTION);
  const priority = (price * units + 999_999n) / 1_000_000n;
  return BigInt(tx.header.numRequiredSignatures) * SOLANA_LAMPORTS_PER_SIGNATURE + priority;
}

export interface AccountOpening {
  kind: 'ata' | 'system';
  /** The account being opened. */
  target: string;
  /** Token account owner (ATA opens only). */
  owner?: string;
  mint?: string;
  tokenProgram?: string;
  /** Lamports moved into the new account (System opens only). */
  lamports?: bigint;
  /** A token CloseAccount on this account later in the same transaction (refunded). */
  closedInTx: boolean;
}

/** Token accounts a top-level CloseAccount in this transaction closes. */
export function closedAccounts(tx: DecodedSolanaTx, keys: string[]): Set<string> {
  const closed = new Set<string>();
  for (const ix of tx.instructions) {
    if (SOLANA_TOKEN_PROGRAM_IDS.has(keys[ix.programIdIndex]) && ix.data[0] === 9 && ix.data.length === 1) {
      closed.add(keys[ix.accounts[0]]);
    }
  }
  return closed;
}

/** Every account the user's wallet pays to open in this transaction (top-level instructions). */
export function listAccountOpenings(tx: DecodedSolanaTx, keys: string[], user: string): AccountOpening[] {
  const closed = closedAccounts(tx, keys);
  const out: AccountOpening[] = [];
  for (const ix of tx.instructions) {
    const program = keys[ix.programIdIndex];
    const acct = (i: number) => keys[ix.accounts[i]];
    const d = ix.data;
    if (program === SOLANA_ATA_PROGRAM_ID && (d.length === 0 || d[0] === 0 || d[0] === 1) && ix.accounts.length >= 6) {
      if (acct(0) !== user) continue;
      out.push({ kind: 'ata', target: acct(1), owner: acct(2), mint: acct(3), tokenProgram: acct(5), closedInTx: closed.has(acct(1)) });
    } else if (program === SOLANA_SYSTEM_PROGRAM_ID && d.length >= 4) {
      const disc = u32(d, 0);
      if (disc === 0 && d.length >= 12 && ix.accounts.length >= 2 && acct(0) === user) {
        out.push({ kind: 'system', target: acct(1), lamports: u64(d, 4), closedInTx: closed.has(acct(1)) });
      } else if (disc === 3 && ix.accounts.length >= 2 && acct(0) === user && d.length >= 4 + 32 + 8) {
        const seedLen = Number(u64(d, 36));
        const at = 44 + seedLen;
        if (d.length >= at + 8) out.push({ kind: 'system', target: acct(1), lamports: u64(d, at), closedInTx: closed.has(acct(1)) });
      }
    }
  }
  return out;
}

export type OpeningCategory = 'receiving' | 'treasury' | 'temporary' | 'other';

/** Who an opened account serves, as the swap screen names it. */
export function categorizeOpening(o: AccountOpening, user: string): OpeningCategory {
  if (o.kind === 'ata' && o.owner === PROVIAN_SOLANA_TREASURY) return 'treasury';
  if (o.closedInTx) return 'temporary';
  if (o.kind === 'ata' && o.owner === user) return 'receiving';
  return 'other';
}

/**
 * A copy of the transaction for SIMULATION ONLY that first moves `lamports` from `funder` into the
 * user's wallet, so the relay can run the user's exact transaction and read everything it opens
 * even when the user cannot yet afford it. The funder is inserted at index 0 as the fee payer
 * (Solana charges the fee before any instruction runs, so a wallet at 0 SOL could not pay it from
 * the credit); the user stays a writable signer at index 1 and every account index shifts by one
 * (plus one more for loaded keys if the System Program has to be appended as a static read-only
 * key). The copy is never signed or sent — the relay simulates it with signature verification
 * off. The user's simulated SOL change therefore excludes the network fee, which the caller adds
 * from the original transaction's own instructions.
 */
export function addSimulationFunding(tx: DecodedSolanaTx, funder: string, lamports: bigint): DecodedSolanaTx {
  if (tx.header.numRequiredSignatures < 1 || tx.header.numRequiredSignatures - tx.header.numReadonlySigned < 1) {
    throw new SwapFeeError('solana_tx_malformed', 'transaction has no writable fee payer');
  }
  base58Decode32(funder);
  if (tx.staticKeys.includes(funder)) throw new SwapFeeError('solana_tx_malformed', 'funder is already a key of the transaction');
  const staticCount = tx.staticKeys.length;
  const systemIdx = tx.staticKeys.indexOf(SOLANA_SYSTEM_PROGRAM_ID);
  const appendSystem = systemIdx < 0;
  // old index → new index: +1 for the funder at 0, +1 more for loaded keys if System is appended.
  const remap = (i: number) => i + 1 + (appendSystem && i >= staticCount ? 1 : 0);
  const staticKeys = [funder, ...tx.staticKeys, ...(appendSystem ? [SOLANA_SYSTEM_PROGRAM_ID] : [])];
  const programIdx = appendSystem ? staticCount + 1 : remap(systemIdx);
  const data = new Uint8Array(12);
  data[0] = 2; // System Program Transfer
  let v = lamports;
  for (let i = 4; i < 12; i++) {
    data[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return {
    ...tx,
    signatureCount: tx.header.numRequiredSignatures + 1,
    staticKeys,
    header: {
      numRequiredSignatures: tx.header.numRequiredSignatures + 1,
      numReadonlySigned: tx.header.numReadonlySigned,
      numReadonlyUnsigned: tx.header.numReadonlyUnsigned + (appendSystem ? 1 : 0),
    },
    instructions: [
      { programIdIndex: programIdx, accounts: [0, 1], data },
      ...tx.instructions.map((ix) => ({ ...ix, programIdIndex: remap(ix.programIdIndex), accounts: ix.accounts.map(remap) })),
    ],
  };
}

/** A jsonParsed instruction as simulateTransaction returns it inside `innerInstructions`. */
export interface ParsedInnerInstruction {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}

/**
 * The deposits a simulated transaction made from the user's wallet into accounts it opened,
 * read from its inner instructions (every account opened inside a call — including by a
 * top-level Associated Token Account create — is created there) plus the top-level System
 * creates, which are not inner instructions. The top-level ATA creates name each account's
 * wallet; so do ATA creates made inside a call. A token account
 * closed in the same transaction is 'temporary' (refunded); an associated token account is
 * categorized by its wallet.
 */
export function depositsFromSimulation(p: {
  inner: ParsedInnerInstruction[];
  /** The transaction's top-level openings (their creates' own inner instructions carry the lamports). */
  topLevelOpenings: AccountOpening[];
  topLevelClosed: ReadonlySet<string>;
  user: string;
}): Array<{ category: OpeningCategory; lamports: bigint }> {
  const info = (ix: ParsedInnerInstruction) => (typeof ix.parsed === 'object' ? ix.parsed : undefined);
  const ataWallet = new Map<string, string>();
  for (const o of p.topLevelOpenings) if (o.kind === 'ata') ataWallet.set(o.target, o.owner!);
  const closed = new Set(p.topLevelClosed);
  for (const ix of p.inner) {
    const x = info(ix);
    if (!x?.info) continue;
    if (ix.program === 'spl-associated-token-account' && (x.type === 'create' || x.type === 'createIdempotent')) {
      ataWallet.set(String(x.info.account), String(x.info.wallet));
    }
    if (ix.program === 'spl-token' && x.type === 'closeAccount') closed.add(String(x.info.account));
  }
  const categoryOf = (account: string): OpeningCategory => {
    const wallet = ataWallet.get(account);
    if (wallet === PROVIAN_SOLANA_TREASURY) return 'treasury';
    if (closed.has(account)) return 'temporary';
    if (wallet === p.user) return 'receiving';
    return 'other';
  };
  const out: Array<{ category: OpeningCategory; lamports: bigint }> = [];
  for (const ix of p.inner) {
    const x = info(ix);
    if (ix.program !== 'system' || !x?.info || x.info.source !== p.user) continue;
    const lamports = BigInt(String(x.info.lamports ?? 0));
    if (x.type === 'createAccount' || x.type === 'createAccountWithSeed') {
      out.push({ category: categoryOf(String(x.info.newAccount)), lamports });
    } else if (x.type === 'transfer' && ataWallet.has(String(x.info.destination))) {
      // The ATA program topping up an address that already held some lamports.
      out.push({ category: categoryOf(String(x.info.destination)), lamports });
    }
  }
  for (const o of p.topLevelOpenings) {
    if (o.kind === 'system') out.push({ category: o.closedInTx ? 'temporary' : 'other', lamports: o.lamports! });
  }
  return out;
}

export interface SolanaSwapCosts {
  network_fee_lamports: string;
  /** The user's own token account(s) for what they receive, opened by this swap. */
  receiving_account_lamports: string;
  /** The treasury's fee account (or the treasury's own address) opened by this swap. */
  treasury_fee_account_lamports: string;
  /** Opened and closed back to the user in the same swap: needed up front, refunded. */
  temporary_account_lamports: string;
  /** Any other account the route opens with the user's SOL. */
  other_accounts_lamports: string;
  /** SOL leaving the wallet as the swap's input (native SOL swaps). */
  sol_swapped_lamports: string;
  /** What the swap takes from the wallet in total (everything above except the refunded part). */
  spend_lamports: string;
  /** The SOL to hold so the swap runs and the wallet stays open: spend + max(refunded, minimum). */
  required_lamports: string;
  balance_lamports: string;
  rent_exempt_minimum_lamports: string;
  sufficient: boolean;
  /** How much more SOL the wallet needs (0 when sufficient). */
  shortfall_lamports: string;
  /**
   * True when the figures come from simulating the user's exact transaction (every account a
   * program opens inside a call included). False when that simulation could not run and they
   * come from the top-level instructions alone, which cannot see accounts opened inside a call.
   */
  measured: boolean;
}

export function summarizeSolanaCosts(p: {
  networkFee: bigint;
  deposits: Array<{ category: OpeningCategory; lamports: bigint }>;
  solSwapped: bigint;
  balance: bigint;
  rentExemptMinimum: bigint;
  /**
   * The wallet's SOL change measured by simulating the user's exact transaction, plus its network
   * fee (refunds netted). Anything it took beyond the named costs is added to 'other' (e.g. a
   * bridge's own SOL charge); a smaller figure (an old account the swap closed refunded rent)
   * leaves the named costs as they are.
   */
  measuredSpend?: bigint;
}): SolanaSwapCosts {
  const sum = (c: OpeningCategory) => p.deposits.filter((x) => x.category === c).reduce((s, x) => s + x.lamports, 0n);
  const receiving = sum('receiving');
  const treasury = sum('treasury');
  const temporary = sum('temporary');
  const named = p.networkFee + receiving + treasury + sum('other') + p.solSwapped;
  const extra = p.measuredSpend !== undefined && p.measuredSpend > named ? p.measuredSpend - named : 0n;
  const other = sum('other') + extra;
  const spend = p.networkFee + receiving + treasury + other + p.solSwapped;
  const required = spend + (temporary > p.rentExemptMinimum ? temporary : p.rentExemptMinimum);
  const left = p.balance - spend;
  const sufficient = p.balance >= spend + temporary && (left === 0n || left >= p.rentExemptMinimum);
  const shortfall = sufficient ? 0n : required - p.balance;
  return {
    network_fee_lamports: p.networkFee.toString(),
    receiving_account_lamports: receiving.toString(),
    treasury_fee_account_lamports: treasury.toString(),
    temporary_account_lamports: temporary.toString(),
    other_accounts_lamports: other.toString(),
    sol_swapped_lamports: p.solSwapped.toString(),
    spend_lamports: spend.toString(),
    required_lamports: required.toString(),
    balance_lamports: p.balance.toString(),
    rent_exempt_minimum_lamports: p.rentExemptMinimum.toString(),
    sufficient,
    shortfall_lamports: (shortfall > 0n ? shortfall : 0n).toString(),
    measured: p.measuredSpend !== undefined,
  };
}
