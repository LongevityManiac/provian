import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { concat, hashMessage, hexlify, sha256, toUtf8Bytes } from 'ethers';
import { atomicReplacePrivateFile } from './durable-private-file';
import { loadKeystore } from './keystore';
import { readAddressRecoveryBinding } from './recourse-binding-chain';
import { verifyOwnerOperationReceipt } from './recourse-owner-chain';
import { recoverySigningRoot } from './recourse-hash-authorization';
import { readHashAccountState } from './hash-account-chain';
import { signHashAccountMessage } from './hash-account';
import { withAgentHashRecoveryRecord, readActiveHashWallet, type ActiveHashWallet } from './break-recovery-store';
import type { AgentHashReplacementInput, AgentHashReplacementPlan } from './agent-hash-replacement';

export interface AgentHashRecoveryTransport { request(route: string, body?: unknown): Promise<unknown> }

/** The exact finalized owner authorization, plus possession of the fresh hash
 * account, permits the relay credential cut. The old EOA remains untouched. */
export async function recoverAgentHashCredentials(supplied: AgentHashReplacementInput & {
  readonly plan: AgentHashReplacementPlan; readonly transport: AgentHashRecoveryTransport;
}): Promise<{ walletId: string; destination: string; generation: number }> {
  const input = { ...supplied }, plan = { ...supplied.plan };
  const staged = await withAgentHashRecoveryRecord({ ...input, ...plan }, async (record, persist) => {
    const state = record.replacement, operation = state?.operation;
    if (!state || !operation || !state.authorizationTxHash || record.destination !== plan.account
      || operation.destination !== plan.account || operation.nonce !== plan.nonce || operation.identity !== plan.identity) throw Error('hash_replacement_authorization_missing');
    await verifyOwnerOperationReceipt(operation, state.authorizationTxHash, input.network);
    const old = loadKeystore(path.join(input.directory, 'agent-keystore.json'));
    if (!old || await readAddressRecoveryBinding(old.address.toLowerCase(), input.network) !== plan.identity) throw Error('hash_replacement_identity_changed');
    if (!record.credentials) {
      record.credentials = { requestId: hexlify(randomBytes(32)), apiKey: `pvn_live_${randomBytes(16).toString('hex')}`, apiSecret: `pvns_${randomBytes(32).toString('hex')}` };
      persist();
    }
    const credentials = { ...record.credentials };
    if (!/^0x[0-9a-f]{64}$/.test(credentials.requestId) || !/^pvn_live_[0-9a-f]{32}$/.test(credentials.apiKey)
      || !/^pvns_[0-9a-f]{64}$/.test(credentials.apiSecret)) throw Error('hash_replacement_credentials_invalid');
    const seed = Buffer.from((record.accountSigningSeed ?? record.destinationSigningSeed).slice(2), 'hex');
    try {
      const account = await readHashAccountState(plan.account, input.network);
      if (await recoverySigningRoot(seed) !== account.root) throw Error('hash_replacement_spending_changed');
      const active = readActiveHashWallet(input.directory);
      const installed = state.installed && credentials.generation !== undefined && active?.identity === plan.identity
        && active.commitment === plan.commitment && active.context === plan.context && active.address === plan.account
        && active.transactionHash === state.authorizationTxHash;
      const preimage = concat([operation.proof.recoverySecret, operation.proof.signingRoot]), expiresAtMs = Date.now() + 300000;
      const body = { kernel: operation.kernel, identity: plan.identity, preimage, destination: plan.account,
        nextCommitment: operation.proof.nextCommitment, nextSigningRoot: operation.proof.nextSigningRoot,
        authorizationTxHash: state.authorizationTxHash, authorizationNonce: operation.nonce, publicKey: `hash:${plan.account}`,
        apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, requestId: credentials.requestId, expiresAtMs, destinationKind: 'hash' as const };
      const message = ['Provian agent ownership recovery', 'chain:8453', `kernel:${body.kernel}`, `identity:${body.identity}`,
        `recovery:${sha256(preimage)}`, `destination:${body.destination}`, `next:${body.nextCommitment}`, `next-hash-authority:${body.nextSigningRoot}`,
        `public-key:${body.publicKey}`, `credentials:${sha256(toUtf8Bytes(`${credentials.apiKey}:${credentials.apiSecret}`)).slice(2)}`,
        `authorization:${body.authorizationTxHash}`, `authorization-nonce:${body.authorizationNonce}`, `request:${credentials.requestId}`,
        `expires:${expiresAtMs}`, 'destination-signature:hash'].join('\n');
      return { walletId: old.wallet_id, oldAddress: old.address, operation, transactionHash: state.authorizationTxHash, credentials, installed,
        body: { ...body, signature: await signHashAccountMessage(plan.account, hashMessage(message), seed) } };
    } finally { seed.fill(0); }
  });
  if (staged.installed && staged.credentials.generation !== undefined) {
    return { walletId: staged.walletId, destination: plan.account, generation: staged.credentials.generation };
  }
  const result = staged.credentials.generation === undefined ? await input.transport.request('recover-agent', staged.body)
    : { walletId: staged.walletId, destination: plan.account, generation: staged.credentials.generation };
  if (!result || typeof result !== 'object' || !('walletId' in result) || result.walletId !== staged.walletId
    || !('destination' in result) || result.destination !== plan.account || !('generation' in result)
    || typeof result.generation !== 'number' || !Number.isSafeInteger(result.generation) || result.generation < 1) throw Error('hash_replacement_credentials_reply_invalid');
  const generation = result.generation;
  return withAgentHashRecoveryRecord({ ...input, ...plan }, async (record, persist) => {
    const old = loadKeystore(path.join(input.directory, 'agent-keystore.json'));
    if (!old || old.wallet_id !== staged.walletId || old.address !== staged.oldAddress) throw Error('hash_replacement_identity_changed');
    if (!record.credentials || record.credentials.requestId !== staged.credentials.requestId
      || record.credentials.apiKey !== staged.credentials.apiKey || record.credentials.apiSecret !== staged.credentials.apiSecret
      || (record.credentials.generation !== undefined && record.credentials.generation !== generation)
      || JSON.stringify(record.replacement?.operation) !== JSON.stringify(staged.operation)
      || record.replacement?.authorizationTxHash !== staged.transactionHash || record.destination !== plan.account) throw Error('hash_replacement_credentials_changed');
    await verifyOwnerOperationReceipt(staged.operation, staged.transactionHash, input.network);
    const seed = Buffer.from((record.accountSigningSeed ?? record.destinationSigningSeed).slice(2), 'hex');
    try {
      if ((await readHashAccountState(plan.account, input.network)).root !== await recoverySigningRoot(seed)) throw Error('hash_replacement_spending_changed');
    } finally { seed.fill(0); }
    // Save the successful cut before either repeatable local install.
    record.credentials.generation = generation; record.restoredTransaction = staged.transactionHash; persist();
    atomicReplacePrivateFile(path.join(input.directory, 'agent-credentials.json'), JSON.stringify({ wallet_id: staged.walletId,
      address: plan.account, api_key: staged.credentials.apiKey, api_secret: staged.credentials.apiSecret }));
    const active: ActiveHashWallet = { identity: plan.identity, commitment: plan.commitment, context: plan.context,
      address: plan.account, transactionHash: staged.transactionHash };
    atomicReplacePrivateFile(path.join(input.directory, 'active-hash-wallet.json'), JSON.stringify(active));
    if (JSON.stringify(readActiveHashWallet(input.directory)) !== JSON.stringify(active)) throw Error('hash_replacement_activation_readback_failed');
    record.replacement.installed = true; persist();
    return { walletId: staged.walletId, destination: plan.account, generation };
  });
}
