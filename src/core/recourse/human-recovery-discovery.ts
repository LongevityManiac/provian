import { readContinuedRestorationStatus } from './restoration-ticket';
import { sha256, toUtf8Bytes } from 'ethers';
import { bytesToHex } from '@noble/hashes/utils';
import { readOwnerChainState, verifyOwnerOperationReceipt, type OwnerChainNetwork } from './owner-chain';
import { discoverHumanIdentityHistory, discoverHistoricalCurveGeneration } from './human-break-history';
import { humanBreakKey, humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { requestHumanRecoveryData } from './human-private-recovery';
import { parseRecoveryOwnerOperation, parseRestorationScope, type RestorationScope, type RecoveryOwnerOperation } from './owner-operation';
import { recoverySigningRoot, recoveryCommitment } from './hash-authorization';
import { discoverHashAccount } from './hash-account-deployment';
import { deriveHumanAccount } from './human-account';
import type { HumanReplacementAccount } from './human-replacement-account';

export interface ContinuedHumanLoss { readonly restoration: RestorationScope; readonly transactionHash: string; readonly block: number; }
export interface DiscoveredHumanRecovery {
  readonly completedRequestId?: string; readonly continuedLosses?: readonly ContinuedHumanLoss[];
  readonly identity: string; readonly operation: RecoveryOwnerOperation; readonly transactionHash: string;
  readonly lossTransaction?: string; readonly lossBlock?: number;
  readonly legacyGeneration: number; readonly replacement?: HumanReplacementAccount;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('recourse_owner_discovery_invalid');
  return value as Record<string, unknown>;
}
function lossOccurrence(identity: string, scope: RestorationScope, raw: unknown): { transactionHash: string; block: number } {
  if (typeof raw !== 'string' || sha256(toUtf8Bytes(raw)) !== scope.lossHash) throw Error('recourse_owner_discovery_loss_changed');
  const snapshot = object(object(JSON.parse(raw)).snapshot);
  if (snapshot.identity !== identity || snapshot.occurrence !== scope.request || snapshot.lossAtomic !== scope.maximumLoss
    || typeof snapshot.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(snapshot.transactionHash)
    || typeof snapshot.block !== 'number' || !Number.isSafeInteger(snapshot.block) || snapshot.block < 1) throw Error('recourse_owner_discovery_loss_changed');
  return { transactionHash: snapshot.transactionHash, block: snapshot.block };
}
/** Private historical evidence only names candidates. Current independently
 * verified chain state decides whether a bounded authorization survived. */
export async function discoverHumanRestorationHistory(mnemonic: string, identity: string, generation: number,
  network: OwnerChainNetwork): Promise<ContinuedHumanLoss[]> {
  const response = object(await requestHumanRecoveryData(mnemonic, identity, generation, `restoration-history/${identity}`));
  if (response.identity !== identity || !Array.isArray(response.candidates)) throw Error('recourse_owner_discovery_invalid');
  const owner = await readOwnerChainState(identity, network), retained: ContinuedHumanLoss[] = [], seen = new Set<string>();
  for (const value of response.candidates) {
    const row = object(value), restoration = parseRestorationScope(row.scope), loss = lossOccurrence(identity, restoration, row.evidence);
    if (seen.has(restoration.request)) throw Error('recourse_owner_discovery_ambiguous');
    seen.add(restoration.request);
    if (await readContinuedRestorationStatus(identity, owner.destination, restoration, network) !== 'absent') {
      retained.push({ restoration, ...loss });
    }
  }
  return retained;
}
/** A relay candidate cannot choose an address, recovery authority or signing
 * selector. The original backup and independent chain receipts fix all three. */
export async function discoverPendingHumanRecovery(mnemonic: string, network: OwnerChainNetwork): Promise<DiscoveredHumanRecovery | null> {
  const history = await discoverHumanIdentityHistory(mnemonic, network);
  if (!history) return null;
  const owner = await readOwnerChainState(history.identity, network), origin = history.points[0].breakOrigin;
  const afterBreak = !/^0x0{40}$/.test(origin);
  // The initial free break restoration has its own entitlement and receipt path.
  if (owner.nonce === 0 || (afterBreak && owner.nonce === 1)) return null;
  const legacyGeneration = await discoverHistoricalCurveGeneration(mnemonic, history, network);
  const response = object(await requestHumanRecoveryData(mnemonic, history.identity, legacyGeneration,
    `owner-recovery-state/${history.identity}/${owner.nonce - 1}`));
  if (response.identity !== history.identity || response.nonce !== owner.nonce - 1 || !Array.isArray(response.candidates)
    || typeof response.relayCommitment !== 'string' || !/^0x[0-9a-f]{64}$/.test(response.relayCommitment)) throw Error('recourse_owner_discovery_invalid');
  const derive = (purpose: 'recovery-secret' | 'recovery-signing', nonce: number) => afterBreak
    ? humanBreakKey(mnemonic, { identity: history.identity, breakOrigin: origin, chainId: '8453' }, purpose, String(nonce))
    : (purpose === 'recovery-secret' ? humanRecoverySecret : humanRecoverySigningSeed)(mnemonic, nonce, history.identity);
  const secret = derive('recovery-secret', owner.nonce - 1), seed = derive('recovery-signing', owner.nonce - 1);
  const nextSecret = derive('recovery-secret', owner.nonce), nextSeed = derive('recovery-signing', owner.nonce);
  try {
    const signingRoot = await recoverySigningRoot(seed), nextRoot = await recoverySigningRoot(nextSeed);
    if (nextRoot !== owner.signingRoot || recoveryCommitment(nextSecret, nextRoot) !== owner.commitment) throw Error('recourse_backup_commitment_mismatch');
    let replacement: HumanReplacementAccount | undefined;
    if (afterBreak) {
      const accountGeneration = String(owner.nonce), base = { identity: history.identity, breakOrigin: origin, chainId: '8453', accountGeneration };
      const spendingSeed = humanBreakKey(mnemonic, base, 'spending', '0');
      try {
        const initialRoot = await recoverySigningRoot(spendingSeed), account = await discoverHashAccount(initialRoot, network, origin);
        if (!account.deployed || account.account !== owner.destination || account.manifestHash !== owner.deployment.manifestHash) throw Error('recourse_backup_destination_mismatch');
        replacement = { identity: history.identity, breakOrigin: origin, nonce: owner.nonce - 1, account: account.account, initialRoot, accountGeneration };
      } finally { spendingSeed.fill(0); }
    } else if ((await deriveHumanAccount(mnemonic, owner.nonce)).evm !== owner.destination) throw Error('recourse_backup_destination_mismatch');
    let found: DiscoveredHumanRecovery | null = null;
    for (const raw of response.candidates) {
      const candidate = object(raw), operation = parseRecoveryOwnerOperation(candidate.operation);
      if (operation.identity !== history.identity || operation.nonce !== owner.nonce - 1 || operation.destination !== owner.destination
        || operation.proof.signingRoot !== signingRoot || operation.proof.recoverySecret !== `0x${bytesToHex(secret)}`
        || operation.proof.nextCommitment !== owner.commitment || operation.proof.nextSigningRoot !== nextRoot) continue;
      let lossTransaction: string | undefined, lossBlock: number | undefined;
      if (operation.restoration) {
        const loss = lossOccurrence(history.identity, operation.restoration, candidate.restorationEvidence);
        lossTransaction = loss.transactionHash; lossBlock = loss.block;
      }
      if (typeof candidate.transactionHash !== 'string') throw Error('recourse_owner_discovery_invalid');
      await verifyOwnerOperationReceipt(operation, candidate.transactionHash, network);
      const continuedLosses: ContinuedHumanLoss[] = [];
      if (candidate.continuations !== undefined) {
        if (!Array.isArray(candidate.continuations)) throw Error('recourse_owner_discovery_invalid');
        for (const value of candidate.continuations) {
          const row = object(value), restoration = parseRestorationScope(row.scope);
          const loss = lossOccurrence(history.identity, restoration, row.evidence);
          if (await readContinuedRestorationStatus(history.identity, owner.destination, restoration, network) === 'absent') {
            throw Error('recourse_restoration_ticket_changed');
          }
          if (continuedLosses.some(prior => prior.restoration.request === restoration.request)) throw Error('recourse_owner_discovery_ambiguous');
          continuedLosses.push({ restoration, ...loss });
        }
      }
      let completedRequestId: string | undefined;
      if (response.relayCommitment === owner.commitment) {
        if (typeof candidate.completedRequestId !== 'string' || !/^0x[0-9a-f]{64}$/.test(candidate.completedRequestId)) throw Error('recourse_owner_discovery_recovery_missing');
        completedRequestId = candidate.completedRequestId;
      } else if (candidate.completedRequestId !== undefined) throw Error('recourse_owner_discovery_recovery_changed');
      if (found) throw Error('recourse_owner_discovery_ambiguous');
      found = { identity: history.identity, operation, transactionHash: candidate.transactionHash, legacyGeneration, ...(completedRequestId ? { completedRequestId } : {}), ...(continuedLosses.length ? { continuedLosses } : {}), ...(lossTransaction === undefined ? {} : { lossTransaction, lossBlock }),
        ...(replacement ? { replacement } : {}) };
    }
    if (!found) throw Error('recourse_pending_recovery_unavailable');
    return found;
  } finally { secret.fill(0); seed.fill(0); nextSecret.fill(0); nextSeed.fill(0); }
}
