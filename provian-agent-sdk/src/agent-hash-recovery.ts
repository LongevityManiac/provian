import * as path from 'node:path';
import { loadKeystore } from './keystore';
import { loadBoundAgentCredentialsFile } from './scripts/agent-credentials-file';
import { guardedFetcher } from './guarded-fetch';
import { withBoundRecoveryMaterial } from './recourse-agent-credential';
import { privateRecourseEnvelope } from './private-access';
import { readAddressRecoveryBinding } from './recourse-binding-chain';
import { readOwnerChainState, type OwnerChainNetwork } from './recourse-owner-chain';
import { readBreakRecoveryContext } from './break-recovery';
import { BreakRecoverySpendingKeyChanged } from './break-recovery-receipt';
import { listAgentHashReplacements, withAgentHashRecoveryRecord, readAgentBreakEntitlement, recoverAgentBreak, agentInitialBreakNeedsInstall, readActiveHashWallet, retainedAgentRestorations } from './break-recovery-store';
import { prepareAgentHashReplacement, prepareAgentHashReplacementDeployment, type AgentHashReplacementPlan, type AgentHashRestoration } from './agent-hash-replacement';
import { prepareAgentHashOwnerOperation, confirmAgentHashOwnerOperation } from './agent-hash-owner-operation';
import { recoverAgentHashCredentials } from './agent-hash-credentials';
import { accountDeploymentDigest } from './break-deployment-data';
import { parseRestorationScope, recoveryOperationId } from './recourse-owner-operation';
import { discoverHashAccount } from './hash-account-deployment';
import { readContinuedRestorationStatus } from './recourse-restoration-ticket';

