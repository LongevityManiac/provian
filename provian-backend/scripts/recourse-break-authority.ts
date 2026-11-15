#!/usr/bin/env tsx
import { readFile, writeFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Wallet } from 'ethers';
import { scriptDb } from './lib/script-db';
import { breakDeploymentChain } from '../src/core/recourse/break-deployment-queue';
import { BREAK_RESTORATIONS, checkBreakRestoration, reconcileBreakRestoration } from '../src/core/recourse/break-restoration-queue';
import { BREAK_AUTHORITY_EXECUTIONS, assertCheckedBreakAuthority, executeBreakAuthority, queueBreakAuthority, parseBreakAuthorityRequest } from '../src/core/recourse/break-authority-execution';
import { createRecourseGasSigner } from '../src/core/recourse/gas-signer';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../src/core/pvt/settlement/durable-settlement-store';

function option(name: string): string {
  const index = process.argv.indexOf(name), value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw Error('break_authority_argument_missing');
  return value;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw Error('break_authority_rpc_invalid');
  return BigInt(value);
}
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('recourse-break-authority run --request ID --vault VAULT --execute [--watch]\nExecutes only the exact independently verified snapshot restoration. Authority seeds stay in 1Password; the existing settlement signer sponsors gas. Public plans and signatures are retained in private temporary directories for retry review. This command changes the selected live chain only with --execute.\n');
    return;
  }
  if (process.argv[2] !== 'run' || !process.argv.includes('--execute')) throw Error('break_authority_execution_required');
  const id = option('--request'), vault = option('--vault');
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('break_authority_request_invalid');
  const db = scriptDb(), port = breakDeploymentChain(), key = process.env.PVT9_SETTLEMENT_MINTER_KEY;
  if (!key) throw Error('break_authority_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(key), assertCheckedBreakAuthority);
  const executeAttempt = async (execution: string): Promise<{ status: string; execution: string }> => {
    const status = await executeBreakAuthority(db, execution, signer, port);
    if (status !== 'confirmed') return { status, execution };
    // Hash-account success only says its outer nonce was consumed. An inner
    // failure also rotates that key, so only owner-receipt proof completes work.
    const restored = await reconcileBreakRestoration(db, id);
    return { status: restored.status === 'confirmed' ? 'confirmed' : 'authority_call_finalized', execution };
  };
  const once = async (): Promise<{ status: string; execution?: string; directory?: string }> => {
    // Reconcile an already reserved gas nonce before even reading an authority
    // seed. A fulfilled owner request does not release an unresolved gas nonce.
    const pending: unknown = (await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address).get()).get('pending_operation');
    if (typeof pending === 'string') {
      const row = await db.collection(BREAK_AUTHORITY_EXECUTIONS).doc(pending).get();
      if (!row.exists) throw Error('break_authority_signer_busy');
      const status = await executeBreakAuthority(db, pending, signer, port);
      if (status === 'submitted') return { status, execution: pending };
    }
    if ((await reconcileBreakRestoration(db, id)).status === 'confirmed') return { status: 'confirmed' };
    const attempts = await db.collection(BREAK_AUTHORITY_EXECUTIONS).where('request.restoration','==',id).get();
    for (const row of attempts.docs) {
      const status: unknown = row.get('status');
      if (status === 'confirmed') continue;
      if (status === 'failed') {
        try { await queueBreakAuthority(db, parseBreakAuthorityRequest(row.get('request')), port); }
        catch (error) {
          if (error instanceof Error && error.message === 'break_authority_stale') continue;
          throw error;
        }
      }
      return executeAttempt(row.id);
    }
    const row = await db.collection(BREAK_RESTORATIONS).doc(id).get();
    const plan = await checkBreakRestoration(row.get('request'), port);
    if (plan.id !== id) throw Error('break_authority_record_changed');
    const header = await port.agree('eth_getBlockByHash', [plan.blockHash, false]);
    if (!header || typeof header !== 'object' || !('hash' in header) || header.hash !== plan.blockHash
      || !('number' in header)) throw Error('break_authority_rpc_invalid');
    const height = quantity(header.number);
    const estimate = quantity(await port.agree('eth_estimateGas', [{ from: plan.authority, to: plan.executor, data: plan.request.data, value:'0x0' },
      `0x${height.toString(16)}`]));
    const callGas = (estimate * 120n + 99n) / 100n;
    if (callGas <= 0n) throw Error('break_authority_gas_invalid');
    const directory = await mkdtemp(join(tmpdir(), 'provian-break-authority-'));
    const input = join(directory, 'plan.json'), output = join(directory, 'operation.json');
    await writeFile(input, JSON.stringify({ schema: 'provian.hash-authority-plan.v1', account: plan.authority, target: plan.executor,
      currentRoot: plan.authorityRoot, nonce: plan.authorityNonce, targetRuntimeHash: plan.targetRuntimeHash,
      value: '0', callGas: callGas.toString(), data: plan.request.data })+'\n', { flag:'wx', mode:0o600 });
    // The subprocess receives only a vault name and public file paths. It saves
    // the next authority seed durably before exposing the executable signature.
    await promisify(execFile)(process.execPath, [resolve(__dirname,'../../scripts/recourse/hash-authority-cli.mjs'),
      'prepare', vault, input, output], { maxBuffer: 16384 });
    const prepared: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (!prepared || typeof prepared !== 'object' || !('operation' in prepared)) throw Error('break_authority_operation_missing');
    if ((await reconcileBreakRestoration(db, id)).status === 'confirmed') return { status:'confirmed', directory };
    const request = parseBreakAuthorityRequest({ restoration:id, operation:prepared.operation });
    const queued = await queueBreakAuthority(db, request, port);
    return { ...await executeAttempt(queued.id), directory };
  };
  do {
    let result: Awaited<ReturnType<typeof once>>;
    try { result = await once(); }
    catch (error) {
      if (!(error instanceof Error) || !['recourse_authorization_not_finalized','break_authority_signer_busy'].includes(error.message)) throw error;
      result = { status: 'pending_finality_or_signer' };
    }
    process.stdout.write(JSON.stringify({ request:id, ...result })+'\n');
    if (result.status === 'confirmed' || !process.argv.includes('--watch')) return;
    await new Promise<void>(resolve => setTimeout(resolve,5000));
  } while (true);
}
void main().catch(error => {
  process.stderr.write(error instanceof Error && /^(?:break_authority|break_restoration|recourse_sponsor)_[a-z_]+$/.test(error.message)
    ? error.message+'\n' : 'break_authority_execution_incomplete\n'); process.exitCode = 1;
});
