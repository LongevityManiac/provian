/**
 * Provian's own fee / gas / revenue wallets — the ONE predicate every lane's seal reads.
 *
 * FRANK'S RULE ( follow-up, 2026-10-04): the facilitator fee and the on-demand payout
 * fee are a SERVICE FEE, never a price for PVT. A fee that minted a `send` (or any act) for the
 * payer would make it one. So a transfer whose counterparty is one of the wallets below never
 * mints for the PAYER, on ANY lane: it records, and seals `record_only` with reason
 * {@link PROVIAN_SERVICE_FEE_REASON_CODE}. Nothing is gated — the act is witnessed and kept.
 *
 * WHERE IT IS ENFORCED. Once, at the seal: `recordPEAccrual` (`src/pvt-accrual.ts`) asks
 * {@link provianServiceFeeApplies} for every act that carries a `counterpartyAddress`, and the
 * operational disposition (`resolveOperationalDisposition`) seals it. Every lane — the outbound
 * and inbound USDC watchers, the chain-record lane (native wallets and proven addresses, humans and
 * agents, and the hashes the phone's batch queues into it), the x402 facilitator lane, device /
 * mobile batch acts — reaches that one seal, so a new lane cannot forget the rule. The record-path
 * estimate quotes the same predicate (C-2, one pricing truth).
 *
 * DIRECTION. The rule is about the PAYER of a fee. `receive` is the one act whose counterparty is
 * the party that SENT the value (`receive-authorship.ts`,), so a `receive` FROM a Provian
 * wallet (Provian paying someone) is not a fee and is NOT touched here: it stays under the
 * unchanged receive-authorship gate (a stranger's transfer records only; one from a counterparty
 * the recipient has dealt with mints). Provian decides alone whether it ever pays anyone, so no
 * holder can manufacture such a receive. Every other act type is treated as the payer's: a Provian
 * service wallet is never a party to an escrow / promise / job / link, so the default-apply errs
 * only toward not minting (Unknown = Block), never toward a fee buying a mint.
 *
 * THE PAID PE ARCHIVE'S $5 CHARGE (being built in parallel) MUST REUSE THIS MODULE — add its
 * recipient here (or confirm it lands in one already listed, e.g. the treasury), never a second
 * list. Any future Provian fee recipient belongs here for the same reason.
 *
 * MATCHING. EVM addresses compare case-insensitively (`0x` + 40 hex, prefix case-insensitive, as
 * the same-owner fence reads them). Solana addresses are base58 and case-SIGNIFICANT, so they
 * match exactly. Anything else (null, a wallet id, a malformed string) is not a service wallet.
 *
 * NO ECONOMIC VALUE, MATRIX ROW, OR SIGNED TEMPLATE MOVES. `provian_service_fee` is a runtime
 * record_only reason in `monetary-accounting.ts`'s reason list (beside `unsolicited_receive_record_only`
 * and `speech_window_budget_exhausted`), applied through the existing operational override; the
 * action-policy matrix and the signed monetary template are untouched.
 */

import { PROVIAN_TREASURY } from '../config/live-value-recipients';
import { PROVIAN_SOLANA_TREASURY, PROVIAN_SOLANA_USDC_FEE_ACCOUNT } from '../swap/swap-fees';
import {
  FACILITATOR_BASE_GAS_ADDRESS_DEFAULT,
  FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT,
  facilitatorBaseGasAddress,
  facilitatorSolanaFeeWallet,
  facilitatorSolanaGasAddress,
} from './x402-facilitator-settlement';

/** The sealed `record_only` reason for an act whose counterparty is a Provian service wallet. */
export const PROVIAN_SERVICE_FEE_REASON_CODE = 'provian_service_fee' as const;

/**
 * The on-demand payout's Base gas EOA (; key `PAYOUT_BASE_GAS_KEY`, Secret Manager
 * `payout-base-gas-key`). Recorded in full in `docs/wp-runs/ACTIVE_RUN.md` (2026-10-04 18:56Z);
 * its EIP-55 checksum verifies. Never derived from the secret. `PAYOUT_BASE_GAS_ADDRESS` (env) adds
 * a rotated successor without a code change.
 */
