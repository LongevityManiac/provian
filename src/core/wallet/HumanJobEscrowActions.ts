import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * HumanJobEscrowActions — the three escrow acts a job party signs with their OWN key.
 *
 * release releaseEscrow(bytes32) the payer pays the hired party (any time while
 * Funded); after auto-release anyone may call it.
 * dispute disputeEscrow(bytes32) the payer (depositor only) freezes a Funded escrow
 * before auto-release; the escrow admin then resolves
 * it, or after the dispute timeout the payer takes
 * the refund.
 * claim_refund claimDisputeTimeout(bytes32) permissionless once the dispute timeout passes —
 * refunds the depositor, never anyone else.
 *
 * Each act reads the escrow's on-chain status FIRST, so a tap never sends a transaction the
 * contract would revert, and an act that already happened on-chain (a release the relay has not
 * observed yet) is reported as done instead of being sent twice. Everything is checked before the
 * first transaction; the relay is told afterwards and re-verifies on-chain.
 *
 * Non-custodial, first-party: the key is the person's own SeedManager key, behind one biometric
 * session, after an on-screen review in the job screen (pitfall #13 carve-out — the owner acting on
 * their own escrow, not a dApp request).
 */

import { ethers } from 'ethers';
import { assertWalletEnabled } from '../AppModeManager';
import SeedManager from './SeedManager';
import TransactionService from './TransactionService';
import { escrowChainId, sendCallsInOrder, type OwnKeySigner } from './HumanJobEscrowFunder';
import { JOB_ESCROW_V4 } from '../chains/evm/config';

const ESCROW_ACTIONS_ABI = [
  'function releaseEscrow(bytes32 escrowId)',
  'function disputeEscrow(bytes32 escrowId)',
  'function claimDisputeTimeout(bytes32 escrowId)',
  'function escrows(bytes32 escrowId) view returns (address depositor, address recipient, uint256 amount, uint256 fee, uint256 autoReleaseAt, uint8 status, uint8 currency, bool feePaidInPVT)',
] as const;

/** ProvianEscrowV4 `Status` enum. */
export const ONCHAIN_ESCROW_STATUS = {
  Created: 0,
  Funded: 1,
  Completed: 2,
  Disputed: 3,
  Resolved: 4,
  Cancelled: 5,
} as const;

export type EscrowAction = 'release' | 'dispute' | 'claim_refund';

const FUNCTION_OF: Record<EscrowAction, 'releaseEscrow' | 'disputeEscrow' | 'claimDisputeTimeout'> = {
  release: 'releaseEscrow',
  dispute: 'disputeEscrow',
  claim_refund: 'claimDisputeTimeout',
};

/** The escrow fields an act needs (a subset of `GET /v1/commons/jobs/:id/escrow`). */
export interface EscrowActionTarget {
  contract_address: string;
  onchain_escrow_id?: string | null;
  chain: string;
  depositor_address: string;
}

/** Why an act was refused before anything was sent. The screen maps each code to plain words. */
export type EscrowActionErrorCode =
  | 'no_onchain_id'
  | 'bad_contract'
  | 'not_depositor'
  | 'not_funded'
  | 'auto_release_passed'
  | 'auto_release_not_reached'
  | 'not_disputed';

export class EscrowActionError extends Error {
  readonly code: EscrowActionErrorCode;
  constructor(code: EscrowActionErrorCode, message: string) {
    super(message);
    this.name = 'EscrowActionError';
    this.code = code;
  }
}

export interface EscrowActionCall {
  label: EscrowAction;
  to: string;
  data: string;
  chainId: number;
  onchainEscrowId: string;
}

/** PURE: the one unsigned call for an act. Throws EscrowActionError on an unusable target. */
export function buildEscrowActionCall(action: EscrowAction, target: EscrowActionTarget): EscrowActionCall {
  const id = target.onchain_escrow_id ?? '';
  if (!ethers.isHexString(id, 32)) {
    throw new EscrowActionError('no_onchain_id', 'This escrow has no on-chain id yet (it has not been funded).');
  }
  if (!ethers.isAddress(target.contract_address)) {
    throw new EscrowActionError('bad_contract', 'The escrow contract address is not valid.');
  }
  // reviewer: act only on the pinned escrow, never on a contract the relay names.
  if (target.contract_address.toLowerCase() !== JOB_ESCROW_V4.address.toLowerCase()) {
    throw new EscrowActionError('bad_contract', `This app only acts on the escrow at ${JOB_ESCROW_V4.address}.`);
  }
  const iface = new ethers.Interface(ESCROW_ACTIONS_ABI);
  return {
    label: action,
    to: target.contract_address,
    data: iface.encodeFunctionData(FUNCTION_OF[action], [id]),
    chainId: escrowChainId(target.chain),
    onchainEscrowId: id,
  };
}

/** The on-chain facts the preconditions read. */
export interface OnchainEscrowState {
  depositor: string;
  status: number;
  /** Seconds. */
  autoReleaseAt: bigint;
}

export type EscrowStateReader = (contract: string, onchainEscrowId: string) => Promise<OnchainEscrowState>;

