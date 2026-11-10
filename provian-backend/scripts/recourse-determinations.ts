#!/usr/bin/env tsx
import { readFile, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Interface, Wallet } from 'ethers';
import { scriptDb } from './lib/script-db';
import { resolveDeployerSigner } from './lib/deployer-signer';
import { currentProtocolDeployment } from '../src/core/protocol/runtime';
import { getOperatorBoundRpcLegs } from '../src/core/onchain/rpc-provider';
import { prepareDetermination, assessRestoration, type RestorationJudgment } from '../src/core/recourse/determination';
import { queueDetermination, runDeterminationWorkflow } from '../src/core/recourse/determination-workflow';
import { createDeterminationWorkflowPort } from '../src/core/recourse/determination-runtime';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw Error('recourse_operator_argument_missing');
  return value;
}
async function main(): Promise<void> {
  const command = process.argv[2], db = scriptDb();
  if (command === 'prepare') {
    const packet = await prepareDetermination(db, option('--request'));
    // Evidence only: no secret, signed owner proof or signing key is included.
    await writeFile(option('--out'), JSON.stringify(packet, null, 2) + '\n', {mode:0o600, flag:'wx'});
    process.stdout.write(JSON.stringify({request:packet.request,checkpointBlock:packet.evidence.checkpoint.block,packetHash:packet.packetHash})+'\n');
    return;
  }
  if (command === 'queue') {
    const checkpoint = Number(option('--checkpoint'));
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 1) throw Error('recourse_operator_checkpoint_invalid');
    const packet = await prepareDetermination(db, option('--request'), undefined, checkpoint);
    const judgment: unknown = JSON.parse(await readFile(option('--judgment'), 'utf8'));
    if (!judgment || typeof judgment !== 'object') throw Error('recourse_determination_judgment_invalid');
    await queueDetermination(db, assessRestoration(packet, judgment as RestorationJudgment));
    process.stdout.write(JSON.stringify({request:packet.request,status:'queued'})+'\n');
    return;
  }
  if (command !== 'run' || !process.argv.includes('--execute')) throw Error('recourse_operator_execution_required');
  const deployment = await currentProtocolDeployment();
  const abi = new Interface(['function restorationAuthority() view returns(address)']);
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [
    {to:deployment.addresses.kernel,data:abi.encodeFunctionData('restorationAuthority')},
    {blockHash:deployment.blockHash,requireCanonical:true},
  ])));
  if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_execution_rpc_disagreement');
  const expected = String(abi.decodeFunctionResult('restorationAuthority',values[0])[0]).toLowerCase();
  const reference = option('--authority-reference');
  if (!reference.startsWith('op://')) throw Error('recourse_operator_secret_reference_invalid');
  // Capture in process only. The key/phrase is never printed, passed in argv,
  // serialized into the queue, or supplied to the public relay.
  const secret = await promisify(execFile)('op',['read',reference],{encoding:'utf8',maxBuffer:16384});
  const authority = resolveDeployerSigner(secret.stdout,expected);
  if (authority.address.toLowerCase() !== expected) throw Error('recourse_execution_signer_mismatch');
  const gasKey = process.env.PVT9_SETTLEMENT_MINTER_KEY, attestorKey = process.env.PVT9_SETTLEMENT_APPROVER_KEY;
  if (!gasKey || !attestorKey) throw Error('recourse_operator_signers_unavailable');
  const port = createDeterminationWorkflowPort(db,{authority,gas:new Wallet(gasKey),attestor:new Wallet(attestorKey)});
  do {
    const result = await runDeterminationWorkflow(db,port);
    process.stdout.write(JSON.stringify(result)+'\n');
    if (!process.argv.includes('--watch')) return;
    await new Promise<void>(resolve=>setTimeout(resolve,5000));
  } while (true);
}
void main().catch(error => {
  const code = error instanceof Error && /^recourse_[a-z_]+$/.test(error.message) ? error.message : 'recourse_operator_failed';
  process.stderr.write(code+'\n');process.exitCode=1;
});
