/**
 * THE SOLANA CHAIN-RECORD DERIVATION — pure. Given one finalized transaction (the projection both
 * operator legs agreed on, `solana-economic-discovery.ts`) and one watched Solana address W, derive
 * at most ONE act for W, or none:
 *
 * - KNOWN ASSETS ONLY. SOL and the tokens the wallet holds and its swap screen offers on Solana
 *   (`SOLANA_KNOWN_ASSETS`: USDC, BONK, JUP, WIF, PYUSD). A leg in any other mint is never an act,
 *   as an unknown token never mints on the EVM chains (Unknown = Block).
 * - W SIGNED the transaction:
 *   - a transaction W signed that invokes a SWAP VENUE at top level — Jupiter v6, the program the
 *     app's swaps run through, as the Uniswap routers and 0x are on the EVM chains — is a SWAP when
 *     W's holding of one known asset fell and of a different known asset rose, and otherwise no act
 *     (a venue call whose legs are not an exchange of known assets derives nothing, as a call to a
 *     router does on Base). A transaction that invokes a BRIDGE VENUE (Mayan Swift v2 or the Mayan
 *     CPI proxy, which the app's cross-chain swaps from Solana run through) is a cross-chain SWAP
 *     only when, inside that venue instruction, a token-program transfer moves a known asset (wrapped
 *     SOL is SOL) from W to another owner — the deposit into the order — and W's holding of that
 *     asset fell; the deposit is the amount sold, and the proceeds arrive on the other chain, as
 *     with the LI.FI Diamond on the EVM chains. Lamports W pays directly (rent for the accounts the
 *     order creates, fees) are never the deposit. Without such a deposit the bridge call is no swap
 *     and the transaction is read as if it had none. The venue program is the counterparty and
 *     keys the act.
 *     SOL is measured as the lamports of W's own account plus every token account W owns (so
 *     wrapping SOL into W's own wrapped-SOL account, or paying rent into W's own new token account,
 *     moves nothing), net of the network fee when W paid it; wrapped SOL is counted as SOL, never as
 *     a second asset, so SOL ↔ wrapped SOL is not an exchange. A transaction that invokes no venue
 *     is never a swap, whatever W's holdings did.
 *   - otherwise SEND when a System `transfer` or SPL `transfer` / `transferChecked` /
 *     `transferCheckedWithFee` (top-level or inner, first in execution order) moves a non-zero
 *     amount from W or a token account W owns to a different owner; the counterparty is the
 *     destination's owner.
 * - W did NOT sign: RECEIVE when such a transfer moves a non-zero amount into W or a token account W
 *   owns from a different owner; the counterparty is the source's owner. A transaction W signed
 *   never derives a receive (what it received there is part of its own act).
 * - NET DIRECTION. A send's leg counts only when W ended the transaction holding LESS of that asset,
 *   and a receive's only when W ended holding MORE: value that came back to W inside the same
 *   transaction (an arbitrage round trip that nets SOL up, a refund) was not sent.
 *
 * OWNERS. A token account's owner is read from the transaction's own token balances (pre and post).
 * A token account whose owner is missing, or differs between pre and post, or whose mint does not
 * match the instruction, is unresolvable, and a transfer touching it is never an act (Unknown =
 * Block). A System transfer's endpoint is the address itself, or the owner of the token account it
 * pays (wrapping SOL).
 *
 * KEY. `solana:<signature>:<top-level instruction index>` of the carrier — the claim-store form
 * (`solana-keys.ts`). An inner transfer is keyed on the top-level instruction that ran it; one act
 * per transaction per address makes that unique for W.
 *
 * EXCLUDED COUNTERPARTIES are never a send's destination or a receive's source: Provian's own Solana
 * service wallets (passed in by the caller from the one service-wallet registry), the System
 * program and the incinerator. A transfer to or from one is skipped, and the next one considered.
 */

import { solanaInstructionEventId } from '../external-address/solana-keys';
import {
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_PROGRAMS,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  type SolanaProjectedInstruction,
  type SolanaProjectedTransaction,
} from '../onchain/solana-economic-discovery';

export const SOLANA_WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOLANA_USDC_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const SOLANA_MAYAN_SWIFT_V2_PROGRAM = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny';
export const SOLANA_MAYAN_CPI_PROXY_PROGRAM = 'D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa';

/** Same-chain exchange venues: the program the app's Solana swaps run through. */
export const SOLANA_SWAP_PROGRAMS: ReadonlySet<string> = new Set([SOLANA_JUPITER_V6_PROGRAM]);
/** Cross-chain venues: the programs the app's swaps from Solana to another chain run through. */
export const SOLANA_BRIDGE_PROGRAMS: ReadonlySet<string> = new Set([
  SOLANA_MAYAN_SWIFT_V2_PROGRAM,
  SOLANA_MAYAN_CPI_PROXY_PROGRAM,
]);