export const PAYOUT_BASE_GAS_ADDRESS = '0x35f96e1aba3e500425135379b775e02e84ad4351';

/**
 * The pinned EVM service wallets, by why each is Provian's. Lowercased. Every one is pinned so a
 * misconfigured or unset env can never drop a wallet from the fence; env values only ADD.
 */
export const PROVIAN_SERVICE_WALLETS_EVM: ReadonlyMap<string, string> = new Map([
  [PROVIAN_TREASURY, 'Provian treasury / revenue wallet (Base): kernel + institution fee wallet, EVM swap-fee recipient, payout-fee recipient'],
  [FACILITATOR_BASE_GAS_ADDRESS_DEFAULT, 'x402 facilitator Base gas EOA: receives the seller\'s fee leg inside every settler transaction'],
  [PAYOUT_BASE_GAS_ADDRESS, 'on-demand payout Base gas EOA (pays gas for the $1 charge and the payee\'s settlement)'],
]);

/** The pinned Solana service wallets (base58, exact), by why each is Provian's. */
export const PROVIAN_SERVICE_WALLETS_SOLANA: ReadonlyMap<string, string> = new Map([
  [FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT, 'x402 facilitator Solana fee + gas wallet'],
  [PROVIAN_SOLANA_TREASURY, 'Provian Solana treasury / swap-fee wallet'],
  [PROVIAN_SOLANA_USDC_FEE_ACCOUNT, 'the Solana treasury\'s USDC token account (Jupiter / LI.FI fee account)'],
]);

type Env = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

const EVM_ADDRESS = /^0[xX][0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function evmOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return EVM_ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null;
}

function solanaOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SOLANA_ADDRESS.test(trimmed) ? trimmed : null;
}

/**
 * Every Provian service wallet under `env`: the pinned set plus whatever the facilitator and payout
 * configuration currently names (an env override moves where a fee lands, so the fence follows it).
 */
export function provianServiceWallets(env: Env = process.env): {
  readonly evm: ReadonlySet<string>;
  readonly solana: ReadonlySet<string>;
} {
  const evm = new Set<string>(PROVIAN_SERVICE_WALLETS_EVM.keys());
  const solana = new Set<string>(PROVIAN_SERVICE_WALLETS_SOLANA.keys());
  for (const value of [facilitatorBaseGasAddress(env), evmOf(env.PAYOUT_BASE_GAS_ADDRESS)]) {
    if (value !== null) evm.add(value);
  }
  for (const value of [facilitatorSolanaFeeWallet(env), facilitatorSolanaGasAddress(env)]) {
    const address = solanaOf(value);
    if (address !== null) solana.add(address);
  }
  return { evm, solana };
}

/** Is `address` one of Provian's own fee / gas / revenue wallets? Unknown or malformed → false. */
export function isProvianServiceWallet(address: unknown, env: Env = process.env): boolean {
  if (typeof address !== 'string') return false;
  const wallets = provianServiceWallets(env);
  const evm = evmOf(address);
  if (evm !== null) return wallets.evm.has(evm);
  const solana = solanaOf(address);
  return solana !== null && wallets.solana.has(solana);
}

/**
 * The act types whose counterparty SENT the value to the actor — never the payer of a fee. Only
 * `receive` (the one financial act whose triggering act belongs to the counterparty).
 */
export const PROVIAN_SERVICE_FEE_EXEMPT_ACTION_TYPES: ReadonlySet<string> = new Set(['receive']);

/**
 * Does the invariant: seal this act `record_only`? True when the counterparty is a
 * Provian service wallet and the act is not one whose counterparty paid the actor.
 */
export function provianServiceFeeApplies(
  actionType: string,
  counterpartyAddress: unknown,
  env: Env = process.env,
): boolean {
  if (PROVIAN_SERVICE_FEE_EXEMPT_ACTION_TYPES.has(actionType)) return false;
  return isProvianServiceWallet(counterpartyAddress, env);
}