/**
 * PURE: decide, from the on-chain state, whether to send the act, skip it (already done), or
 * refuse. `nowSec` is the phone's clock; the contract re-checks against block time, and a refusal
 * here only ever errs toward NOT sending.
 */
export function checkEscrowActionPreconditions(
  action: EscrowAction,
  signerAddress: string,
  state: OnchainEscrowState,
  nowSec: number,
): { send: true } | { send: false; alreadyDone: true } {
  const isDepositor = signerAddress.toLowerCase() === state.depositor.toLowerCase();
  const beforeAutoRelease = BigInt(Math.floor(nowSec)) < state.autoReleaseAt;
  switch (action) {
    case 'release':
      if (state.status === ONCHAIN_ESCROW_STATUS.Completed) return { send: false, alreadyDone: true };
      if (state.status !== ONCHAIN_ESCROW_STATUS.Funded) {
        throw new EscrowActionError('not_funded', 'The escrow is not funded, so there is nothing to release.');
      }
      if (!isDepositor && beforeAutoRelease) {
        throw new EscrowActionError('not_depositor', 'Only the payer can release before the auto-release date.');
      }
      return { send: true };
    case 'dispute':
      if (!isDepositor) {
        throw new EscrowActionError('not_depositor', 'Only the payer can dispute this escrow.');
      }
      if (state.status === ONCHAIN_ESCROW_STATUS.Disputed) return { send: false, alreadyDone: true };
      if (state.status !== ONCHAIN_ESCROW_STATUS.Funded) {
        throw new EscrowActionError('not_funded', 'Only a funded escrow can be disputed.');
      }
      if (!beforeAutoRelease) {
        throw new EscrowActionError('auto_release_passed', 'The auto-release date has passed, so this escrow can no longer be disputed.');
      }
      return { send: true };
    case 'claim_refund':
      if (state.status === ONCHAIN_ESCROW_STATUS.Resolved) return { send: false, alreadyDone: true };
      if (state.status !== ONCHAIN_ESCROW_STATUS.Disputed) {
        throw new EscrowActionError('not_disputed', 'This escrow is not in dispute.');
      }
      return { send: true };
    default: {
      const never: never = action;
      throw new Error(`Unknown escrow action ${String(never)}`);
    }
  }
}

export interface EscrowActionResult {
  /** The act's tx hash, or null when it had already happened on-chain (nothing was sent). */
  txHash: string | null;
  alreadyDone: boolean;
  onchainEscrowId: string;
}

/**
 * Run an act with a given signer and chain reader. Every check happens before the send: the
 * target's call is built, the chain status is read, and the preconditions decide.
 */
export async function executeEscrowAction(
  action: EscrowAction,
  target: EscrowActionTarget,
  signer: OwnKeySigner,
  readState: EscrowStateReader,
  nowMs: number,
): Promise<EscrowActionResult> {
  const call = buildEscrowActionCall(action, target);
  // Disputing is the depositor's act alone. The chain check below also refuses, but the relay
  // record already names the payer — fail before any read.
  if (action === 'dispute' && signer.address.toLowerCase() !== target.depositor_address.toLowerCase()) {
    throw new EscrowActionError('not_depositor', 'Only the payer can dispute this escrow.');
  }
  const state = await readState(call.to, call.onchainEscrowId);
  const decision = checkEscrowActionPreconditions(action, signer.address, state, Math.floor(nowMs / 1000));
  if (!decision.send) {
    return { txHash: null, alreadyDone: true, onchainEscrowId: call.onchainEscrowId };
  }
  const hashes = await sendCallsInOrder(signer, [{ label: call.label, to: call.to, data: call.data }]);
  return { txHash: hashes[call.label], alreadyDone: false, onchainEscrowId: call.onchainEscrowId };
}

/** Read an escrow's on-chain state through a provider (the `escrows(bytes32)` getter). */
export function providerStateReader(provider: ethers.Provider): EscrowStateReader {
  return async (contract, onchainEscrowId) => {
    const c = new ethers.Contract(contract, ESCROW_ACTIONS_ABI, provider);
    const r = (await c.escrows(onchainEscrowId)) as unknown as {
      depositor: string;
      status: bigint;
      autoReleaseAt: bigint;
    };
    return { depositor: String(r.depositor), status: Number(r.status), autoReleaseAt: BigInt(r.autoReleaseAt) };
  };
}

/**
 * IMPURE: run an act with the person's own key. One biometric session (the prompt names the act),
 * then the on-chain status read, then at most one transaction, waited to its receipt.
 */
export async function runEscrowActionOnChain(
    action: EscrowAction,
    target: EscrowActionTarget,
    biometricReason: string, biometricAction?: BiometricAction,
): Promise<EscrowActionResult> {
    assertWalletEnabled('runEscrowActionOnChain');
    const call = buildEscrowActionCall(action, target); // validate before prompting
    return await withBiometricAction(biometricReason, async (biometricAction) => {
        assertBiometricAction(biometricAction);
        const provider = TransactionService.providerFor(call.chainId);
        const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
        const wallet = new ActionWallet(privateKey, biometricAction, provider);
        return executeEscrowAction(action, target, wallet, providerStateReader(provider), Date.now());

    }, biometricAction);
}
