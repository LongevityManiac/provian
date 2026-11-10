import { readOwnerChainState, type OwnerChainNetwork } from './recourse-owner-chain';
import { BREAK_RECOVERY_ABI, readBreakRecoveryContext, type PreparedBreakRecovery } from './break-recovery';
import { prepareHashAccountDeployment } from './hash-account-deployment';
import { parseBreakDeploymentRequest, breakDeploymentDigest, type BreakDeploymentRequest } from './break-deployment-data';
import { breakRegistrationId } from './break-registration-data';
import { parseBreakRestorationRequest, breakRestorationId, breakRestorationDetails } from './break-restoration-data';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';

export interface FreeBreakRecoveryTransport { request(path: string, body?: unknown): Promise<unknown>; }
export type FreeBreakRecoveryPhase = 'deploying_account' | 'registering_recovery' | 'awaiting_restoration' | 'verifying_restoration';
interface Status { id: string; status: string; transactionHash: string | null; }
function status(value: unknown, id: string, allowed: readonly string[]): Status {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_recovery_status_invalid');
  const row = value as Record<string, unknown>;
  if (row.id !== id || typeof row.status !== 'string' || !allowed.includes(row.status)
    || (row.transactionHash !== null && (typeof row.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.transactionHash)))) throw Error('break_recovery_status_invalid');
  return { id, status:row.status, transactionHash:row.transactionHash as string | null };
}
async function wait(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw Error('break_recovery_cancelled');
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Error('break_recovery_cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 2000);
    signal?.addEventListener('abort', abort, { once:true });
    if (signal?.aborted) abort();
  });
}
class ProtocolChanged extends Error {}
/** A failed response from a retired queue is safe to replace only when current
 * chain state proves that the exact owner material remains unconsumed in the
 * same break. A later break is a separate backup/signing domain. */
async function canRenew(prepared: PreparedBreakRecovery, network: OwnerChainNetwork): Promise<boolean> {
  if (!prepared.ownerIntent) return false;
  const request = parseBreakRestorationRequest({kernel:prepared.kernel,ownerIntent:prepared.ownerIntent,data:prepared.data});
  const details = breakRestorationDetails(request), state = await readOwnerChainState(details.identity, network);
  if (state.deployment.addresses.kernel.toLowerCase() === prepared.kernel || state.commitment !== details.commitment
    || state.signingRoot !== details.proof.signingRoot) return false;
  const tag = { blockHash:state.deployment.blockHash,requireCanonical:true };
  const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{to:prepared.executor,
    data:BREAK_RECOVERY_ABI.encodeFunctionData('breakOrigin')},tag])));
  if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('break_recovery_rpc_disagreement');
  const origin = String(BREAK_RECOVERY_ABI.decodeFunctionResult('breakOrigin',values[0])[0]).toLowerCase();
  if (await readBreakRecoveryContext(network) !== origin) throw Error('break_recovery_context_changed');
  if ((await network.deployment()).manifestHash !== state.deployment.manifestHash) throw Error('break_recovery_protocol_changed');
  return true;
}
/** Runs free account deployment, snapshot registration and separately authorized
 * restoration. Each preparation callback retains its material durably before
 * publishing. Relay status never substitutes for independent chain evidence. */
