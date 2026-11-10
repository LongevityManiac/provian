#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { provisionBreakRecovery, prepareAgentBreakRecovery, completeAgentBreakRecovery, recoverAgentBreak, prepareActiveHashWalletOperation, completeActiveHashWalletOperation, cancelActiveHashWalletOperation, pendingActiveHashWalletOperations } from '../break-recovery-store';
import { ownerChainNetwork } from '../protocol-runtime';
import { readLocalKeystoreSecret } from '../local-keystore-secret';
import { hashAccountCall } from '../hash-account';
import type { HashWalletCall } from '../break-recovery-store';
import { readBreakRecoveryContext } from '../break-recovery';
import type { BreakOwnerEntitlement } from '../break-recovery';

function savePublicOutput(file: string, value: unknown): void {
  const fd = fs.openSync(path.resolve(file), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') {
    console.log('prepare-break-recovery provision IDENTITY COMMITMENT\nprepare-break-recovery prepare ENTITLEMENT_JSON DESTINATION OUTPUT_JSON\nprepare-break-recovery complete IDENTITY COMMITMENT TRANSACTION_HASH\nprepare-break-recovery account-prepare CALL_JSON OUTPUT_JSON\nprepare-break-recovery account-pending OUTPUT_JSON\nprepare-break-recovery account-cancel OUTPUT_JSON\nprepare-break-recovery account-complete TRANSACTION_HASH\nProvision saves an encrypted hash-account key and prints only its public root. Deploy the matching account, then prepare the authenticated registration or restoration call. Rerun after registration to prepare restoration. Complete independently verifies the finalized restoration and activates the encrypted hash wallet, retaining the old EOA. Calls go to the current executor; restoration needs the independent authority. The provision and prepare commands do not broadcast.');
    console.log('prepare-break-recovery recover ENTITLEMENT_JSON\nRecover runs free deployment and registration, requests the separate authority restoration, verifies its finalized receipt, and activates the encrypted hash wallet. Rerun after interruption. The old wallet and its other assets remain encrypted.');
    return;
  }
  const directory = path.join(homedir(), '.provian');
  const passphrase = readLocalKeystoreSecret(path.join(directory, 'agent-keystore.secret'));
  if (!passphrase) throw Error('break_backup_secret_unavailable');
  if (command === 'recover' && args.length === 1) {
    const input = fs.readFileSync(path.resolve(args[0]), 'utf8');
    if (input.length > 128 * 1024) throw Error('break_recovery_entitlement_invalid');
    const entitlement = JSON.parse(input) as BreakOwnerEntitlement;
    const result = await recoverAgentBreak({ directory, passphrase, entitlement, network:ownerChainNetwork(),
      relayUrl:process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai',
      phase:phase => console.log(JSON.stringify({ phase })) });
    console.log(JSON.stringify({ phase:'hash_wallet_activated', address:result.address, transactionHash:result.transactionHash })); return;
  }
  if (command === 'account-prepare' && args.length === 2) {
    const data = fs.readFileSync(path.resolve(args[0]), 'utf8');
    if (data.length > 128 * 1024) throw Error('hash_wallet_call_invalid');
    const call = JSON.parse(data) as HashWalletCall;
    const operation = await prepareActiveHashWalletOperation({ directory, passphrase, network: ownerChainNetwork(), call });
    savePublicOutput(args[1], { operation, transaction: { chainId: '8453', to: operation.account, value: '0', data: hashAccountCall(operation) } });
    console.log(JSON.stringify({ phase: 'hash_operation_prepared', broadcast: false })); return;
  }
  if (command === 'account-pending' && args.length === 1) {
    savePublicOutput(args[0], await pendingActiveHashWalletOperations({ directory, passphrase }));
    console.log(JSON.stringify({ phase: 'pending_operations_saved', broadcast: false })); return;
  }
  if (command === 'account-cancel' && args.length === 1) {
    const operation = await cancelActiveHashWalletOperation({ directory, passphrase, network: ownerChainNetwork() });
    savePublicOutput(args[0], { operation, transaction: { chainId: '8453', to: operation.account, value: '0', data: hashAccountCall(operation) } });
    console.log(JSON.stringify({ phase: 'cancellation_prepared', broadcast: false, originalMayStillExecute: true })); return;
  }
  if (command === 'account-complete' && args.length === 1) {
    const outcome = await completeActiveHashWalletOperation({ directory, passphrase, network: ownerChainNetwork(), transactionHash: args[0] });
    console.log(JSON.stringify({ phase: 'hash_operation_confirmed', outcome })); return;
  }
  if (command === 'provision' && args.length === 2) {
    const result = await provisionBreakRecovery({ directory, passphrase, identity: args[0], commitment: args[1], context: await readBreakRecoveryContext(ownerChainNetwork()) });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'complete' && args.length === 3) {
    console.log(JSON.stringify(await completeAgentBreakRecovery({ directory, passphrase, identity: args[0], commitment: args[1], transactionHash: args[2], network: ownerChainNetwork() })));
    return;
  }
  if (command !== 'prepare' || args.length !== 3) throw Error('break_recovery_usage');
  const input = fs.readFileSync(path.resolve(args[0]), 'utf8');
  if (input.length > 128 * 1024) throw Error('break_recovery_entitlement_invalid');
  const entitlement = JSON.parse(input) as BreakOwnerEntitlement;
  const result = await prepareAgentBreakRecovery({ directory, passphrase, entitlement, destination: args[1].toLowerCase(), network: ownerChainNetwork() });
  // The output deliberately contains a consumed/revealed recovery preimage,
  // never the independent signing seeds or the encrypted-backup password.
  const fd = fs.openSync(path.resolve(args[2]), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(result, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  console.log(JSON.stringify({ phase: result.phase, destination: result.destination, amount: result.amount, broadcast: false }));
}
void main().catch(() => {
  console.error('Break recovery did not finish. Encrypted backups and pending operations remain in place. Rerun to reconcile the chain and resume.');
  process.exitCode = 1;
});