/**
 * The assets this lane counts, mint → symbol (SOL is `null`): the wallet's Solana tokens
 * (`src/core/chains/solana/tokens.ts`) and USDC. Any other mint is unknown and never an act.
 */
export const SOLANA_KNOWN_ASSETS: ReadonlyMap<string, string> = new Map([
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
  ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF'],
  ['2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 'PYUSD'],
]);

export function isKnownSolanaAsset(mint: string | null): boolean {
  return mint === null || SOLANA_KNOWN_ASSETS.has(mint);
}

export const SOLANA_INCINERATOR = '1nc1nerator11111111111111111111111111111111';
export const SOLANA_COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SOLANA_MEMO_PROGRAMS: readonly string[] = Object.freeze([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

/** Programs that move or prepare value but are never an exchange themselves. */
export const SOLANA_PLUMBING_PROGRAMS: ReadonlySet<string> = new Set([
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  ...SOLANA_MEMO_PROGRAMS,
]);

/** Always excluded, whatever the caller passes: the System program and the incinerator. */
export const SOLANA_ALWAYS_EXCLUDED_COUNTERPARTIES: ReadonlySet<string> = new Set([
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_INCINERATOR,
]);

/** One value movement, normalized to owners. */
export interface SolanaTransferLeg {
  readonly outerIndex: number;
  /** Position inside the outer instruction's inner list; null for the top-level instruction. */
  readonly innerIndex: number | null;
  readonly kind: 'native' | 'spl';
  /** The program that moved it: a System transfer, or a token-program transfer (wrapped SOL included). */
  readonly via: 'system' | 'token';
  /** null for SOL. */
  readonly mint: string | null;
  readonly fromOwner: string;
  readonly toOwner: string;
  readonly amount: bigint;
}

export interface SolanaChainRecordAct {
  readonly actionType: 'send' | 'swap' | 'receive';
  /** The other party, raw base58 (a swap's is the swap program, or the first counterparty). */
  readonly counterparty: string;
  readonly instructionIndex: number;
  readonly innerIndex: number | null;
  /** `solana:<signature>:<instructionIndex>`. */
  readonly canonicalEventId: string;
  readonly leg: 'native' | 'spl';
  /** null for SOL. */
  readonly mint: string | null;
  readonly assetSymbol: string;
  readonly amountAtomic: string;
  readonly swap?: {
    readonly programId: string | null;
    readonly sold: { readonly mint: string | null; readonly amountAtomic: string };
    /** null for a cross-chain swap: the proceeds arrive on the other chain. */
    readonly bought: { readonly mint: string | null; readonly amountAtomic: string } | null;
  };
}

export type SolanaChainRecordDerivation =
  | { readonly status: 'act'; readonly act: SolanaChainRecordAct }
  | { readonly status: 'no_act'; readonly reason: string };

export interface SolanaDerivationContext {
  /** Provian's own Solana service wallets (the one registry). The always-excluded set is added. */
  readonly excludedCounterparties: ReadonlySet<string>;
}

interface TokenAccountFacts {
  readonly owner: string | null;
  readonly mint: string;
  /** Owner or mint differed between pre and post. */
  readonly ambiguous: boolean;
}

function tokenAccountFacts(tx: SolanaProjectedTransaction): Map<string, TokenAccountFacts> {
  const facts = new Map<string, TokenAccountFacts>();
  for (const row of [...tx.preTokenBalances, ...tx.postTokenBalances]) {
    const key = tx.accountKeys[row.accountIndex];
    if (key === undefined) throw new Error('solana_derivation_token_balance_index_invalid');
    const account = key.pubkey;
    const prev = facts.get(account);
    if (prev === undefined) {
      facts.set(account, { owner: row.owner, mint: row.mint, ambiguous: false });
    } else if (prev.owner !== row.owner || prev.mint !== row.mint) {
      facts.set(account, { ...prev, ambiguous: true });
    }
  }
  return facts;
}

function assetSymbolOf(mint: string | null): string {
  if (mint === null) return 'SOL';
  const symbol = SOLANA_KNOWN_ASSETS.get(mint);
  if (symbol === undefined) throw new Error('solana_derivation_unknown_asset');
  return symbol;
}

/**
 * Every value movement in execution order (top-level instruction, then the instructions it ran),
 * normalized to owners. A movement whose owners cannot be resolved is left out. Pure.
 */
export function solanaTransferLegs(tx: SolanaProjectedTransaction): SolanaTransferLeg[] {
  const facts = tokenAccountFacts(tx);
  const resolvedOwner = (account: string): string | null => {
    const f = facts.get(account);
    return f === undefined || f.ambiguous ? null : f.owner;
  };
  const legOf = (ix: SolanaProjectedInstruction, outerIndex: number, innerIndex: number | null): SolanaTransferLeg | null => {
    const t = ix.transfer;
    if (t === null) return null;
    const amount = BigInt(t.amount);
    if (ix.programId === SOLANA_SYSTEM_PROGRAM) {
      // A System transfer's endpoint is the address, or the owner of the token account it pays.
      const endpoint = (address: string): string | null => (facts.has(address) ? resolvedOwner(address) : address);
      const fromOwner = endpoint(t.source);
      const toOwner = endpoint(t.destination);
      if (fromOwner === null || toOwner === null) return null;
      return { outerIndex, innerIndex, kind: 'native', via: 'system', mint: null, fromOwner, toOwner, amount };
    }
    if (!SOLANA_TOKEN_PROGRAMS.has(ix.programId)) return null;
    const source = facts.get(t.source);
    const destination = facts.get(t.destination);
    if (source === undefined || destination === undefined || source.ambiguous || destination.ambiguous) return null;
    if (source.owner === null || destination.owner === null || source.mint !== destination.mint) return null;
    if (t.mint !== null && t.mint !== source.mint) return null;
    // Wrapped SOL is SOL: it is measured in lamports, never as a token.
    const mint = source.mint === SOLANA_WRAPPED_SOL_MINT ? null : source.mint;
    return {
      outerIndex,
      innerIndex,
      kind: mint === null ? 'native' : 'spl',
      via: 'token',
      mint,
      fromOwner: source.owner,
      toOwner: destination.owner,
      amount,
    };
  };
  const legs: SolanaTransferLeg[] = [];
  tx.instructions.forEach((outer, i) => {
    const top = legOf(outer, i, null);
    if (top !== null) legs.push(top);
    outer.inner.forEach((ix, j) => {
      const inner = legOf(ix, i, j);
      if (inner !== null) legs.push(inner);
    });
  });
  return legs;
}

/**
 * W's net holdings change per asset (`null` = SOL, in lamports, net of the fee W paid; wrapped SOL
 * folded into SOL). Throws when a lamport balance it needs is not a safe integer (never guessed).
 */
export function solanaHoldingDeltas(tx: SolanaProjectedTransaction, watched: string): Map<string | null, bigint> {
  const facts = tokenAccountFacts(tx);
  const heldIndices = new Set<number>();
  tx.accountKeys.forEach((key, i) => {
    if (key.pubkey === watched) heldIndices.add(i);
    const f = facts.get(key.pubkey);
    if (f !== undefined && !f.ambiguous && f.owner === watched) heldIndices.add(i);
  });
  let sol = 0n;
  for (const i of heldIndices) {
    const pre = tx.preLamports[i];
    const post = tx.postLamports[i];
    if (pre === null || post === null || pre === undefined || post === undefined) {
      throw new Error('solana_derivation_lamports_unsafe');
    }
    sol += BigInt(post) - BigInt(pre);
  }
  if (tx.accountKeys[0]?.pubkey === watched) {
    if (tx.fee === null) throw new Error('solana_derivation_fee_unsafe');
    sol += BigInt(tx.fee);
  }
  const deltas = new Map<string | null, bigint>();
  if (sol !== 0n) deltas.set(null, sol);
  const add = (rows: SolanaProjectedTransaction['preTokenBalances'], sign: 1n | -1n): void => {
    for (const row of rows) {
      if (row.owner !== watched || row.mint === SOLANA_WRAPPED_SOL_MINT) continue;
      const account = tx.accountKeys[row.accountIndex]?.pubkey;
      const f = account === undefined ? undefined : facts.get(account);
      if (f === undefined || f.ambiguous) continue;
      deltas.set(row.mint, (deltas.get(row.mint) ?? 0n) + sign * BigInt(row.amount));
    }
  };
  add(tx.postTokenBalances, 1n);
  add(tx.preTokenBalances, -1n);
  for (const [asset, delta] of [...deltas]) if (delta === 0n) deltas.delete(asset);
  return deltas;
}

/** SOL first, then mints in byte order: one deterministic choice of the asset reported. */
function orderedAssets(assets: Array<string | null>): Array<string | null> {
  return [...assets].sort((a, b) => (a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/** The transaction's fee payer (account key 0). */
export function solanaFeePayer(tx: SolanaProjectedTransaction): string {
  return tx.accountKeys[0].pubkey;
}

export function deriveSolanaChainRecordAct(
  tx: SolanaProjectedTransaction,
  watched: string,
  context: SolanaDerivationContext,
): SolanaChainRecordDerivation {
  if (tx.err !== null) return { status: 'no_act', reason: 'transaction_failed' };
  const excluded = (address: string): boolean => address === watched
    || SOLANA_ALWAYS_EXCLUDED_COUNTERPARTIES.has(address)
    || context.excludedCounterparties.has(address);
  const legs = solanaTransferLegs(tx).filter((leg) => isKnownSolanaAsset(leg.mint));
  const actFromLeg = (
    actionType: 'send' | 'receive',
    leg: SolanaTransferLeg,
    counterparty: string,
  ): SolanaChainRecordDerivation => ({
    status: 'act',
    act: {
      actionType,
      counterparty,
      instructionIndex: leg.outerIndex,
      innerIndex: leg.innerIndex,
      canonicalEventId: solanaInstructionEventId(tx.signature, leg.outerIndex),
      leg: leg.kind,
      mint: leg.mint,
      assetSymbol: assetSymbolOf(leg.mint),
      amountAtomic: leg.amount.toString(),
    },
  });

  // A leg counts only in the direction W's holding of that asset actually moved: value that came
  // back to W inside the same transaction (an arbitrage round trip, a refund) was not sent.
  const deltas = new Map([...solanaHoldingDeltas(tx, watched)].filter(([asset]) => isKnownSolanaAsset(asset)));
  const netOut = (mint: string | null): boolean => (deltas.get(mint) ?? 0n) < 0n;
  const netIn = (mint: string | null): boolean => (deltas.get(mint) ?? 0n) > 0n;

  const signed = tx.accountKeys.some((key) => key.pubkey === watched && key.signer);
  if (!signed) {
    const inbound = legs.find((leg) => leg.toOwner === watched && leg.amount > 0n
      && !excluded(leg.fromOwner) && netIn(leg.mint));
    return inbound ? actFromLeg('receive', inbound, inbound.fromOwner) : { status: 'no_act', reason: 'no_qualifying_receive' };
  }

  const outbound = legs.find((leg) => leg.fromOwner === watched && leg.amount > 0n
    && !excluded(leg.toOwner) && netOut(leg.mint));
  const fell = orderedAssets([...deltas].filter(([, d]) => d < 0n).map(([a]) => a));
  const rose = orderedAssets([...deltas].filter(([, d]) => d > 0n).map(([a]) => a));
  const swapAct = (
    venueIndex: number,
    sold: string | null,
    soldAmount: bigint,
    bought: { readonly mint: string | null; readonly amountAtomic: string } | null,
  ): SolanaChainRecordDerivation => {
    const programId = tx.instructions[venueIndex].programId;
    return {
      status: 'act',
      act: {
        actionType: 'swap',
        counterparty: programId,
        instructionIndex: venueIndex,
        innerIndex: null,
        canonicalEventId: solanaInstructionEventId(tx.signature, venueIndex),
        leg: sold === null ? 'native' : 'spl',
        mint: sold,
        assetSymbol: assetSymbolOf(sold),
        amountAtomic: soldAmount.toString(),
        swap: { programId, sold: { mint: sold, amountAtomic: soldAmount.toString() }, bought },
      },
    };
  };

  const swapIndex = tx.instructions.findIndex((ix) => SOLANA_SWAP_PROGRAMS.has(ix.programId));
  if (swapIndex >= 0) {
    if (fell.length === 0) return { status: 'no_act', reason: 'venue_no_known_asset_sold' };
    if (rose.length === 0) return { status: 'no_act', reason: 'venue_no_known_asset_bought' };
    const sold = fell[0];
    const bought = rose[0];
    return swapAct(swapIndex, sold, -(deltas.get(sold) as bigint), {
      mint: bought, amountAtomic: (deltas.get(bought) as bigint).toString(),
    });
  }

  for (let bridgeIndex = 0; bridgeIndex < tx.instructions.length; bridgeIndex += 1) {
    if (!SOLANA_BRIDGE_PROGRAMS.has(tx.instructions[bridgeIndex].programId)) continue;
    const deposit = legs.find((leg) => leg.outerIndex === bridgeIndex && leg.innerIndex !== null
      && leg.via === 'token' && leg.fromOwner === watched && leg.amount > 0n
      && !excluded(leg.toOwner) && netOut(leg.mint));
    if (deposit) return swapAct(bridgeIndex, deposit.mint, deposit.amount, null);
  }
  if (outbound) return actFromLeg('send', outbound, outbound.toOwner);
  return { status: 'no_act', reason: 'no_qualifying_leg' };
}