interface Input {
  readonly directory: string; readonly passphrase: string; readonly relayUrl: string; readonly network: OwnerChainNetwork;
  readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal; readonly newRecovery?: boolean;
  readonly restoration?: { readonly transactionHash: string; readonly block: number; readonly apiKey: string; readonly apiSecret: string };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('hash_recovery_response_invalid');
  return value as Record<string, unknown>;
}
function status(raw: unknown, id: string): { status: string; transactionHash: string | null } {
  const value = object(raw);
  if (value.id !== id || typeof value.status !== 'string' || !['queued', 'submitted', 'confirmed', 'failed'].includes(value.status)
    || (value.transactionHash !== null && (typeof value.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.transactionHash)))) throw Error('hash_recovery_response_invalid');
  return { status: value.status, transactionHash: value.transactionHash as string | null };
}
async function wait(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Error('hash_recovery_cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 2000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Recover a stolen post-break account using its separate owner authority.
 * Every step resumes from encrypted records; no old spending key is needed. */
export async function recoverHashRecourseAgent(supplied: Input): Promise<{
  walletId: string; destination: string; generation: number; restorationRequestId?: string;
}> {
  const input = { ...supplied, directory: path.resolve(supplied.directory), restoration: supplied.restoration ? { ...supplied.restoration } : undefined };
  const relay = new URL(input.relayUrl);
  if (relay.protocol !== 'https:' || relay.username || relay.password || relay.search || relay.hash) throw Error('hash_recovery_relay_invalid');
  const relayUrl = relay.toString().replace(/\/+$/, '');
  if (input.restoration && (!/^0x[0-9a-f]{64}$/.test(input.restoration.transactionHash)
    || !Number.isSafeInteger(input.restoration.block) || input.restoration.block < 1)) throw Error('hash_recovery_loss_invalid');
  const keystore = loadKeystore(path.join(input.directory, 'agent-keystore.json'));
  if (!keystore || keystore.version !== 2) throw Error('hash_recovery_backup_missing');
  const identity = await readAddressRecoveryBinding(keystore.address.toLowerCase(), input.network), context = await readBreakRecoveryContext(input.network);
  const request = async (route: string, body?: unknown, credential?: { apiKey: string; apiSecret: string }): Promise<unknown> => {
    input.signal?.throwIfAborted();
    const privateRoute = /^(?:break-deployments(?:\/0x[0-9a-f]{64})?|owner-operations\/(?:recovery|0x[0-9a-f]{64}))$/.test(route);
    if (!privateRoute && !['recover-agent', 'restoration-intents', 'restoration-requests'].includes(route)) throw Error('hash_recovery_route_invalid');
    const payload = privateRoute ? await withBoundRecoveryMaterial(keystore, input.passphrase, identity,
      (secret, seed) => privateRecourseEnvelope(identity, secret, seed, route, body ?? null)) : body;
    const response = await guardedFetcher(input.fetch)(`${relayUrl}/v1/recourse/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential.apiKey}:${credential.apiSecret}` } : {}) },
      body: JSON.stringify(payload), signal: input.signal });
    if (!response.ok) throw Error(`hash_recovery_relay_refused_${response.status}`);
    return response.json();
  };
  let current = await readOwnerChainState(identity, input.network);
  let restorationCredentials = input.restoration;
  if (current.nonce === 0 || (current.nonce === 1 && await agentInitialBreakNeedsInstall({ ...input, identity, context,
    commitment: current.commitment, destination: current.destination }))) {
    const entitlement = await readAgentBreakEntitlement(input);
    try {
      const active = await recoverAgentBreak({ ...input, entitlement });
      if (input.restoration) restorationCredentials = await withAgentHashRecoveryRecord({ ...input, ...active }, async record => {
        if (!record.credentials?.generation || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_recovery_install_missing');
        return { ...input.restoration!, apiKey: record.credentials.apiKey, apiSecret: record.credentials.apiSecret };
      });
      if (!input.restoration) return withAgentHashRecoveryRecord({ ...input, ...active }, async record => {
        if (!record.credentials?.generation) throw Error('hash_recovery_install_missing');
        return { walletId: keystore.wallet_id, destination: active.address, generation: record.credentials.generation };
      });
    } catch (error) {
      // The finalized free restoration can precede theft of its new spending
      // key. Its independent recovery generation still authorizes a new account.
      if (!(error instanceof BreakRecoverySpendingKeyChanged)
        && (!(error instanceof Error) || error.message !== 'hash_wallet_reconcile_pending_receipt')) throw error;
      if ((await readOwnerChainState(identity, input.network)).nonce !== 1) throw error;
      if (input.restoration) restorationCredentials = await withAgentHashRecoveryRecord({ ...input, identity, context, commitment: entitlement.commitment }, async record =>
        record.credentials ? { ...input.restoration!, apiKey: record.credentials.apiKey, apiSecret: record.credentials.apiSecret } : input.restoration);
    }
    current = await readOwnerChainState(identity, input.network);
  }
  const candidates = await listAgentHashReplacements({ ...input, identity, context });
  const survivingLosses: AgentHashRestoration[] = [];
  for (const loss of await retainedAgentRestorations({ ...input, identity })) {
    if (await readContinuedRestorationStatus(identity, current.destination, loss.scope, input.network) !== 'absent') survivingLosses.push(loss);
  }
  const requireRetainedLoss = async (destination: string, loss: AgentHashRestoration) => {
    if (await readContinuedRestorationStatus(identity, destination, loss.scope, input.network) === 'absent') throw Error('hash_recovery_ticket_missing');
  };
  const pending = candidates.filter(row => row.plan.commitment === current.commitment && row.plan.nonce === current.nonce && !row.state.installed);
  const consumed = candidates.filter(row => row.state.operation?.proof.nextCommitment === current.commitment
    && row.state.operation.proof.nextSigningRoot === current.signingRoot && row.plan.nonce + 1 === current.nonce && row.plan.account === current.destination);
  if (pending.length > 1 || consumed.length > 1) throw Error('hash_recovery_history_ambiguous');
  const sameLoss = (loss: AgentHashRestoration) => input.restoration?.transactionHash === loss.transactionHash && input.restoration.block === loss.block;
  const prior = pending[0] ?? consumed[0];
  if (prior) for (const loss of survivingLosses) {
    if (prior.state.loss?.scope.request !== loss.scope.request && !(prior.state.continuedLosses ?? []).some(item => item.scope.request === loss.scope.request)) {
      prior.state.continuedLosses = [...(prior.state.continuedLosses ?? []), { ...loss, submitted: false }];
    }
  }
  let plan: AgentHashReplacementPlan | undefined = prior?.plan;
  let inherited: AgentHashRestoration[] = survivingLosses;
  const wantNew = !!(prior?.state.installed && (input.newRecovery || (input.restoration && ![prior.state.loss, ...(prior.state.continuedLosses ?? [])].some(loss => loss && sameLoss(loss)))));
  // A crash may occur after making fresh keys but before copying the preceding
  // bounded rights into their record. Recover that edge from both durable rows.
  if (pending[0] && consumed[0] && pending[0] !== consumed[0]) {
    const predecessor = consumed[0];
    inherited = [predecessor.state.loss, ...(predecessor.state.continuedLosses ?? [])].filter((loss): loss is AgentHashRestoration => !!loss).map(loss => ({ ...loss, submitted: false }));
    await withAgentHashRecoveryRecord({ ...input, ...pending[0].plan }, async (record, persist) => {
      const state = record.replacement!;
      for (const loss of inherited) {
        await requireRetainedLoss(current.destination, loss);
        if (!(state.continuedLosses ?? []).some(item => item.scope.request === loss.scope.request)) {
          state.continuedLosses = [...(state.continuedLosses ?? []), loss];
        }
      }
      persist(); pending[0].state = state;
    });
  }
  if (prior && !prior.state.installed && input.restoration && ![prior.state.loss, ...(prior.state.continuedLosses ?? [])].some(loss => loss && sameLoss(loss))
    && (prior.state.operation || prior.state.ownerIntent)) throw Error('hash_recovery_other_loss_pending');
  const submitLosses = async (selected: AgentHashReplacementPlan): Promise<void> => {
    await withAgentHashRecoveryRecord({ ...input, ...selected }, async (record, persist) => {
      const state = record.replacement, credentials = record.credentials;
      if (!state?.installed || !credentials || credentials.generation === undefined) throw Error('hash_recovery_install_missing');
      for (const loss of [state.loss, ...(state.continuedLosses ?? [])]) {
        if (!loss || loss.submitted) continue;
        const status = await readContinuedRestorationStatus(identity, selected.account, loss.scope, input.network);
        if (status === 'absent') throw Error('hash_recovery_ticket_missing');
        // Latest-head outcomes are observations, not durable completion. Leave
        // this pending locally so every retry revalidates a possible reorg.
        if (status === 'executed') continue;
        const currentCredentials = loadBoundAgentCredentialsFile(path.join(input.directory, 'agent-credentials.json'));
        if (!currentCredentials || currentCredentials.wallet_id !== keystore.wallet_id
          || currentCredentials.address.toLowerCase() !== selected.account) throw Error('hash_recovery_credentials_binding_changed');
        const response = object(await request('restoration-requests', { identity, transactionHash: loss.transactionHash, block: loss.block,
          recoveryRequestId: credentials.requestId, restorationRequestId: loss.scope.request }, { apiKey: currentCredentials.api_key, apiSecret: currentCredentials.api_secret }));
        if (response.requestId !== loss.scope.request || typeof response.status !== 'string' || !response.status) throw Error('hash_recovery_loss_reply_invalid');
        loss.submitted = true; persist();
      }
    });
  };
  if (wantNew && prior) {
    // Preserve the old credential cut's pending loss before retiring its API key.
    await submitLosses(prior.plan);
    inherited = [prior.state.loss, ...(prior.state.continuedLosses ?? [])].filter((loss): loss is AgentHashRestoration => !!loss).map(loss => ({ ...loss, submitted: false }));
    plan = undefined;
  }
  for (;;) {
    input.signal?.throwIfAborted();
    if (await readBreakRecoveryContext(input.network) !== context) throw Error('hash_recovery_context_changed');
    if (!plan) {
      plan = await prepareAgentHashReplacement({ ...input, identity });
      const selected = plan;
      await withAgentHashRecoveryRecord({ ...input, ...selected }, async (record, persist) => {
        if (!record.replacement) throw Error('hash_recovery_state_missing');
        if (inherited.length) {
          for (const loss of inherited) await requireRetainedLoss(record.replacement.sourceAddress, loss);
          record.replacement.continuedLosses = inherited; persist();
        }
      });
    }
    const selected = plan;
    await withAgentHashRecoveryRecord({ ...input, ...selected }, async (record, persist) => {
      const state = record.replacement!;
      for (const loss of survivingLosses) {
        if (state.loss?.scope.request !== loss.scope.request && !(state.continuedLosses ?? []).some(item => item.scope.request === loss.scope.request)) {
          state.continuedLosses = [...(state.continuedLosses ?? []), { ...loss, submitted: false }];
        }
      }
      persist();
    });
    const saved = await withAgentHashRecoveryRecord({ ...input, ...selected }, async record => record.replacement!);
    let loss = saved.loss;
    if (input.restoration && !loss && !(saved.continuedLosses ?? []).some(sameLoss)) {
      const occurrence = { transactionHash: input.restoration.transactionHash, block: input.restoration.block };
      let prepared: unknown;
      try { prepared = await request('restoration-intents', occurrence, restorationCredentials); }
      catch (error) {
        if (!(error instanceof Error) || !/^hash_recovery_relay_refused_(401|403)$/.test(error.message)) throw error;
        // A staged initial cut may not have reached the relay. Its old API
        // credential remains valid until the atomic cut; neither is authority
        // for the owner operation that follows.
        if (restorationCredentials?.apiKey !== input.restoration.apiKey) {
          try { prepared = await request('restoration-intents', occurrence, input.restoration); }
          catch (retry) { if (!(retry instanceof Error) || !/^hash_recovery_relay_refused_(401|403)$/.test(retry.message)) throw retry; }
        }
        if (prepared === undefined) {
        const active = readActiveHashWallet(input.directory), owner = await readOwnerChainState(identity, input.network);
        if (!active || active.identity !== identity || active.context !== context || active.address !== owner.destination) throw error;
        const credential = await withAgentHashRecoveryRecord({ ...input, ...active }, async record => {
          if (!record.credentials?.generation || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw error;
          return { ...record.credentials };
        });
        prepared = await request('restoration-intents', occurrence, credential);
        }
      }
      const response = object(prepared);
      if (typeof response.kernel !== 'string') throw Error('hash_recovery_loss_invalid');
      loss = { transactionHash: input.restoration.transactionHash, block: input.restoration.block, kernel: response.kernel,
        scope: parseRestorationScope({ request: response.request, lossHash: response.lossHash, maximumLoss: response.maximumLoss }) };
    }
    if (!saved.operation) {
      const account = await discoverHashAccount(selected.initialRoot, input.network, context);
      if (!account.deployed) {
        const deployment = await prepareAgentHashReplacementDeployment({ ...input, plan: selected }), id = accountDeploymentDigest(deployment);
        let reply = status(await request('break-deployments', deployment), id);
        while (reply.status !== 'confirmed') {
          if (reply.status === 'failed') throw Error('hash_recovery_deployment_failed');
          await wait(input.signal);
          const latest = await input.network.deployment();
          if (latest.addresses.kernel.toLowerCase() !== deployment.kernel || String(latest.revision) !== deployment.revision) break;
          reply = status(await request(`break-deployments/${id}`), id);
        }
        if (reply.status !== 'confirmed') continue;
      }
    }
    const operation = await prepareAgentHashOwnerOperation({ ...input, plan: selected, ...(loss ? { loss } : {}) });
    if (!saved.authorizationTxHash) {
      const id = recoveryOperationId(operation);
      let reply = status(await request('owner-operations/recovery', operation), id);
      while (reply.status !== 'confirmed') {
        if (reply.status === 'failed') throw Error('hash_recovery_authorization_failed');
        await wait(input.signal);
        const latest = await input.network.deployment();
        if (latest.addresses.kernel.toLowerCase() !== operation.kernel || String(latest.revision) !== operation.revision) break;
        reply = status(await request(`owner-operations/${id}`), id);
      }
      if (reply.status !== 'confirmed') continue;
      if (!reply.transactionHash) throw Error('hash_recovery_receipt_missing');
      await confirmAgentHashOwnerOperation({ ...input, plan: selected, transactionHash: reply.transactionHash });
    }
    try {
      const result = await recoverAgentHashCredentials({ ...input, plan: selected, transport: { request } });
      await submitLosses(selected);
      const scope = [loss, ...(saved.continuedLosses ?? [])].find(item => item && sameLoss(item))?.scope;
      return { ...result, ...(scope ? { restorationRequestId: scope.request } : {}) };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'hash_replacement_spending_changed') throw error;
      // The new spending key was stolen before the cut/install finished. Only
      // independent owner authority can move the existing bounded rights again.
      inherited = [loss, ...(saved.continuedLosses ?? [])].filter((value): value is AgentHashRestoration => !!value).map(value => ({ ...value, submitted: false }));
      for (const item of inherited) await requireRetainedLoss(selected.account, item);
      plan = undefined;
    }
  }
}