export async function recoverFreeBreak(input: {
  network: OwnerChainNetwork; transport: FreeBreakRecoveryTransport; signal?: AbortSignal;
  prepareDeployment(): Promise<BreakDeploymentRequest>;
  prepareRecovery(destination: string): Promise<PreparedBreakRecovery>;
  pendingRestoration?(): Promise<PreparedBreakRecovery | null>;
  phase?(phase: FreeBreakRecoveryPhase): void;
}): Promise<{ prepared: PreparedBreakRecovery; transactionHash: string }> {
  const checkCancelled = () => { if (input.signal?.aborted) throw Error('break_recovery_cancelled'); };
  const finish = async (prepared: PreparedBreakRecovery, reply: Status) => {
    if (!reply.transactionHash) throw Error('break_recovery_receipt_missing');
    input.phase?.('verifying_restoration');
    await verifyBreakRecoveryReceipt(prepared, reply.transactionHash, input.network);
    return { prepared, transactionHash:reply.transactionHash };
  };
  const waitFor = async (path: string, id: string, body: unknown, kernel?: string): Promise<Status> => {
    const allowed = path === 'break-restorations' ? ['awaiting_authority','submitted','confirmed'] : ['queued','submitted','confirmed','failed'];
    let reply = status(await input.transport.request(path, body), id, allowed);
    while (reply.status !== 'confirmed') {
      checkCancelled();
      if (kernel && (await input.network.deployment()).addresses.kernel.toLowerCase() !== kernel) {
        reply = status(await input.transport.request(`${path}/${id}`), id, allowed);
        if (reply.status === 'confirmed') return reply;
        throw new ProtocolChanged();
      }
      await wait(input.signal);
      reply = reply.status === 'failed'
        ? status(await input.transport.request(path, body), id, allowed)
        : status(await input.transport.request(`${path}/${id}`), id, allowed);
    }
    return reply;
  };
  let pending = await input.pendingRestoration?.() ?? null;
  while (pending?.phase === 'restore_balance' && pending.ownerIntent) {
    const request = parseBreakRestorationRequest({ kernel:pending.kernel, ownerIntent:pending.ownerIntent, data:pending.data });
    const id = breakRestorationId(request);
    try {
      input.phase?.('awaiting_restoration');
      return finish(pending, await waitFor('break-restorations', id, request, pending.kernel));
    } catch (error) {
      if (await canRenew(pending,input.network)) pending = null;
      else if (error instanceof ProtocolChanged) await wait(input.signal);
      else throw error;
    }
  }
  checkCancelled(); input.phase?.('deploying_account');
  const deployment = parseBreakDeploymentRequest(await input.prepareDeployment());
  await waitFor('break-deployments', breakDeploymentDigest(deployment), deployment);
  const account = await prepareHashAccountDeployment(deployment.initialRoot, input.network, deployment.breakOrigin);
  if (!account.deployed || account.account !== deployment.account || account.factory !== deployment.factory) throw Error('break_recovery_deployment_unverified');
  while (true) {
    checkCancelled();
    if (pending?.ownerIntent) {
      const previous = pending;
      const request = parseBreakRestorationRequest({ kernel:pending.kernel, ownerIntent:pending.ownerIntent, data:pending.data });
      try {
        const reply = status(await input.transport.request(`break-restorations/${breakRestorationId(request)}`), breakRestorationId(request), ['awaiting_authority','submitted','confirmed']);
        if (reply.status === 'confirmed') return finish(pending, reply);
        if (await canRenew(pending,input.network)) pending = null;
        else { await wait(input.signal); continue; }
      } catch (error) {
        if (!await canRenew(previous,input.network)) throw error;
        pending = null;
      }
    }
    try {
      let prepared = await input.prepareRecovery(account.account);
      if (prepared.identity !== deployment.identity || prepared.destination !== account.account) throw Error('break_recovery_preparation_changed');
      if (prepared.phase === 'register_owner') {
        input.phase?.('registering_recovery');
        const request = { deployment, kernel:prepared.kernel };
        await waitFor('break-registrations', breakRegistrationId(request), request, prepared.kernel);
        prepared = await input.prepareRecovery(account.account);
        if (prepared.phase !== 'restore_balance') throw Error('break_recovery_registration_unverified');
      }
      if (prepared.identity !== deployment.identity || prepared.destination !== account.account || !prepared.ownerIntent) throw Error('break_recovery_preparation_changed');
      input.phase?.('awaiting_restoration'); pending = prepared;
      const request = parseBreakRestorationRequest({ kernel:prepared.kernel, ownerIntent:prepared.ownerIntent, data:prepared.data });
      return finish(prepared, await waitFor('break-restorations', breakRestorationId(request), request, prepared.kernel));
    } catch (error) {
      if (!(error instanceof ProtocolChanged)) throw error;
      if (pending && await canRenew(pending,input.network)) pending = null;
      else await wait(input.signal);
      // Ordinary succession retires the former executor. Retain the destination
      // and replacement material and obtain a fresh owner intent for the current
      // kernel; first check whether the former intent already executed.
    }
  }
}
